//! A local HTTP API over the running app.
//!
//! It is on by default, bound to 127.0.0.1 only, and answers each request on a
//! thread of its own, so a command waiting on the window cannot hold up the
//! port. Everything Rust owns - the library, the playlists, the settings and
//! the listening record - is answered here directly. Playback and the live
//! player state live in the webview, so those are relayed over `api-command`
//! and answered once the window reports back; see `player.rs`.
//!
//! There is no token. The `Host` header is checked against the loopback names,
//! which is the one guard against a page reaching the port through DNS
//! rebinding, and no CORS headers are sent, so a browser cannot read a reply.

pub mod player;
pub mod routes;

use std::io::Cursor;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Instant;

use serde::Serialize;
use serde_json::{Map, Value, json};
use tauri::AppHandle;
use tiny_http::{Header, Request, Response, Server, StatusCode};

use crate::source::read_env;

/// The version of the endpoint list, so a caller can tell whether it is talking
/// to an API whose list it knows.
pub const API_VERSION: u32 = 1;

/// Where the API is published unless the config says otherwise. Spotify's own
/// sign-in callback already owns 45678.
pub const DEFAULT_PORT: u16 = 45679;

/// Sent to the window when the API wants the player to do something.
pub const COMMAND_EVENT: &str = "api-command";

/// Sent to the window with a `ScanSummary` after an API scan or delete.
pub const LIBRARY_EVENT: &str = "library-changed";

/// Sent to the window with the whole `PersistedState` after an API write to
/// likes, playlists or settings.
pub const STATE_EVENT: &str = "state-changed";

/// Every reply is JSON, so this is the one shape a handler can answer with.
type Reply = Response<Cursor<Vec<u8>>>;

/// The running server. The app keeps it so it can be stopped on the way out.
pub struct Api {
    server: Arc<Server>,
    /// The accept thread, kept so the exit can wait for it.
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Api {
    /// Takes the port down and waits for the accept thread to finish, the way
    /// the presence workers are stopped.
    pub fn shutdown(&self) {
        self.server.unblock();

        let thread = self
            .thread
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(thread) = thread {
            let _ = thread.join();
        }
    }
}

/// Starts the server, or says on stderr why it could not start.
///
/// Nothing in the app depends on the API, so a port that is already taken is
/// reported and then left alone: the window opens as it always did, and the
/// switch in the config is the way out.
pub fn start(app: &AppHandle) -> Option<Api> {
    let env = read_env(app);
    if !switched_on(env.api.as_deref()) {
        return None;
    }

    let port = port_of(env.api_port.as_deref());
    let address = format!("127.0.0.1:{port}");
    let server = match Server::http(&address) {
        Ok(server) => Arc::new(server),
        Err(error) => {
            eprintln!(
                "the local API is not running: {address} could not be taken ({error}). \
                 Set WAVE_API_PORT in the config to move it, or WAVE_API=0 to switch it off."
            );
            return None;
        }
    };

    let started_at = Instant::now();
    let listening = server.clone();
    let handle = app.clone();
    let thread = thread::spawn(move || accept(listening, handle, port, started_at));

    Some(Api {
        server,
        thread: Mutex::new(Some(thread)),
    })
}

/// Takes one request at a time and answers each on a thread of its own.
fn accept(server: Arc<Server>, app: AppHandle, port: u16, started_at: Instant) {
    for mut request in server.incoming_requests() {
        let app = app.clone();
        thread::spawn(move || {
            let reply = answer(&app, port, started_at, &mut request);
            let _ = request.respond(reply);
        });
    }
}

/// Reads one request and answers it.
fn answer(app: &AppHandle, port: u16, started_at: Instant, request: &mut Request) -> Reply {
    if !loopback(request) {
        return error_reply(403, "the local API only answers to 127.0.0.1 and localhost");
    }

    let method = request.method().as_str().to_string();
    let url = request.url().to_string();
    let (path, query) = match url.split_once('?') {
        Some((path, query)) => (path, query),
        None => (url.as_str(), ""),
    };

    let Some(route) = route(&method, path) else {
        return error_reply(404, format!("there is no {method} {path} endpoint"));
    };

    let mut raw = String::new();
    if let Err(error) = request.as_reader().read_to_string(&mut raw) {
        return error_reply(400, format!("the body could not be read: {error}"));
    }
    let body = match Body::parse(&raw) {
        Ok(body) => body,
        Err(failure) => return refused(failure),
    };

    let call = Call {
        app,
        port,
        started_at,
        query: Params::parse(query),
        body,
    };

    match routes::dispatch(&call, route) {
        Ok(value) => json_reply(200, &value),
        Err(failure) => refused(failure),
    }
}

/// One endpoint of the API, as `GET /api` lists it.
pub struct Endpoint {
    pub method: &'static str,
    pub path: &'static str,
    pub description: &'static str,
}

/// Every endpoint, in the order the index publishes them. The path parameters
/// are the ones a caller fills in, and nothing else is.
pub const ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        method: "GET",
        path: "/api",
        description: "this list",
    },
    Endpoint {
        method: "GET",
        path: "/api/health",
        description: "the app, the API version, the port and how long the server has been up",
    },
    Endpoint {
        method: "GET",
        path: "/api/player",
        description: "what the window is playing",
    },
    Endpoint {
        method: "GET",
        path: "/api/player/queue",
        description: "the queue in play order, each entry resolved to a song",
    },
    Endpoint {
        method: "POST",
        path: "/api/player/play",
        description: "resume, or play {trackId}, or the song a {query} finds",
    },
    Endpoint {
        method: "POST",
        path: "/api/player/pause",
        description: "pause",
    },
    Endpoint {
        method: "POST",
        path: "/api/player/toggle",
        description: "play or pause",
    },
    Endpoint {
        method: "POST",
        path: "/api/player/next",
        description: "the next song",
    },
    Endpoint {
        method: "POST",
        path: "/api/player/previous",
        description: "the song before",
    },
    Endpoint {
        method: "POST",
        path: "/api/player/stop",
        description: "stop, and go back to the start",
    },
    Endpoint {
        method: "POST",
        path: "/api/player/seek",
        description: "{positionMs}, {fraction} or {byMs}",
    },
    Endpoint {
        method: "POST",
        path: "/api/player/volume",
        description: "{volume} from 0 to 100, or {by} a step",
    },
    Endpoint {
        method: "POST",
        path: "/api/player/mute",
        description: "{muted}",
    },
    Endpoint {
        method: "POST",
        path: "/api/player/shuffle",
        description: "{on}",
    },
    Endpoint {
        method: "POST",
        path: "/api/player/repeat",
        description: "{mode}, off or all",
    },
    Endpoint {
        method: "POST",
        path: "/api/player/queue",
        description: "{trackIds, sourceId?, sourceName?, startTrackId?} replaces the queue",
    },
    Endpoint {
        method: "POST",
        path: "/api/player/queue/append",
        description: "{trackId} goes on the end",
    },
    Endpoint {
        method: "POST",
        path: "/api/player/queue/next",
        description: "{trackId} plays after the current song",
    },
    Endpoint {
        method: "DELETE",
        path: "/api/player/queue/{trackId}",
        description: "takes a song out of the queue",
    },
    Endpoint {
        method: "POST",
        path: "/api/player/collections/{id}/play",
        description: "plays a playlist, an album, an artist or Liked Songs",
    },
    Endpoint {
        method: "POST",
        path: "/api/player/collections/{id}/open",
        description: "loads a collection without starting it",
    },
    Endpoint {
        method: "GET",
        path: "/api/library",
        description: "where the library is, what it holds, and where its files are",
    },
    Endpoint {
        method: "GET",
        path: "/api/tracks",
        description: "?q=&limit=&offset=, with q matched the way wave search matches",
    },
    Endpoint {
        method: "GET",
        path: "/api/tracks/{id}",
        description: "one song",
    },
    Endpoint {
        method: "POST",
        path: "/api/library/scan",
        description: "re-reads the library folder and answers with the summary",
    },
    Endpoint {
        method: "POST",
        path: "/api/likes",
        description: "{trackIds, liked} puts songs in Liked Songs or takes them out",
    },
    Endpoint {
        method: "DELETE",
        path: "/api/tracks",
        description: "{trackIds}, with their files",
    },
    Endpoint {
        method: "GET",
        path: "/api/logs/import",
        description: "?lines=200, the path and the tail of the download log",
    },
    Endpoint {
        method: "GET",
        path: "/api/playlists",
        description: "the playlists",
    },
    Endpoint {
        method: "GET",
        path: "/api/playlists/{id}",
        description: "one playlist and its songs in play order",
    },
    Endpoint {
        method: "POST",
        path: "/api/playlists",
        description: "{name} makes a playlist",
    },
    Endpoint {
        method: "PATCH",
        path: "/api/playlists/{id}",
        description: "{name} renames a playlist",
    },
    Endpoint {
        method: "DELETE",
        path: "/api/playlists/{id}",
        description: "deletes a playlist",
    },
    Endpoint {
        method: "POST",
        path: "/api/playlists/{id}/tracks",
        description: "{trackIds} are added",
    },
    Endpoint {
        method: "DELETE",
        path: "/api/playlists/{id}/tracks",
        description: "{trackIds} are removed",
    },
    Endpoint {
        method: "PUT",
        path: "/api/playlists/{id}/tracks",
        description: "{trackIds} sets the order",
    },
    Endpoint {
        method: "GET",
        path: "/api/settings",
        description: "the settings",
    },
    Endpoint {
        method: "PATCH",
        path: "/api/settings",
        description: "a partial settings object, merged onto the current one",
    },
    Endpoint {
        method: "GET",
        path: "/api/state",
        description: "the whole persisted state",
    },
    Endpoint {
        method: "GET",
        path: "/api/tools",
        description: "what wave tools --json reports",
    },
    Endpoint {
        method: "GET",
        path: "/api/analytics/stats",
        description: "what the listening record holds",
    },
    Endpoint {
        method: "GET",
        path: "/api/analytics/top-songs",
        description: "?from=&to=&limit=",
    },
    Endpoint {
        method: "GET",
        path: "/api/analytics/swell",
        description: "?from=&to=&bucket=",
    },
    Endpoint {
        method: "GET",
        path: "/api/analytics/seeds",
        description: "?limit=",
    },
    Endpoint {
        method: "DELETE",
        path: "/api/analytics",
        description: "drops the whole listening record",
    },
];

/// Where a request is going, with whatever the path carried.
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    Index,
    Health,
    Player,
    PlayerQueue,
    PlayerPlay,
    PlayerPause,
    PlayerToggle,
    PlayerNext,
    PlayerPrevious,
    PlayerStop,
    PlayerSeek,
    PlayerVolume,
    PlayerMute,
    PlayerShuffle,
    PlayerRepeat,
    PlayerQueueReplace,
    PlayerQueueAppend,
    PlayerQueueNext,
    PlayerQueueRemove(String),
    PlayerCollectionPlay(String),
    PlayerCollectionOpen(String),
    Library,
    Tracks,
    Track(String),
    LibraryScan,
    Likes,
    TracksDelete,
    ImportLog,
    Playlists,
    Playlist(String),
    PlaylistCreate,
    PlaylistRename(String),
    PlaylistDelete(String),
    PlaylistTracksAdd(String),
    PlaylistTracksRemove(String),
    PlaylistTracksOrder(String),
    Settings,
    SettingsPatch,
    State,
    Tools,
    AnalyticsStats,
    AnalyticsTopSongs,
    AnalyticsSwell,
    AnalyticsSeeds,
    AnalyticsClear,
}

/// Works out where a request is going, or nothing when there is no such
/// endpoint.
///
/// The path is matched segment by segment, so the endpoints that carry a path
/// parameter are told apart from the fixed ones beside them, and a query string
/// is not part of the path.
pub fn route(method: &str, path: &str) -> Option<Route> {
    let path = path.split('?').next().unwrap_or(path);
    let segments: Vec<String> = path
        .trim_end_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| decode(segment, false))
        .collect();

    // Everything is under /api, which is also what keeps the port from
    // answering for anything else it might be asked.
    if segments.first().map(String::as_str) != Some("api") {
        return None;
    }
    let rest: Vec<&str> = segments[1..].iter().map(String::as_str).collect();

    Some(match (method, rest.as_slice()) {
        ("GET", []) => Route::Index,
        ("GET", ["health"]) => Route::Health,

        ("GET", ["player"]) => Route::Player,
        ("GET", ["player", "queue"]) => Route::PlayerQueue,
        ("POST", ["player", "play"]) => Route::PlayerPlay,
        ("POST", ["player", "pause"]) => Route::PlayerPause,
        ("POST", ["player", "toggle"]) => Route::PlayerToggle,
        ("POST", ["player", "next"]) => Route::PlayerNext,
        ("POST", ["player", "previous"]) => Route::PlayerPrevious,
        ("POST", ["player", "stop"]) => Route::PlayerStop,
        ("POST", ["player", "seek"]) => Route::PlayerSeek,
        ("POST", ["player", "volume"]) => Route::PlayerVolume,
        ("POST", ["player", "mute"]) => Route::PlayerMute,
        ("POST", ["player", "shuffle"]) => Route::PlayerShuffle,
        ("POST", ["player", "repeat"]) => Route::PlayerRepeat,
        ("POST", ["player", "queue"]) => Route::PlayerQueueReplace,
        ("POST", ["player", "queue", "append"]) => Route::PlayerQueueAppend,
        ("POST", ["player", "queue", "next"]) => Route::PlayerQueueNext,
        ("DELETE", ["player", "queue", track]) => Route::PlayerQueueRemove(track.to_string()),
        ("POST", ["player", "collections", id, "play"]) => {
            Route::PlayerCollectionPlay(id.to_string())
        }
        ("POST", ["player", "collections", id, "open"]) => {
            Route::PlayerCollectionOpen(id.to_string())
        }

        ("GET", ["library"]) => Route::Library,
        ("GET", ["tracks"]) => Route::Tracks,
        ("GET", ["tracks", id]) => Route::Track(id.to_string()),
        ("POST", ["library", "scan"]) => Route::LibraryScan,
        ("POST", ["likes"]) => Route::Likes,
        ("DELETE", ["tracks"]) => Route::TracksDelete,
        ("GET", ["logs", "import"]) => Route::ImportLog,

        ("GET", ["playlists"]) => Route::Playlists,
        ("GET", ["playlists", id]) => Route::Playlist(id.to_string()),
        ("POST", ["playlists"]) => Route::PlaylistCreate,
        ("PATCH", ["playlists", id]) => Route::PlaylistRename(id.to_string()),
        ("DELETE", ["playlists", id]) => Route::PlaylistDelete(id.to_string()),
        ("POST", ["playlists", id, "tracks"]) => Route::PlaylistTracksAdd(id.to_string()),
        ("DELETE", ["playlists", id, "tracks"]) => Route::PlaylistTracksRemove(id.to_string()),
        ("PUT", ["playlists", id, "tracks"]) => Route::PlaylistTracksOrder(id.to_string()),

        ("GET", ["settings"]) => Route::Settings,
        ("PATCH", ["settings"]) => Route::SettingsPatch,
        ("GET", ["state"]) => Route::State,

        ("GET", ["tools"]) => Route::Tools,
        ("GET", ["analytics", "stats"]) => Route::AnalyticsStats,
        ("GET", ["analytics", "top-songs"]) => Route::AnalyticsTopSongs,
        ("GET", ["analytics", "swell"]) => Route::AnalyticsSwell,
        ("GET", ["analytics", "seeds"]) => Route::AnalyticsSeeds,
        ("DELETE", ["analytics"]) => Route::AnalyticsClear,

        _ => return None,
    })
}

/// Percent-decodes one part of a URL. A `+` is a space in a query string and a
/// plus sign in a path, which is what a browser reads them as.
fn decode(text: &str, form: bool) -> String {
    let mut bytes: Vec<u8> = Vec::with_capacity(text.len());
    let mut rest = text.as_bytes();

    while let Some((&byte, tail)) = rest.split_first() {
        rest = tail;
        match byte {
            b'%' if rest.len() >= 2 => match std::str::from_utf8(&rest[..2])
                .ok()
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            {
                Some(value) => {
                    bytes.push(value);
                    rest = &rest[2..];
                }
                None => bytes.push(byte),
            },
            b'+' if form => bytes.push(b' '),
            _ => bytes.push(byte),
        }
    }

    String::from_utf8_lossy(&bytes).into_owned()
}

/// The `?a=b&c=d` part of a URL, read once when the request arrives.
#[derive(Debug, Default)]
pub struct Params(Vec<(String, String)>);

impl Params {
    pub fn parse(query: &str) -> Self {
        let mut pairs = Vec::new();

        for pair in query.trim_start_matches('?').split('&') {
            if pair.is_empty() {
                continue;
            }
            let (name, value) = match pair.split_once('=') {
                Some((name, value)) => (name, value),
                None => (pair, ""),
            };
            pairs.push((decode(name, true), decode(value, true)));
        }

        Self(pairs)
    }

    /// A value, or nothing when the query did not name it. A name given twice
    /// is the last one, which is what a form does.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// A number the query asked for, refused rather than guessed at.
    pub fn number(&self, name: &str) -> Result<Option<f64>, Failure> {
        let Some(value) = self.get(name) else {
            return Ok(None);
        };
        value
            .trim()
            .parse::<f64>()
            .map(Some)
            .map_err(|_| Failure::bad(format!("{name} wants a number, not {value}")))
    }

    /// A whole number the query asked for, such as a limit or an offset.
    pub fn count(&self, name: &str) -> Result<Option<usize>, Failure> {
        let Some(value) = self.get(name) else {
            return Ok(None);
        };
        value
            .trim()
            .parse::<usize>()
            .map(Some)
            .map_err(|_| Failure::bad(format!("{name} wants a whole number, not {value}")))
    }
}

/// A request body, parsed once when the request arrives.
#[derive(Debug, Default)]
pub struct Body(Option<Value>);

impl Body {
    /// Reads a body. An empty body is nothing at all, which is what a command
    /// with no fields relies on; a body that is not JSON is refused here rather
    /// than by every handler that reads a field.
    pub fn parse(raw: &str) -> Result<Self, Failure> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Ok(Self(None));
        }

        serde_json::from_str(raw)
            .map(|value| Self(Some(value)))
            .map_err(|error| Failure::bad(format!("the body is not JSON: {error}")))
    }

    /// A field, or nothing when the request did not carry it.
    fn field(&self, name: &str) -> Result<Option<&Value>, Failure> {
        match &self.0 {
            None => Ok(None),
            Some(Value::Object(fields)) => Ok(fields.get(name)),
            Some(_) => Err(Failure::bad("the body has to be a JSON object")),
        }
    }

    /// The body as an object to merge onto something, empty when the request
    /// carried no body at all. Only a body of another shape is refused.
    pub fn patch(&self) -> Result<Map<String, Value>, Failure> {
        match &self.0 {
            None => Ok(Map::new()),
            Some(Value::Object(fields)) => Ok(fields.clone()),
            Some(_) => Err(Failure::bad("the body has to be a JSON object")),
        }
    }

    pub fn string(&self, name: &str) -> Result<Option<String>, Failure> {
        match self.field(name)? {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => Ok(Some(text.clone())),
            Some(_) => Err(Failure::bad(format!("{name} has to be a string"))),
        }
    }

    /// A string that has to be there.
    pub fn required(&self, name: &str) -> Result<String, Failure> {
        self.string(name)?
            .ok_or_else(|| Failure::bad(format!("{name} is needed")))
    }

    /// A list of song ids. A single id is not a list, so it is refused rather
    /// than guessed at; an empty list is a list, and means what it says.
    pub fn required_strings(&self, name: &str) -> Result<Vec<String>, Failure> {
        match self.field(name)? {
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| match item {
                    Value::String(text) => Ok(text.clone()),
                    _ => Err(Failure::bad(format!("{name} has to be a list of song ids"))),
                })
                .collect(),
            Some(_) | None => Err(Failure::bad(format!("{name} has to be a list of song ids"))),
        }
    }

    pub fn number(&self, name: &str) -> Result<Option<f64>, Failure> {
        match self.field(name)? {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Number(number)) => Ok(number.as_f64()),
            Some(_) => Err(Failure::bad(format!("{name} has to be a number"))),
        }
    }

    pub fn flag(&self, name: &str) -> Result<Option<bool>, Failure> {
        match self.field(name)? {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Bool(flag)) => Ok(Some(*flag)),
            Some(_) => Err(Failure::bad(format!("{name} has to be true or false"))),
        }
    }

    /// A switch that has to be there.
    pub fn required_flag(&self, name: &str) -> Result<bool, Failure> {
        self.flag(name)?
            .ok_or_else(|| Failure::bad(format!("{name} is needed")))
    }
}

/// One request, with what the server knows about itself, so a handler is handed
/// one thing rather than five.
pub struct Call<'a> {
    pub app: &'a AppHandle,
    pub port: u16,
    pub started_at: Instant,
    pub query: Params,
    pub body: Body,
}

/// What a handler answers with: a value to serialise, or why it could not.
pub type Outcome = Result<Value, Failure>;

/// Why a request could not be answered. The status is what the caller sees and
/// the message is the `error` in the reply.
#[derive(Debug)]
pub struct Failure {
    pub status: u16,
    pub message: String,
}

impl Failure {
    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }

    pub fn missing(message: impl Into<String>) -> Self {
        Self::new(404, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(409, message)
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self::new(500, message)
    }

    /// The window did not answer in time, so the command was not applied.
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(503, message)
    }

    fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

/// Anything the library, the catalog, the store or the listening record reports
/// is a failure of the request as a whole rather than of what it carried.
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self::failed(message)
    }
}

impl From<serde_json::Error> for Failure {
    fn from(error: serde_json::Error) -> Self {
        Self::failed(format!("the reply could not be written: {error}"))
    }
}

/// A reply that carries JSON.
fn json_reply(status: u16, body: &impl Serialize) -> Reply {
    let text = serde_json::to_string(body)
        .unwrap_or_else(|_| "{\"error\":\"the reply could not be written\"}".to_string());
    reply(status, "application/json", text)
}

/// A failure as the API says it: `{"error": "..."}` and a status.
fn error_reply(status: u16, message: impl Into<String>) -> Reply {
    json_reply(status, &json!({ "error": message.into() }))
}

fn refused(failure: Failure) -> Reply {
    error_reply(failure.status, failure.message)
}

/// No CORS headers are added, here or anywhere else, so a browser cannot read a
/// reply even if it managed to ask for one.
fn reply(status: u16, content_type: &str, text: String) -> Reply {
    let content_type =
        Header::from_bytes("Content-Type", content_type).expect("a fixed header is always valid");

    Response::from_string(text)
        .with_status_code(StatusCode(status))
        .with_header(content_type)
}

/// True when the request named a loopback host.
///
/// This is the one guard against a page reaching the port: a browser sends the
/// name it was given, so a name that resolves here is still turned away, which
/// is exactly what DNS rebinding needs to have happened.
fn loopback(request: &Request) -> bool {
    header(request, "Host").is_some_and(loopback_host)
}

/// True when a `Host` value names the loopback interface. The port, when there
/// is one, is not part of the name.
fn loopback_host(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    let name = host.rsplit_once(':').map(|(name, _)| name).unwrap_or(&host);
    name == "127.0.0.1" || name == "localhost"
}

/// One request header, matched without regard to case.
fn header<'r>(request: &'r Request, name: &'static str) -> Option<&'r str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str())
}

/// Whether the server is switched on, from `WAVE_API`. Absent, or anything
/// other than `0` and `off`, leaves it on.
fn switched_on(value: Option<&str>) -> bool {
    match value.map(|value| value.trim().to_ascii_lowercase()) {
        Some(value) => value != "0" && value != "off",
        None => true,
    }
}

/// The port to publish on, from `WAVE_API_PORT`. Anything that is not a port
/// number, and `0` with it, leaves the default in place.
fn port_of(value: Option<&str>) -> u16 {
    value
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or(DEFAULT_PORT)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::source::Env;

    #[test]
    fn the_switch_and_the_port_are_read_out_of_the_config() {
        // The two keys as `source::read_env` hands them over, which its own
        // test reads out of the file.
        let env = Env {
            api: Some("0".to_string()),
            api_port: Some("45680".to_string()),
            ..Env::default()
        };
        assert!(!switched_on(env.api.as_deref()));
        assert_eq!(port_of(env.api_port.as_deref()), 45680);

        // Absent, or anything but `0` and `off`, leaves the API on.
        assert!(switched_on(None));
        assert!(switched_on(Some("")));
        assert!(switched_on(Some("1")));
        assert!(switched_on(Some("on")));
        assert!(switched_on(Some("yes")));
        assert!(!switched_on(Some("0")));
        assert!(!switched_on(Some("OFF")));
        assert!(!switched_on(Some(" off ")));

        // The port, and what an unusable one falls back to.
        assert_eq!(port_of(None), DEFAULT_PORT);
        assert_eq!(port_of(Some("45680")), 45680);
        assert_eq!(port_of(Some(" 45680 ")), 45680);
        assert_eq!(port_of(Some("")), DEFAULT_PORT);
        assert_eq!(port_of(Some("http")), DEFAULT_PORT);
        assert_eq!(port_of(Some("0")), DEFAULT_PORT);
        assert_eq!(port_of(Some("70000")), DEFAULT_PORT);
    }

    #[test]
    fn the_paths_with_a_parameter_are_told_apart_from_the_fixed_ones() {
        assert_eq!(route("GET", "/api/tracks"), Some(Route::Tracks));
        assert_eq!(
            route("GET", "/api/tracks/abc"),
            Some(Route::Track("abc".to_string()))
        );
        assert_eq!(route("DELETE", "/api/tracks"), Some(Route::TracksDelete));
        assert_eq!(
            route("GET", "/api/playlists/abc"),
            Some(Route::Playlist("abc".to_string()))
        );
        assert_eq!(
            route("PATCH", "/api/playlists/abc"),
            Some(Route::PlaylistRename("abc".to_string()))
        );
        assert_eq!(
            route("DELETE", "/api/playlists/abc"),
            Some(Route::PlaylistDelete("abc".to_string()))
        );
        assert_eq!(
            route("DELETE", "/api/playlists/abc/tracks"),
            Some(Route::PlaylistTracksRemove("abc".to_string()))
        );
        assert_eq!(
            route("PUT", "/api/playlists/abc/tracks"),
            Some(Route::PlaylistTracksOrder("abc".to_string()))
        );

        assert_eq!(
            route("POST", "/api/player/queue/next"),
            Some(Route::PlayerQueueNext)
        );
        assert_eq!(
            route("DELETE", "/api/player/queue/xyz"),
            Some(Route::PlayerQueueRemove("xyz".to_string()))
        );
        assert_eq!(
            route(
                "POST",
                "/api/player/collections/artist%3Athe%20beatles/play"
            ),
            Some(Route::PlayerCollectionPlay(
                "artist:the beatles".to_string()
            ))
        );

        // A query string is not part of the path, and a trailing slash is not
        // part of it either.
        assert_eq!(
            route("GET", "/api/tracks?q=duality&limit=5"),
            Some(Route::Tracks)
        );
        assert_eq!(route("GET", "/api/playlists/"), Some(Route::Playlists));

        // A method an endpoint does not take is not that endpoint, and a path
        // that is not there is nothing at all.
        assert_eq!(route("POST", "/api/tracks"), None);
        assert_eq!(route("GET", "/api/tracks/abc/extra"), None);
        assert_eq!(route("GET", "/api/nothing"), None);
        assert_eq!(route("GET", "/elsewhere"), None);
        assert_eq!(route("GET", "/"), None);
    }

    #[test]
    fn every_endpoint_in_the_index_routes() {
        for endpoint in ENDPOINTS {
            let path = endpoint
                .path
                .replace("{id}", "a-song")
                .replace("{trackId}", "a-song");

            assert!(
                route(endpoint.method, &path).is_some(),
                "{} {} has no route",
                endpoint.method,
                endpoint.path
            );
        }
    }

    #[test]
    fn the_index_lists_every_endpoint_once() {
        for (index, endpoint) in ENDPOINTS.iter().enumerate() {
            for other in &ENDPOINTS[index + 1..] {
                assert!(
                    endpoint.method != other.method || endpoint.path != other.path,
                    "{} {} is listed twice",
                    endpoint.method,
                    endpoint.path
                );
            }
        }
    }

    #[test]
    fn a_query_string_is_read_into_pairs() {
        let params = Params::parse("?q=hey%20jude&limit=5&flag&bucket=month&bucket=year");
        assert_eq!(params.get("q"), Some("hey jude"));
        assert_eq!(params.count("limit").unwrap(), Some(5));
        assert_eq!(params.number("limit").unwrap(), Some(5.0));
        assert_eq!(params.get("flag"), Some(""));
        assert_eq!(params.get("nothing"), None);
        // A name given twice is the last one, which is what a form does.
        assert_eq!(params.get("bucket"), Some("year"));

        // A `+` is a space in a query and a plus sign in a path.
        assert_eq!(Params::parse("q=hey+jude").get("q"), Some("hey jude"));
        assert_eq!(decode("a+b", false), "a+b");
        assert_eq!(
            decode("artist%3Athe%20beatles", false),
            "artist:the beatles"
        );
        assert_eq!(decode("caf%C3%A9", false), "café");

        // A number that is not one is refused rather than read as nothing.
        assert_eq!(
            Params::parse("limit=lots")
                .count("limit")
                .unwrap_err()
                .status,
            400
        );
        assert_eq!(
            Params::parse("from=soon")
                .number("from")
                .unwrap_err()
                .status,
            400
        );
    }

    #[test]
    fn a_body_is_read_as_json_or_refused() {
        let body = Body::parse(r#"{ "trackIds": ["a", "b"], "liked": true, "volume": 70 }"#)
            .expect("valid JSON");
        assert_eq!(body.required_strings("trackIds").unwrap(), vec!["a", "b"]);
        assert!(body.required_flag("liked").unwrap());
        assert_eq!(body.number("volume").unwrap(), Some(70.0));
        assert_eq!(body.string("volume").unwrap_err().status, 400);
        assert_eq!(body.required("name").unwrap_err().status, 400);
        assert_eq!(body.required_flag("shuffle").unwrap_err().status, 400);

        // An empty body is nothing at all, which is what a command with no
        // fields needs.
        let empty = Body::parse("   ").unwrap();
        assert_eq!(empty.number("volume").unwrap(), None);
        assert!(empty.patch().unwrap().is_empty());

        // A body that is not JSON, and one of the wrong shape, are refused
        // where they arrive rather than by a handler.
        let error = Body::parse("{ not json").unwrap_err();
        assert_eq!(error.status, 400);
        assert!(error.message.contains("not JSON"), "{}", error.message);

        let wrong = Body::parse("[1, 2]").unwrap();
        assert_eq!(wrong.number("volume").unwrap_err().status, 400);
        assert_eq!(wrong.patch().unwrap_err().status, 400);
    }

    #[test]
    fn only_the_loopback_names_are_answered() {
        for host in [
            "127.0.0.1",
            "127.0.0.1:45679",
            "localhost",
            "localhost:45679",
            "LOCALHOST:45679",
        ] {
            assert!(loopback_host(host), "{host} was refused");
        }

        // The name is what a rebinding page controls, so anything else goes.
        for host in [
            "",
            "evil.com",
            "evil.com:45679",
            "127.0.0.1.evil.com",
            "localhost.evil.com",
            "127.0.0.2",
            "192.168.1.5:45679",
            "[::1]:45679",
        ] {
            assert!(!loopback_host(host), "{host} was answered");
        }
    }
}
