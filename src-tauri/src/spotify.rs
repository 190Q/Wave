use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::library::{library_root, CONFIG_DIR};
use crate::state::Store;

const AUTH_URL: &str = "https://accounts.spotify.com/authorize";
const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
const API: &str = "https://api.spotify.com/v1";

/// The port the sign-in comes back on. Out of the way of anything registered,
/// and below the ephemeral range so the OS will not hand it out from under us.
/// Changing it means changing the Redirect URI on the Spotify app to match.
const REDIRECT_PORT: u16 = 45678;
const SCOPES: &str = "playlist-read-private playlist-read-collaborative";

const ENV_FILE: &str = ".env";
const TOKEN_FILE: &str = "spotify-token.json";

/// Requests run a minute early rather than risk an expiry mid-download.
const TOKEN_MARGIN_MS: u64 = 60_000;

/// The exact string the Spotify app's Redirect URIs must contain.
pub fn redirect_uri() -> String {
    format!("http://127.0.0.1:{REDIRECT_PORT}")
}

fn env_template() -> String {
    format!(
        "\
# Spotify credentials for the Import dialog.
#
# 1. Create an app at https://developer.spotify.com/dashboard
# 2. In that app, add this to Redirect URIs, exactly as written:
#
#      {}
#
#    Spotify refuses the sign-in if it does not match character for character.
# 3. Paste the app's Client ID and Client Secret below.
#
# Downloading also needs yt-dlp and ffmpeg on your PATH. Point the two
# overrides at an executable if it lives somewhere else.
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
# YTDLP_PATH=
# FFMPEG_PATH=
",
        redirect_uri()
    )
}

/// The credentials and tool overrides read from the config `.env`.
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub client_id: String,
    pub client_secret: String,
    pub yt_dlp: Option<String>,
    pub ffmpeg: Option<String>,
}

impl Env {
    fn complete(&self) -> bool {
        !self.client_id.trim().is_empty() && !self.client_secret.trim().is_empty()
    }
}

/// What the import dialog shows about the credentials and the tools.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyStatus {
    /// Where the `.env` is expected, so the user can be told.
    pub env_path: String,
    /// The Redirect URI the Spotify app has to list.
    pub redirect_uri: String,
    /// Both variables are present in the file.
    pub configured: bool,
    /// Spotify accepted the client ID and secret.
    pub accepted: bool,
    pub yt_dlp: bool,
    /// How yt-dlp was found, so the user is not left guessing where it is.
    pub yt_dlp_source: String,
    pub ffmpeg: bool,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefKind {
    Playlist,
    Track,
}

#[derive(Debug, Clone)]
pub struct SpotifyRef {
    pub kind: RefKind,
    pub id: String,
}

/// One track's metadata, the Rust side of the old script's `_normalize_item`.
#[derive(Debug, Clone, Default)]
pub struct TrackMeta {
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub album_artist: String,
    pub release_date: String,
    pub track_number: Option<u32>,
    pub track_total: Option<u32>,
    pub disc_number: Option<u32>,
    pub genres: Vec<String>,
    pub isrc: String,
    pub artist_ids: Vec<String>,
    pub cover_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    expires_at_ms: u64,
}

pub fn config_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(library_root(app)?.join(CONFIG_DIR))
}

pub fn env_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join(ENV_FILE))
}

/// Writes a commented template when the file is absent, so there is something
/// to fill in rather than a path the user has to guess at.
pub fn ensure_env_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let path = env_path(app)?;
    if !path.exists() {
        fs::write(&path, env_template())
            .map_err(|e| format!("could not write {}: {e}", path.display()))?;
    }
    Ok(path)
}

pub fn read_env<R: Runtime>(app: &AppHandle<R>) -> Env {
    let Ok(path) = env_path(app) else {
        return Env::default();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return Env::default();
    };
    parse_env(&raw)
}

fn parse_env(raw: &str) -> Env {
    let mut env = Env::default();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = unquote(value.trim());
        match key.trim() {
            "SPOTIFY_CLIENT_ID" => env.client_id = value,
            "SPOTIFY_CLIENT_SECRET" => env.client_secret = value,
            "YTDLP_PATH" => env.yt_dlp = Some(value),
            "FFMPEG_PATH" => env.ffmpeg = Some(value),
            _ => {}
        }
    }
    env
}

fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    for quote in ['"', '\''] {
        if trimmed.len() >= 2 && trimmed.starts_with(quote) && trimmed.ends_with(quote) {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

pub(crate) fn client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .user_agent("Wave/0.1")
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new())
    })
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Looks for an executable on PATH, which is where an installer puts it.
pub fn find_tool(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd"), name.to_string()]
    } else {
        vec![name.to_string()]
    };

    for dir in std::env::split_paths(&path) {
        for candidate in &names {
            let full = dir.join(candidate);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

pub(crate) fn tool_path(override_path: Option<&String>, name: &str) -> Option<PathBuf> {
    if let Some(explicit) = override_path {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            return path.is_file().then_some(path);
        }
    }
    find_tool(name)
}

/// How yt-dlp will be run.
#[derive(Debug, Clone)]
pub enum YtDlp {
    /// A `yt-dlp` executable.
    Exe(PathBuf),
    /// The interpreter holding the `yt_dlp` module. pip does install a launcher,
    /// but into a folder that is usually left off PATH.
    Python(PathBuf),
}

impl YtDlp {
    /// How it was found, for the status the dialog shows.
    pub fn describe(&self) -> String {
        match self {
            YtDlp::Exe(path) => path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "yt-dlp".to_string()),
            YtDlp::Python(python) => format!("{} -m yt_dlp", python.display()),
        }
    }
}

/// The executable if there is one, otherwise the Python module.
pub fn find_yt_dlp(override_path: Option<&String>) -> Option<YtDlp> {
    if let Some(explicit) = override_path {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            return path.is_file().then_some(YtDlp::Exe(path));
        }
    }

    if let Some(path) = find_tool("yt-dlp") {
        return Some(YtDlp::Exe(path));
    }

    python_with_module("yt_dlp").map(YtDlp::Python)
}

/// The first interpreter on PATH that can import `module`.
fn python_with_module(module: &str) -> Option<PathBuf> {
    for name in ["python", "python3", "py"] {
        let Some(python) = find_tool(name) else {
            continue;
        };

        let mut command = std::process::Command::new(&python);
        command.arg("-c").arg(format!("import {module}"));
        hide_console(&mut command);

        if command
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
        {
            return Some(python);
        }
    }
    None
}

/// Keeps a console window from flashing up for a probe or a download.
pub(crate) fn hide_console(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// Reads the config and asks Spotify whether the credentials work. Never opens
/// a browser, so it is safe to run on every `.env` save.
pub fn status<R: Runtime>(app: &AppHandle<R>) -> SpotifyStatus {
    let env = read_env(app);
    let env_path = env_path(app)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let yt_dlp = find_yt_dlp(env.yt_dlp.as_ref());
    let ffmpeg = tool_path(env.ffmpeg.as_ref(), "ffmpeg").is_some();
    let configured = env.complete();

    let mut accepted = false;
    let mut problem: Option<String> = None;

    if !configured {
        problem = Some(format!(
            "Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to {env_path}."
        ));
    } else {
        match probe(&env) {
            Ok(()) => accepted = true,
            Err(error) => problem = Some(error),
        }
    }

    if problem.is_none() {
        if yt_dlp.is_none() {
            problem = Some("yt-dlp was not found. Install it, or set YTDLP_PATH.".to_string());
        } else if !ffmpeg {
            problem = Some("ffmpeg was not found. Install it, or set FFMPEG_PATH.".to_string());
        }
    }

    SpotifyStatus {
        env_path,
        redirect_uri: redirect_uri(),
        configured,
        accepted,
        yt_dlp: yt_dlp.is_some(),
        yt_dlp_source: yt_dlp.map(|found| found.describe()).unwrap_or_default(),
        ffmpeg,
        message: problem.unwrap_or_else(|| "Spotify is set up.".to_string()),
    }
}

/// Proves the client ID and secret are a working pair, then proves the API
/// answers, so "set up" means the credentials were actually used.
fn probe(env: &Env) -> Result<(), String> {
    let token = client_credentials_token(env)?;
    let response = client()
        .get(format!("{API}/search"))
        .query(&[("q", "wave"), ("type", "track"), ("limit", "1")])
        .bearer_auth(token)
        .send()
        .map_err(|e| format!("could not reach Spotify: {e}"))?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "Spotify rejected the request ({})",
            response.status().as_u16()
        ))
    }
}

fn client_credentials_token(env: &Env) -> Result<String, String> {
    let response = client()
        .post(TOKEN_URL)
        .basic_auth(env.client_id.trim(), Some(env.client_secret.trim()))
        .form(&[("grant_type", "client_credentials")])
        .send()
        .map_err(|e| format!("could not reach Spotify: {e}"))?;

    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "Spotify refused the client ID and secret ({}): {}",
            status.as_u16(),
            error_message(&body)
        ));
    }

    serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|value| value["access_token"].as_str().map(str::to_string))
        .ok_or_else(|| "Spotify returned no access token".to_string())
}

fn error_message(body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    parsed
        .as_ref()
        .and_then(|value| value["error"]["message"].as_str().map(str::to_string))
        .or_else(|| {
            parsed
                .as_ref()
                .and_then(|value| value["error_description"].as_str().map(str::to_string))
        })
        .unwrap_or_else(|| body.chars().take(200).collect())
}

/// A token for the Web API: the cached one, a refreshed one, or a fresh
/// sign-in in the browser when there is nothing to refresh.
pub fn access_token<R: Runtime>(app: &AppHandle<R>, env: &Env) -> Result<String, String> {
    if !env.complete() {
        return Err(format!(
            "Spotify is not set up. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to {}.",
            env_path(app)
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|_| "the config .env".to_string())
        ));
    }

    if let Some(tokens) = read_tokens(app) {
        if tokens.expires_at_ms > now_ms() + TOKEN_MARGIN_MS && !tokens.access_token.is_empty() {
            return Ok(tokens.access_token);
        }
        if !tokens.refresh_token.is_empty() {
            // A revoked or stale refresh token just means signing in again.
            if let Ok(fresh) = refresh(env, &tokens.refresh_token) {
                write_tokens(app, &fresh);
                return Ok(fresh.access_token);
            }
        }
    }

    let tokens = authorize(app, env)?;
    write_tokens(app, &tokens);
    Ok(tokens.access_token)
}

fn token_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    config_dir(app).ok().map(|dir| dir.join(TOKEN_FILE))
}

fn read_tokens<R: Runtime>(app: &AppHandle<R>) -> Option<Tokens> {
    let raw = fs::read_to_string(token_path(app)?).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_tokens<R: Runtime>(app: &AppHandle<R>, tokens: &Tokens) {
    let Some(path) = token_path(app) else {
        return;
    };
    if let Ok(json) = serde_json::to_string_pretty(tokens) {
        let _ = fs::write(path, json);
    }
}

fn refresh(env: &Env, refresh_token: &str) -> Result<Tokens, String> {
    let response = client()
        .post(TOKEN_URL)
        .basic_auth(env.client_id.trim(), Some(env.client_secret.trim()))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ])
        .send()
        .map_err(|e| format!("could not reach Spotify: {e}"))?;

    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "could not refresh the Spotify sign-in ({}): {}",
            status.as_u16(),
            error_message(&body)
        ));
    }

    let value: Value =
        serde_json::from_str(&body).map_err(|e| format!("Spotify sent an odd reply: {e}"))?;
    let access_token = value["access_token"]
        .as_str()
        .ok_or_else(|| "Spotify returned no access token".to_string())?
        .to_string();
    let expires_in = value["expires_in"].as_u64().unwrap_or(3600);

    Ok(Tokens {
        access_token,
        // Spotify only sends a new refresh token when it rotates them.
        refresh_token: value["refresh_token"]
            .as_str()
            .unwrap_or(refresh_token)
            .to_string(),
        expires_at_ms: now_ms() + expires_in * 1000,
    })
}

/// The authorization-code flow: opens the browser, catches the redirect on a
/// one-shot local listener, and swaps the code for tokens.
fn authorize<R: Runtime>(app: &AppHandle<R>, env: &Env) -> Result<Tokens, String> {
    let listener = TcpListener::bind(("127.0.0.1", REDIRECT_PORT)).map_err(|e| {
        format!("could not listen on port {REDIRECT_PORT} to catch the sign-in: {e}")
    })?;

    let url = format!(
        "{AUTH_URL}?client_id={}&response_type=code&redirect_uri={}&scope={}",
        encode(env.client_id.trim()),
        encode(&redirect_uri()),
        encode(SCOPES)
    );

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("could not open the browser: {e}"))?;

    let code = wait_for_code(listener)?;
    exchange(env, &code)
}

/// Reads the single redirect the browser makes, answers it, and takes the code.
fn wait_for_code(listener: TcpListener) -> Result<String, String> {
    let (mut stream, _) = listener
        .accept()
        .map_err(|e| format!("the sign-in was interrupted: {e}"))?;

    let mut request_line = String::new();
    {
        let mut reader = BufReader::new(&stream);
        reader
            .read_line(&mut request_line)
            .map_err(|e| format!("could not read the sign-in reply: {e}"))?;
    }

    let query = request_line
        .split_whitespace()
        .nth(1)
        .and_then(|target| target.split_once('?').map(|(_, query)| query.to_string()));

    let code = query.as_deref().and_then(|query| param(query, "code"));
    let refusal = query.as_deref().and_then(|query| param(query, "error"));

    let body = if code.is_some() {
        "<h2>Wave is connected.</h2><p>You can close this tab.</p>"
    } else {
        "<h2>Wave could not finish the sign-in.</h2><p>You can close this tab.</p>"
    };
    let _ = stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    );
    let _ = stream.flush();

    match (code, refusal) {
        (Some(code), _) => Ok(code),
        (_, Some(refusal)) => Err(format!("Spotify refused the sign-in: {refusal}")),
        _ => Err("the sign-in did not come back with a code".to_string()),
    }
}

fn param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key).then(|| value.replace('+', " "))
    })
}

fn exchange(env: &Env, code: &str) -> Result<Tokens, String> {
    let response = client()
        .post(TOKEN_URL)
        .basic_auth(env.client_id.trim(), Some(env.client_secret.trim()))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri().as_str()),
        ])
        .send()
        .map_err(|e| format!("could not reach Spotify: {e}"))?;

    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "could not complete the sign-in ({}): {}",
            status.as_u16(),
            error_message(&body)
        ));
    }

    let value: Value =
        serde_json::from_str(&body).map_err(|e| format!("Spotify sent an odd reply: {e}"))?;

    Ok(Tokens {
        access_token: value["access_token"]
            .as_str()
            .ok_or_else(|| "Spotify returned no access token".to_string())?
            .to_string(),
        refresh_token: value["refresh_token"].as_str().unwrap_or_default().to_string(),
        expires_at_ms: now_ms() + value["expires_in"].as_u64().unwrap_or(3600) * 1000,
    })
}

/// Percent-encodes a value, leaving only the characters a URL can carry bare.
pub(crate) fn encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// Splits a link, a URI or a bare id into what it points at.
pub fn resolve_ref(input: &str) -> Result<SpotifyRef, String> {
    let trimmed = input.trim();

    for (needle, kind) in [("playlist", RefKind::Playlist), ("track", RefKind::Track)] {
        if let Some(at) = trimmed.find(needle) {
            let rest = &trimmed[at + needle.len()..];
            if let Some(rest) = rest.strip_prefix([':', '/']) {
                let id: String = rest.chars().take_while(char::is_ascii_alphanumeric).collect();
                if !id.is_empty() {
                    return Ok(SpotifyRef { kind, id });
                }
            }
        }
    }

    // A bare id is assumed to be a playlist, matching the old script.
    if !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Ok(SpotifyRef {
            kind: RefKind::Playlist,
            id: trimmed.to_string(),
        });
    }

    Err(format!("Could not read a Spotify link from: {input}"))
}

fn get(token: &str, url: &str) -> Result<Value, String> {
    let response = client()
        .get(url)
        .bearer_auth(token)
        .send()
        .map_err(|e| format!("could not reach Spotify: {e}"))?;

    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(refusal(status.as_u16(), &body));
    }

    serde_json::from_str(&body).map_err(|e| format!("Spotify sent an odd reply: {e}"))
}

fn refusal(status: u16, body: &str) -> String {
    match status {
        404 => "Spotify has nothing to show for that link (404). If the link is right, it is \
                almost certainly one of Spotify's own playlists, which it does not let apps read. \
                A playlist of your own will work."
            .to_string(),
        401 => "Spotify rejected the sign-in (401). Try the import again to sign in afresh."
            .to_string(),
        403 => "Spotify will not hand that over (403). It may belong to someone else, or be one \
                of its own playlists."
            .to_string(),
        _ => format!(
            "Spotify refused the request ({status}): {}",
            error_message(body)
        ),
    }
}

/// The playlist's name and every track in it, following the paging links.
pub fn playlist_tracks(token: &str, id: &str) -> Result<(String, Vec<TrackMeta>), String> {
    let meta = get(token, &format!("{API}/playlists/{id}?fields=name"))?;
    let name = meta["name"].as_str().unwrap_or("Playlist").to_string();

    let mut url = format!("{API}/playlists/{id}/items?limit=100&additional_types=track");
    let mut tracks = Vec::new();

    loop {
        let page = match get(token, &url) {
            Ok(page) => page,
            // The listing was renamed from `/tracks` to `/items`; take either.
            Err(error) if url.contains("/items") => {
                url = url.replace("/items", "/tracks");
                get(token, &url).map_err(|_| error)?
            }
            Err(error) => return Err(error),
        };

        for item in page["items"].as_array().into_iter().flatten() {
            if let Some(meta) = normalise_item(item) {
                tracks.push(meta);
            }
        }

        match page["next"].as_str() {
            Some(next) if !next.is_empty() => url = next.to_string(),
            _ => break,
        }
    }

    Ok((name, tracks))
}

pub fn single_track(token: &str, id: &str) -> Result<TrackMeta, String> {
    let track = get(token, &format!("{API}/tracks/{id}"))?;
    let wrapper = serde_json::json!({ "track": track });
    normalise_item(&wrapper).ok_or_else(|| "that Spotify track has no artist or title".to_string())
}

pub fn signed_in<R: Runtime>(app: &AppHandle<R>) -> bool {
    read_tokens(app).is_some_and(|tokens| !tokens.refresh_token.is_empty())
}

pub fn cover_url(token: &str, artist: &str, title: &str) -> Result<Option<String>, String> {
    let query = encode(&format!("artist:\"{artist}\" track:\"{title}\""));
    let found = get(token, &format!("{API}/search?q={query}&type=track&limit=1"))?;

    Ok(found["tracks"]["items"]
        .as_array()
        .and_then(|items| items.first())
        .and_then(|item| item["album"]["images"].as_array())
        .and_then(|images| images.first())
        .and_then(|image| image["url"].as_str())
        .map(str::to_string))
}

/// Genres live on the artist, not the track, so they are fetched in batches.
pub fn enrich_genres(token: &str, tracks: &mut [TrackMeta]) {
    let mut ids: Vec<String> = Vec::new();
    for track in tracks.iter() {
        for id in &track.artist_ids {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
    }

    let mut genres: Vec<(String, Vec<String>)> = Vec::new();
    for chunk in ids.chunks(50) {
        let joined = chunk.join(",");
        let Ok(value) = get(token, &format!("{API}/artists?ids={joined}")) else {
            continue;
        };
        for artist in value["artists"].as_array().into_iter().flatten() {
            let Some(id) = artist["id"].as_str() else {
                continue;
            };
            let names = artist["genres"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|genre| genre.as_str().map(str::to_string))
                .collect();
            genres.push((id.to_string(), names));
        }
    }

    for track in tracks.iter_mut() {
        let mut seen: Vec<String> = Vec::new();
        for id in &track.artist_ids {
            for (artist, names) in &genres {
                if artist == id {
                    for name in names {
                        if !seen.contains(name) {
                            seen.push(name.clone());
                        }
                    }
                }
            }
        }
        track.genres = seen;
    }
}

/// Reads a playlist item or a bare track, whichever shape the API used.
fn normalise_item(item: &Value) -> Option<TrackMeta> {
    let track = item.get("track").or_else(|| item.get("item"))?;
    if track.is_null() || track["type"].as_str() == Some("episode") {
        return None;
    }

    let artists: Vec<String> = track["artists"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|artist| artist["name"].as_str().map(str::to_string))
        .collect();
    let title = track["name"].as_str().unwrap_or_default().to_string();
    if artists.is_empty() || title.is_empty() {
        return None;
    }

    let album = track.get("album").cloned().unwrap_or(Value::Null);
    let album_artists: Vec<String> = album["artists"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|artist| artist["name"].as_str().map(str::to_string))
        .collect();

    Some(TrackMeta {
        title,
        artists,
        album: album["name"].as_str().unwrap_or_default().to_string(),
        album_artist: album_artists.join(", "),
        release_date: album["release_date"].as_str().unwrap_or_default().to_string(),
        track_number: track["track_number"].as_u64().map(|value| value as u32),
        track_total: album["total_tracks"].as_u64().map(|value| value as u32),
        disc_number: track["disc_number"].as_u64().map(|value| value as u32),
        genres: Vec::new(),
        isrc: track["external_ids"]["isrc"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        artist_ids: track["artists"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|artist| artist["id"].as_str().map(str::to_string))
            .collect(),
        cover_url: album["images"]
            .as_array()
            .and_then(|images| images.first())
            .and_then(|image| image["url"].as_str())
            .map(str::to_string),
    })
}

/// Strips what Windows refuses in a file name.
pub fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|character| {
            if r#"<>:"/\|?*"#.contains(character) || (character as u32) < 0x20 {
                '_'
            } else {
                character
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed.chars().take(150).collect()
    }
}

/// Opens the config folder, writing the template first so there is a file to edit.
#[tauri::command]
pub fn open_spotify_config(app: AppHandle) -> Result<(), String> {
    ensure_env_file(&app)?;
    let dir = config_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| format!("could not open {}: {e}", dir.display()))
}

#[tauri::command]
pub async fn spotify_status(app: AppHandle) -> Result<SpotifyStatus, String> {
    let handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        ensure_env_file(&handle)?;
        let status = status(&handle);

        // Remembered so the next launch can show it before the check comes back.
        let store = handle.state::<Store>();
        let next = store.update(|state| state.spotify = Some(status.clone()));
        let _ = crate::state::save(&handle, &next);

        Ok(status)
    })
    .await
    .map_err(|e| format!("the Spotify check stopped unexpectedly: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_link_shape() {
        for link in [
            "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
            "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc123",
            "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
        ] {
            let parsed = resolve_ref(link).unwrap();
            assert_eq!(parsed.kind, RefKind::Playlist);
            assert_eq!(parsed.id, "37i9dQZF1DXcBWIGoYBM5M");
        }

        let track = resolve_ref("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT").unwrap();
        assert_eq!(track.kind, RefKind::Track);
        assert_eq!(track.id, "4cOdK2wGLETKBW3PvgPWqT");

        // A locale in the path does not hide the kind.
        let localised = resolve_ref("https://open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT");
        assert_eq!(localised.unwrap().kind, RefKind::Track);
    }

    #[test]
    fn a_bare_id_is_a_playlist() {
        let parsed = resolve_ref("37i9dQZF1DXcBWIGoYBM5M").unwrap();
        assert_eq!(parsed.kind, RefKind::Playlist);
        assert_eq!(parsed.id, "37i9dQZF1DXcBWIGoYBM5M");
    }

    #[test]
    fn rejects_what_is_not_a_link() {
        assert!(resolve_ref("https://example.com/nothing").is_err());
        assert!(resolve_ref("   ").is_err());
    }

    #[test]
    fn sanitises_a_file_name() {
        assert_eq!(sanitize("AC/DC: Back in Black?"), "AC_DC_ Back in Black_");
        assert_eq!(sanitize("  spaced   out  "), "spaced out");
        assert_eq!(sanitize(""), "unknown");
    }

    #[test]
    fn reads_the_env_file() {
        let env = parse_env(
            "\
# a comment
SPOTIFY_CLIENT_ID=abc
SPOTIFY_CLIENT_SECRET='shh'
YTDLP_PATH=\"C:\\tools\\yt-dlp.exe\"
not a pair
",
        );

        assert_eq!(env.client_id, "abc");
        assert_eq!(env.client_secret, "shh");
        assert_eq!(env.yt_dlp.as_deref(), Some("C:\\tools\\yt-dlp.exe"));
        assert!(env.complete());
    }

    #[test]
    fn the_blocking_client_is_safe_on_a_blocking_thread() {
        let built = tauri::async_runtime::spawn_blocking(|| {
            reqwest::blocking::Client::builder().build().is_ok()
        });

        assert!(tauri::async_runtime::block_on(built).unwrap_or(false));
    }

    #[test]
    fn explains_the_refusals_that_read_like_broken_links() {
        assert!(refusal(404, "").contains("Spotify's own playlists"));
        assert!(refusal(401, "").contains("sign in"));
        assert!(refusal(403, "").contains("someone else"));
        // Anything else keeps Spotify's own words.
        assert!(refusal(500, "boom").contains("500"));
        assert!(refusal(500, "boom").contains("boom"));
    }

    #[test]
    fn the_status_survives_being_saved_and_read_back() {
        let status = SpotifyStatus {
            env_path: "C:\\library\\config\\.env".to_string(),
            redirect_uri: redirect_uri(),
            configured: true,
            accepted: true,
            yt_dlp: true,
            yt_dlp_source: "yt-dlp.exe".to_string(),
            ffmpeg: true,
            message: "Spotify is set up.".to_string(),
        };

        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"ytDlpSource\""));

        let back: SpotifyStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(back.message, "Spotify is set up.");
        assert_eq!(back.yt_dlp_source, "yt-dlp.exe");
        assert!(back.configured && back.accepted && back.yt_dlp && back.ffmpeg);
        assert_eq!(back.env_path, status.env_path);
    }

    #[test]
    fn quotes_the_redirect_uri_the_way_spotify_wants_it() {
        assert_eq!(redirect_uri(), "http://127.0.0.1:45678");
        // The template has to carry it, or the user has nothing to paste.
        assert!(env_template().contains(&redirect_uri()));
    }

    #[test]
    fn reads_a_query_parameter() {
        assert_eq!(param("code=abc-123&state=", "code").as_deref(), Some("abc-123"));
        assert_eq!(
            param("error=access_denied", "error").as_deref(),
            Some("access_denied")
        );
        assert_eq!(param("state=x", "code"), None);
    }

    #[test]
    fn reads_the_metadata_the_api_returns() {
        let item = serde_json::json!({
            "track": {
                "type": "track",
                "name": "Hey Jude",
                "artists": [{ "id": "a1", "name": "The Beatles" }],
                "track_number": 7,
                "disc_number": 1,
                "external_ids": { "isrc": "GBABC1234567" },
                "album": {
                    "name": "Past Masters",
                    "release_date": "1988-03-07",
                    "total_tracks": 33,
                    "artists": [{ "name": "The Beatles" }],
                    "images": [{ "url": "https://img/cover.jpg" }]
                }
            }
        });

        let meta = normalise_item(&item).unwrap();
        assert_eq!(meta.title, "Hey Jude");
        assert_eq!(meta.artists, vec!["The Beatles"]);
        assert_eq!(meta.album, "Past Masters");
        assert_eq!(meta.track_number, Some(7));
        assert_eq!(meta.track_total, Some(33));
        assert_eq!(meta.isrc, "GBABC1234567");
        assert_eq!(meta.cover_url.as_deref(), Some("https://img/cover.jpg"));

        // A podcast episode is skipped rather than downloaded.
        let episode = serde_json::json!({ "track": { "type": "episode", "name": "x" } });
        assert!(normalise_item(&episode).is_none());

        // A removed track leaves a null in the listing.
        let gone = serde_json::json!({ "track": null });
        assert!(normalise_item(&gone).is_none());
    }
}
