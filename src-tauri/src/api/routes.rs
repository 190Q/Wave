//! The handlers, one per endpoint in the list `GET /api` publishes.
//!
//! Everything the app already answers is answered here by calling the same
//! function the window's own command calls, so the API cannot drift from the
//! app: the scan, the playlist edits, the settings write, the delete, the likes
//! write, the tool report and the listening record are all the ones the front
//! end uses. Only playback is relayed to the webview, where the player lives.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use serde_json::{Value, json};
use tauri::{Emitter, Manager};

use crate::analytics::Analytics;
use crate::catalog::Catalog;
use crate::cli::songs;
use crate::library::{self, ScanSummary, Track};
use crate::state::{self, PersistedState, Playlist, Settings, Store};
use crate::tools;

use super::player::{Bridge, Command, Report};
use super::{API_VERSION, Call, ENDPOINTS, Failure, LIBRARY_EVENT, Outcome, Route, STATE_EVENT};

/// How many lines of the download log are answered when the query says nothing.
const DEFAULT_LOG_LINES: usize = 200;

/// Answers one request. Every route in the list is here, and nothing else is:
/// a path that has no handler has no route either.
pub fn dispatch(call: &Call, route: Route) -> Outcome {
    match route {
        Route::Index => Ok(index()),
        Route::Health => Ok(health(call)),

        Route::Player => player(call),
        Route::PlayerQueue => player_queue(call),
        Route::PlayerPlay => play(call),
        Route::PlayerPause => send(call, Command::new("pause")),
        Route::PlayerToggle => send(call, Command::new("toggle")),
        Route::PlayerNext => send(call, Command::new("next")),
        Route::PlayerPrevious => send(call, Command::new("previous")),
        Route::PlayerStop => send(call, Command::new("stop")),
        Route::PlayerSeek => seek(call),
        Route::PlayerVolume => volume(call),
        Route::PlayerMute => mute(call),
        Route::PlayerShuffle => shuffle(call),
        Route::PlayerRepeat => repeat(call),
        Route::PlayerQueueReplace => replace_queue(call),
        Route::PlayerQueueAppend => queue_append(call),
        Route::PlayerQueueNext => queue_next(call),
        Route::PlayerQueueRemove(track_id) => queue_remove(call, &track_id),
        Route::PlayerCollectionPlay(id) => play_collection(call, &id, "playCollection"),
        Route::PlayerCollectionOpen(id) => play_collection(call, &id, "openCollection"),

        Route::Library => library_info(call),
        Route::Tracks => tracks(call),
        Route::Track(id) => track(call, &id),
        Route::LibraryScan => scan(call),
        Route::Likes => likes(call),
        Route::TracksDelete => delete_tracks(call),
        Route::ImportLog => import_log(call),

        Route::Playlists => all_playlists(call),
        Route::Playlist(id) => playlist(call, &id),
        Route::PlaylistCreate => create_playlist(call),
        Route::PlaylistRename(id) => rename_playlist(call, &id),
        Route::PlaylistDelete(id) => delete_playlist(call, &id),
        Route::PlaylistTracksAdd(id) => add_tracks(call, &id),
        Route::PlaylistTracksRemove(id) => remove_tracks(call, &id),
        Route::PlaylistTracksOrder(id) => order_tracks(call, &id),

        Route::Settings => settings(call),
        Route::SettingsPatch => patch_settings(call),
        Route::State => persisted_state(call),

        Route::Tools => tool_status(call),
        Route::AnalyticsStats => analytics_stats(call),
        Route::AnalyticsTopSongs => analytics_top_songs(call),
        Route::AnalyticsSwell => analytics_swell(call),
        Route::AnalyticsSeeds => analytics_seeds(call),
        Route::AnalyticsClear => analytics_clear(call),
    }
}

/// The endpoint list itself, which is what makes the API document itself.
fn index() -> Value {
    Value::Array(
        ENDPOINTS
            .iter()
            .map(|endpoint| {
                json!({
                    "method": endpoint.method,
                    "path": endpoint.path,
                    "description": endpoint.description,
                })
            })
            .collect(),
    )
}

fn health(call: &Call) -> Value {
    json!({
        "name": call.app.config().product_name.clone().unwrap_or_else(|| "Wave".to_string()),
        "version": call.app.package_info().version.to_string(),
        "api": API_VERSION,
        "port": call.port,
        "uptimeMs": call.started_at.elapsed().as_millis() as u64,
    })
}

/// What the window is playing, as the last report describes it.
fn player(call: &Call) -> Outcome {
    let report = call.app.state::<Bridge>().snapshot();
    Ok(player_json(call, report.as_ref()))
}

/// The player as the API says it. `ready` is false until the window has
/// reported at all, which is what says the API can drive it; the queue is the
/// play order, and `/api/player/queue` is what resolves it to songs.
fn player_json(call: &Call, report: Option<&Report>) -> Value {
    let Some(report) = report else {
        return json!({
            "ready": false,
            "track": Value::Null,
            "sourceId": Value::Null,
            "sourceName": "",
            "queue": [],
            "positionMs": 0,
            "durationMs": 0,
            "playing": false,
            "shuffle": false,
            "repeat": "off",
            "volume": 0,
            "muted": false,
        });
    };

    json!({
        "ready": true,
        "track": track_of(call, report.current_id.as_deref()),
        "sourceId": report.source_id,
        "sourceName": report.source_name,
        "queue": report.order.clone().unwrap_or_default(),
        "positionMs": report.position_ms,
        "durationMs": report.duration_ms,
        "playing": report.playing,
        "shuffle": report.shuffle,
        "repeat": report.repeat,
        "volume": report.volume,
        "muted": report.muted,
    })
}

/// The queue in play order, each entry resolved to a song, with the one that is
/// playing marked.
fn player_queue(call: &Call) -> Outcome {
    let report = call.app.state::<Bridge>().snapshot();
    let Some(report) = report else {
        return Ok(json!([]));
    };

    let order = report.order.clone().unwrap_or_default();
    let tracks = tracks_of(call, &order);

    let entries: Vec<Value> = order
        .iter()
        .enumerate()
        .map(|(index, id)| {
            json!({
                "id": id,
                "current": index == report.cursor,
                "track": tracks.get(id),
            })
        })
        .collect();

    Ok(Value::Array(entries))
}

/// Hands a command to the window and answers with the player as it stands once
/// the window has applied it, so a caller is told what is playing rather than
/// that the command was taken. A window that does not answer is a 503 rather
/// than a hang.
fn send(call: &Call, command: Command) -> Outcome {
    let bridge = call.app.state::<Bridge>();
    match bridge.send(call.app, command) {
        Ok(report) => Ok(player_json(call, Some(&report))),
        Err(message) => Err(Failure::unavailable(message)),
    }
}

fn play(call: &Call) -> Outcome {
    if let Some(track_id) = call.body.string("trackId")? {
        return send(call, Command::new("playTrack").track(&track_id));
    }

    if let Some(query) = call.body.string("query")? {
        // Matched exactly as `wave search` matches, so a query that names one
        // song plays that song. A query that names several plays the first,
        // which is the one the search ranks first.
        let all = songs::all(call.app)?;
        let found = songs::matching(&all, &query);
        let Some(track) = found.first() else {
            return Err(Failure::missing(format!(
                "nothing in the library answers to {query}"
            )));
        };
        return send(call, Command::new("playTrack").track(&track.id));
    }

    send(call, Command::new("play"))
}

fn seek(call: &Call) -> Outcome {
    if let Some(position) = call.body.number("positionMs")? {
        return send(call, Command::new("seek").value(position.max(0.0)));
    }

    if let Some(fraction) = call.body.number("fraction")? {
        // A fraction is a fraction of the song, and only the window has said
        // how long that is.
        let report = call.app.state::<Bridge>().snapshot();
        let Some(report) = report else {
            return Err(Failure::conflict(
                "the window has not said how long the song is yet, so a fraction means nothing",
            ));
        };
        return send(
            call,
            Command::new("seek").value(report.duration_ms * fraction.clamp(0.0, 1.0)),
        );
    }

    if let Some(by) = call.body.number("byMs")? {
        return send(call, Command::new("seekBy").value(by));
    }

    Err(Failure::bad("seek wants positionMs, fraction or byMs"))
}

fn volume(call: &Call) -> Outcome {
    let level = if let Some(level) = call.body.number("volume")? {
        level
    } else if let Some(by) = call.body.number("by")? {
        // A step is a step from where the player is, which the window has said
        // unless it has not reported yet; the saved setting is the next best.
        let current = call
            .app
            .state::<Bridge>()
            .snapshot()
            .map(|report| report.volume)
            .unwrap_or_else(|| f64::from(call.app.state::<Store>().snapshot().settings.volume));
        current + by
    } else {
        return Err(Failure::bad("volume wants volume or by"));
    };

    // The player holds 0 to 100, and a step that runs off either end stops there.
    send(call, Command::new("volume").value(level.clamp(0.0, 100.0)))
}

fn mute(call: &Call) -> Outcome {
    let muted = call.body.required_flag("muted")?;
    send(call, Command::new("mute").flag(muted))
}

fn shuffle(call: &Call) -> Outcome {
    let on = call.body.required_flag("on")?;
    send(call, Command::new("shuffle").flag(on))
}

fn repeat(call: &Call) -> Outcome {
    let mode = call.body.required("mode")?;
    if mode != "off" && mode != "all" {
        return Err(Failure::bad(format!("repeat is off or all, not {mode}")));
    }
    send(call, Command::new("repeat").text(&mode))
}

fn replace_queue(call: &Call) -> Outcome {
    let track_ids = call.body.required_strings("trackIds")?;
    let source_id = call.body.string("sourceId")?;
    let source_name = call.body.string("sourceName")?;
    let start_track_id = call.body.string("startTrackId")?;

    send(
        call,
        Command::new("queue")
            .tracks(track_ids)
            .source(source_id, source_name)
            .start(start_track_id),
    )
}

fn queue_append(call: &Call) -> Outcome {
    let track_id = call.body.required("trackId")?;
    send(call, Command::new("queueAppend").track(&track_id))
}

fn queue_next(call: &Call) -> Outcome {
    let track_id = call.body.required("trackId")?;
    send(call, Command::new("queueNext").track(&track_id))
}

fn queue_remove(call: &Call, track_id: &str) -> Outcome {
    send(call, Command::new("queueRemove").track(track_id))
}

/// A collection is the window's own idea of a playlist, an album, an artist or
/// Liked Songs, and it knows the name of one from its id, so the id is passed on
/// as it is and the name is left to it.
fn play_collection(call: &Call, id: &str, action: &str) -> Outcome {
    send(
        call,
        Command::new(action).source(Some(id.to_string()), None),
    )
}

fn library_info(call: &Call) -> Outcome {
    let root = library::library_root(call.app)?;
    let catalog = call.app.state::<Catalog>();
    let (songs, missing) = catalog.counts();

    Ok(json!({
        "root": root.to_string_lossy(),
        "songs": songs,
        "missing": missing,
        "databaseBytes": catalog.file_size(),
        "state": path_text(state::state_file(call.app)),
        "config": path_text(crate::source::env_path(call.app)),
        "log": crate::download_log::import_log_path(call.app.clone()).unwrap_or_default(),
    }))
}

fn tracks(call: &Call) -> Outcome {
    let query = call.query.get("q").unwrap_or_default();
    let offset = call.query.count("offset")?.unwrap_or(0);
    let limit = call.query.count("limit")?.unwrap_or(usize::MAX);

    if query.trim().is_empty() {
        let catalog = call.app.state::<Catalog>();
        let total = catalog.present_count()?;
        let rows = catalog.tracks_page(offset, limit)?;
        let root = library::library_root(call.app)?;
        let page: Vec<Track> = rows.iter().map(|row| library::to_track(row, &root)).collect();
        return Ok(json!({ "total": total, "tracks": page }));
    }

    let all = songs::all(call.app)?;
    let found = songs::matching(&all, query);
    let total = found.len();
    let page: Vec<&Track> = found.into_iter().skip(offset).take(limit).collect();

    Ok(json!({ "total": total, "tracks": page }))
}

fn track(call: &Call, id: &str) -> Outcome {
    match track_of(call, Some(id)) {
        Some(found) => Ok(serde_json::to_value(found)?),
        None => Err(Failure::missing(format!("there is no song {id}"))),
    }
}

fn scan(call: &Call) -> Outcome {
    let summary = library::scan_library(
        call.app.clone(),
        call.app.state::<Store>(),
        call.app.state::<Catalog>(),
        true,
    );

    // The window applies this exactly as if it had scanned itself, so the two
    // never disagree about what the library holds.
    let _ = call.app.emit(LIBRARY_EVENT, &summary);
    Ok(serde_json::to_value(summary)?)
}

fn likes(call: &Call) -> Outcome {
    let track_ids = call.body.required_strings("trackIds")?;
    let liked = call.body.required_flag("liked")?;

    let next = state::set_likes(
        call.app.clone(),
        call.app.state::<Store>(),
        track_ids,
        liked,
    )?;
    announce_state(call, &next);
    Ok(serde_json::to_value(next)?)
}

fn delete_tracks(call: &Call) -> Outcome {
    let track_ids = call.body.required_strings("trackIds")?;

    let next = library::delete(
        call.app,
        &call.app.state::<Catalog>(),
        &call.app.state::<Store>(),
        &track_ids,
    )?;

    announce_state(call, &next);
    announce_library(call, &track_ids);
    Ok(serde_json::to_value(next)?)
}

fn import_log(call: &Call) -> Outcome {
    let path = crate::download_log::import_log_path(call.app.clone()).unwrap_or_default();
    let wanted = call.query.count("lines")?.unwrap_or(DEFAULT_LOG_LINES);

    let tail = tail_lines(std::path::Path::new(&path), wanted);

    Ok(json!({ "path": path, "tail": tail }))
}

/// The last `wanted` lines of a file, read from the end, so a long log is not
/// loaded whole to answer for its tail.
fn tail_lines(path: &std::path::Path, wanted: usize) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};

    const CHUNK: u64 = 64 * 1024;

    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let Ok(size) = file.metadata().map(|meta| meta.len()) else {
        return Vec::new();
    };

    let mut buffer: Vec<u8> = Vec::new();
    let mut at = size;
    while at > 0 {
        let step = CHUNK.min(at);
        at -= step;
        let mut block = vec![0u8; step as usize];
        if file.seek(SeekFrom::Start(at)).is_err() || file.read_exact(&mut block).is_err() {
            break;
        }
        block.extend_from_slice(&buffer);
        buffer = block;
        if buffer.iter().filter(|byte| **byte == b'\n').count() > wanted {
            break;
        }
    }

    let text = String::from_utf8_lossy(&buffer);
    let mut lines: Vec<&str> = text.lines().collect();
    // A read that started mid-file can begin in the middle of a line.
    if at > 0 && !lines.is_empty() {
        lines.remove(0);
    }

    lines[lines.len().saturating_sub(wanted)..]
        .iter()
        .map(|line| line.to_string())
        .collect()
}

fn all_playlists(call: &Call) -> Outcome {
    let playlists = call.app.state::<Catalog>().playlists()?;
    Ok(serde_json::to_value(playlists)?)
}

fn playlist(call: &Call, id: &str) -> Outcome {
    let found = playlist_of(call, id)?;

    let tracks = tracks_of(call, &found.entries);
    let waiting: HashSet<&str> = found
        .pending
        .iter()
        .map(|entry| entry.id.as_str())
        .collect();

    // In play order, with the songs the library is still waiting on marked.
    let entries: Vec<Value> = found
        .entries
        .iter()
        .map(|entry| {
            json!({
                "id": entry,
                "pending": waiting.contains(entry.as_str()),
                "track": tracks.get(entry),
            })
        })
        .collect();

    Ok(json!({ "playlist": found, "entries": entries }))
}

fn create_playlist(call: &Call) -> Outcome {
    let name = wanted_name(call)?;
    if call.app.state::<Catalog>().playlist_name_taken(&name, None) {
        return Err(Failure::conflict(format!(
            "a playlist called {name} already exists"
        )));
    }

    let next = crate::playlists::create_playlist(
        call.app.clone(),
        call.app.state::<Store>(),
        call.app.state::<Catalog>(),
        name,
    )?;

    announce_state(call, &next);
    Ok(serde_json::to_value(next)?)
}

fn rename_playlist(call: &Call, id: &str) -> Outcome {
    let name = wanted_name(call)?;
    playlist_of(call, id)?;
    if call
        .app
        .state::<Catalog>()
        .playlist_name_taken(&name, Some(id))
    {
        return Err(Failure::conflict(format!(
            "a playlist called {name} already exists"
        )));
    }

    let next = crate::playlists::rename_playlist(
        call.app.clone(),
        call.app.state::<Store>(),
        call.app.state::<Catalog>(),
        id.to_string(),
        name,
    )?;

    announce_state(call, &next);
    Ok(serde_json::to_value(next)?)
}

fn delete_playlist(call: &Call, id: &str) -> Outcome {
    // A playlist that is not there is a 404 rather than a write that quietly
    // changed nothing.
    playlist_of(call, id)?;

    let next = crate::playlists::delete_playlist(
        call.app.clone(),
        call.app.state::<Store>(),
        call.app.state::<Catalog>(),
        id.to_string(),
    )?;

    announce_state(call, &next);
    Ok(serde_json::to_value(next)?)
}

fn add_tracks(call: &Call, id: &str) -> Outcome {
    let track_ids = call.body.required_strings("trackIds")?;
    playlist_of(call, id)?;

    let next = crate::playlists::add_to_playlist(
        call.app.clone(),
        call.app.state::<Store>(),
        call.app.state::<Catalog>(),
        id.to_string(),
        track_ids,
    )?;

    announce_state(call, &next);
    Ok(serde_json::to_value(next)?)
}

fn remove_tracks(call: &Call, id: &str) -> Outcome {
    let track_ids = call.body.required_strings("trackIds")?;
    playlist_of(call, id)?;

    let next = crate::playlists::remove_from_playlist(
        call.app.clone(),
        call.app.state::<Store>(),
        call.app.state::<Catalog>(),
        id.to_string(),
        track_ids,
    )?;

    announce_state(call, &next);
    Ok(serde_json::to_value(next)?)
}

/// Sets the order a playlist plays in, which is the whole list rather than the
/// entries that changed.
fn order_tracks(call: &Call, id: &str) -> Outcome {
    let track_ids = call.body.required_strings("trackIds")?;
    playlist_of(call, id)?;

    let next = crate::playlists::reorder_playlist(
        call.app.clone(),
        call.app.state::<Store>(),
        call.app.state::<Catalog>(),
        id.to_string(),
        track_ids,
    )?;

    announce_state(call, &next);
    Ok(serde_json::to_value(next)?)
}

/// The name a playlist is being given, which the two writes that take one share.
fn wanted_name(call: &Call) -> Result<String, Failure> {
    let name = call.body.required("name")?.trim().to_string();
    if name.is_empty() {
        return Err(Failure::bad("a playlist needs a name"));
    }
    Ok(name)
}

/// One playlist, or a 404 when the library has no such playlist.
fn playlist_of(call: &Call, id: &str) -> Result<Playlist, Failure> {
    let playlists = call.app.state::<Catalog>().playlists()?;
    playlists
        .into_iter()
        .find(|playlist| playlist.id == id)
        .ok_or_else(|| Failure::missing(format!("there is no playlist {id}")))
}

fn settings(call: &Call) -> Outcome {
    Ok(serde_json::to_value(
        call.app.state::<Store>().snapshot().settings,
    )?)
}

fn patch_settings(call: &Call) -> Outcome {
    let patch = call.body.patch()?;
    let current = call.app.state::<Store>().snapshot().settings;

    // Merged field by field onto the settings as they stand, so a patch only
    // has to carry what it changes.
    let mut merged = serde_json::to_value(&current)?;
    let Some(fields) = merged.as_object_mut() else {
        return Err(Failure::failed("the settings could not be read"));
    };
    for (name, value) in patch {
        if fields.contains_key(&name) {
            fields.insert(name, value);
        } else {
            return Err(Failure::bad(format!("there is no {name} setting")));
        }
    }

    let settings: Settings = serde_json::from_value(merged)
        .map_err(|error| Failure::bad(format!("the settings could not be read: {error}")))?;
    let next = state::set_settings(call.app.clone(), call.app.state::<Store>(), settings)?;

    // The window follows a setting from its own event, and the agreed contract
    // also says a write to settings announces the whole state, so both are sent.
    let _ = call.app.emit(state::SETTINGS_EVENT, &next.settings);
    announce_state(call, &next);
    Ok(serde_json::to_value(next)?)
}

fn persisted_state(call: &Call) -> Outcome {
    let state = state::get_state(call.app.clone(), call.app.state::<Store>());
    Ok(serde_json::to_value(state)?)
}

fn tool_status(call: &Call) -> Outcome {
    let env = crate::source::read_env(call.app);
    let bundled = tools::bundled_dir(call.app);
    let found = tools::status(&env, bundled.as_deref());

    // The same report `wave tools --json` writes, so the two agree.
    Ok(json!({
        "ytDlp": found.yt_dlp,
        "ytDlpSource": found.yt_dlp_source,
        "ffmpeg": found.ffmpeg,
        "deno": found.deno,
        "denoSource": found.deno_source,
        "spotify": env.complete(),
        "config": path_text(crate::source::env_path(call.app)),
        "problem": found.problem(),
    }))
}

fn analytics_stats(call: &Call) -> Outcome {
    let stats = crate::analytics::analytics_stats(call.app.state::<Analytics>())?;
    Ok(serde_json::to_value(stats)?)
}

fn analytics_top_songs(call: &Call) -> Outcome {
    let (from, to) = window(call)?;
    let limit = call.query.count("limit")?;
    let songs =
        crate::analytics::analytics_top_songs(call.app.state::<Analytics>(), from, to, limit)?;
    Ok(serde_json::to_value(songs)?)
}

fn analytics_swell(call: &Call) -> Outcome {
    let (from, to) = window(call)?;
    let bucket = call.query.get("bucket").unwrap_or("month").to_string();
    let swell = crate::analytics::analytics_swell(call.app.state::<Analytics>(), from, to, bucket)?;
    Ok(serde_json::to_value(swell)?)
}

fn analytics_seeds(call: &Call) -> Outcome {
    let limit = call.query.count("limit")?;
    let seeds =
        crate::analytics::analytics_recommendation_seeds(call.app.state::<Analytics>(), limit)?;
    Ok(serde_json::to_value(seeds)?)
}

fn analytics_clear(call: &Call) -> Outcome {
    crate::analytics::analytics_clear(call.app.state::<Analytics>())?;
    Ok(json!({ "cleared": true }))
}

/// The window a query asked for. Nothing said is everything up to now, which is
/// the same window the front end's own "all time" pane asks for.
fn window(call: &Call) -> Result<(i64, i64), Failure> {
    let from = call.query.number("from")?.unwrap_or(0.0);
    let to = call
        .query
        .number("to")?
        .unwrap_or(crate::source::now_ms() as f64 + 1.0);
    Ok((from as i64, to as i64))
}

/// One song, resolved through the catalog and the library root, or nothing when
/// the library does not hold it.
fn track_of(call: &Call, id: Option<&str>) -> Option<Track> {
    let id = id?;
    let root = library::library_root(call.app).ok()?;
    let catalog = call.app.state::<Catalog>();
    let row = catalog.track(id).ok().flatten()?;
    Some(library::to_track(&row, &root))
}

/// The songs for a set of ids, resolved in a few queries rather than one each.
fn tracks_of(call: &Call, ids: &[String]) -> HashMap<String, Track> {
    let Ok(root) = library::library_root(call.app) else {
        return HashMap::new();
    };
    let catalog = call.app.state::<Catalog>();
    let Ok(rows) = catalog.tracks_by_ids(ids) else {
        return HashMap::new();
    };

    rows.values()
        .map(|row| (row.id.clone(), library::to_track(row, &root)))
        .collect()
}

/// Tells the window about a change it did not make, so it follows along rather
/// than showing something that is no longer true.
fn announce_state(call: &Call, state: &PersistedState) {
    let _ = call.app.emit(STATE_EVENT, state);
}

/// Tells the window what the library holds now, in the shape a scan returns.
///
/// Only the songs that went are named: everything else is where the window
/// already has it, so the whole library does not have to cross the wire.
fn announce_library(call: &Call, removed: &[String]) {
    let Ok(root) = library::library_root(call.app) else {
        return;
    };
    let (total, _) = call.app.state::<Catalog>().counts();

    let summary = ScanSummary {
        changed: Vec::new(),
        removed: removed.to_vec(),
        total,
        root: root.to_string_lossy().into_owned(),
        skipped: 0,
        errors: Vec::new(),
    };
    let _ = call.app.emit(LIBRARY_EVENT, &summary);
}

/// A path as the API says it, empty when it cannot be placed.
fn path_text(path: Result<PathBuf, String>) -> String {
    path.map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default()
}
