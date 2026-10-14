use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use notify::Watcher;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::download;
use crate::genre_fetch;
use crate::import::{self, ImportOutcome};
use crate::library::{self, TrackPaths, SONGS_DIR};
use crate::playlists;
use crate::progress::Reporter;
use crate::spotify::{self, RefKind, SpotifyRef, TrackMeta};
use crate::state::Store;

/// Follows one import, track by track.
pub const PROGRESS_EVENT: &str = "spotify-import";
/// Fired when the config `.env` is written, so the dialog can re-check it.
pub const CONFIG_EVENT: &str = "spotify-config-changed";

/// The watcher stops when it is dropped, so it is kept for the app's life.
static WATCHER: Mutex<Option<notify::RecommendedWatcher>> = Mutex::new(None);

/// Runs the whole import: sign in, read the playlist, download what the library
/// is missing, then hand the folder to the same importer the folder picker uses.
fn run(app: &AppHandle, url: &str, download_duplicates: bool) -> Result<ImportOutcome, String> {
    let mut report = Reporter::new(app, PROGRESS_EVENT);

    let outcome = run_inner(app, url, &mut report, download_duplicates);

    match &outcome {
        Ok(_) => report.phase("done", "Finished."),
        Err(error) => report.phase("failed", error),
    }

    outcome
}

fn run_inner(
    app: &AppHandle,
    url: &str,
    report: &mut Reporter,
    download_duplicates: bool,
) -> Result<ImportOutcome, String> {
    let tools = download::resolve_tools(&spotify::read_env(app))?;
    let Resolved {
        reference,
        name,
        tracks,
        existing,
    } = resolve(app, url, report)?;

    // The ones the library already has, unless the user asked for them again.
    let duplicates = tracks
        .iter()
        .filter(|meta| existing.contains_key(&meta_key(meta)))
        .count();
    let todo = if download_duplicates {
        tracks.len()
    } else {
        tracks.len() - duplicates
    };

    let staging = staging_dir(app, &reference.id)?;
    report.phase("downloading", &download_message(todo, duplicates));
    report.count(tracks.len());

    // What the playlist will point at, kept in the order Spotify gave.
    let mut files: Vec<String> = Vec::new();

    for (index, meta) in tracks.iter().enumerate() {
        let label = track_label(meta);
        report.at(index + 1, &label);

        if !download_duplicates {
            if let Some(path) = existing.get(&meta_key(meta)) {
                files.push(path.clone());
                report.reuse();
                continue;
            }
        }

        match download::download(&tools, meta, &staging) {
            Ok(_) => files.push(format!("{SONGS_DIR}/{}.mp3", spotify::sanitize(&meta.title))),
            Err(error) => report.fail(format!("{label}: {error}")),
        }
    }

    report.phase("importing", "Adding the songs to your library.");
    // The playlist is written here rather than by the importer, so the songs the
    // library already held can keep their place in the order.
    let mut outcome = import::import_into_library(app, &staging, false, None)?;

    if reference.kind == RefKind::Playlist {
        playlists::write(app, &name, &files)?;
        outcome.playlist = Some(name.clone());
        let store = app.state::<Store>();
        let paths = app.state::<TrackPaths>();
        outcome.state = playlists::refresh(app, &store, &paths);
    }

    // The download failures belong in the same list as the import ones.
    outcome.errors.extend(report.failures().to_vec());

    let history = if reference.kind == RefKind::Playlist {
        name.clone()
    } else {
        track_label(&tracks[0])
    };
    import::remember_import(app, "spotify", &history, &outcome);

    outcome.state = app.state::<Store>().snapshot();
    Ok(outcome)
}

fn download_message(todo: usize, duplicates: usize) -> String {
    if duplicates == 0 {
        return format!("Downloading {todo} tracks.");
    }
    format!("Downloading {todo} tracks. {duplicates} already in your library.")
}

/// The link's tracks, plus what the library already holds.
struct Resolved {
    reference: SpotifyRef,
    name: String,
    tracks: Vec<TrackMeta>,
    /// Keyed by title, artist and album; the value is the library-relative path.
    existing: HashMap<String, String>,
}

fn resolve(app: &AppHandle, url: &str, report: &mut Reporter) -> Result<Resolved, String> {
    let env = spotify::read_env(app);
    let reference = spotify::resolve_ref(url)?;

    report.phase(
        "authorising",
        "Checking your Spotify sign-in. The first one opens a browser window.",
    );
    let token = spotify::access_token(app, &env)?;

    report.phase("resolving", "Reading the playlist from Spotify.");
    let (name, mut tracks) = match reference.kind {
        RefKind::Playlist => spotify::playlist_tracks(&token, &reference.id)?,
        RefKind::Track => {
            let track = spotify::single_track(&token, &reference.id)?;
            (track_label(&track), vec![track])
        }
    };

    if tracks.is_empty() {
        return Err("that Spotify link has no tracks in it".to_string());
    }

    report.phase("genres", "Looking up the genre of each track.");
    genre_fetch::fill(Some(report), &mut tracks);

    Ok(Resolved {
        reference,
        name,
        tracks,
        existing: library_index(app),
    })
}

/// Every library track, by the three fields a duplicate is judged on.
fn library_index(app: &AppHandle) -> HashMap<String, String> {
    let paths = app.state::<TrackPaths>();
    let mut index = HashMap::new();

    for track in library::scan(app, &paths).tracks {
        let key = track_key(
            &track.title,
            track.artist.as_deref().unwrap_or_default(),
            track.album.as_deref().unwrap_or_default(),
        );
        // The first file wins, so a rescan cannot shuffle the choice.
        index.entry(key).or_insert(track.relative_path);
    }

    index
}

fn meta_key(meta: &TrackMeta) -> String {
    track_key(&meta.title, &meta.artists.join(", "), &meta.album)
}

/// Folded so case and stray spacing do not stand in for a different song.
fn track_key(title: &str, artist: &str, album: &str) -> String {
    format!("{}\u{1}{}\u{1}{}", fold(title), fold(artist), fold(album))
}

fn fold(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// What the dialog needs to ask about the duplicates before downloading.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    pub name: String,
    pub total: usize,
    pub duplicates: usize,
    /// A few of them, so the prompt can name what it found.
    pub examples: Vec<String>,
}

fn plan(app: &AppHandle, url: &str) -> Result<ImportPlan, String> {
    let mut report = Reporter::new(app, PROGRESS_EVENT);
    let resolved = resolve(app, url, &mut report)?;

    let duplicates: Vec<String> = resolved
        .tracks
        .iter()
        .filter(|meta| resolved.existing.contains_key(&meta_key(meta)))
        .map(track_label)
        .collect();

    Ok(ImportPlan {
        name: resolved.name,
        total: resolved.tracks.len(),
        duplicates: duplicates.len(),
        examples: duplicates.iter().take(3).cloned().collect(),
    })
}

/// Where the MP3s land before the importer picks them up. Kept between runs so
/// a re-import only fetches what is missing.
fn staging_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data directory: {e}"))?
        .join("spotify")
        .join(id);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn track_label(meta: &TrackMeta) -> String {
    format!("{} - {}", meta.artists.join(", "), meta.title)
}

/// Re-checks the credentials whenever the `.env` is saved.
pub fn watch_config(app: &AppHandle) {
    let Ok(dir) = spotify::config_dir(app) else {
        return;
    };
    let _ = spotify::ensure_env_file(app);

    let handle = app.clone();
    let Ok(mut watcher) = notify::recommended_watcher(
        move |result: Result<notify::Event, notify::Error>| {
            let Ok(event) = result else {
                return;
            };
            let touched = event.paths.iter().any(|path| {
                path.file_name()
                    .map(|name| name.eq_ignore_ascii_case(".env"))
                    .unwrap_or(false)
            });
            if touched {
                let _ = handle.emit(CONFIG_EVENT, ());
            }
        },
    ) else {
        return;
    };

    if watcher
        .watch(&dir, notify::RecursiveMode::NonRecursive)
        .is_err()
    {
        return;
    }

    let mut slot = WATCHER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *slot = Some(watcher);
}

#[tauri::command]
pub async fn spotify_import(
    app: AppHandle,
    url: String,
    download_duplicates: bool,
) -> Result<ImportOutcome, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || run(&handle, &url, download_duplicates))
        .await
        .map_err(|e| format!("the import stopped unexpectedly: {e}"))?
}

/// Reads the link and works out which of its tracks the library already has,
/// so the dialog can ask before downloading them again.
#[tauri::command]
pub async fn spotify_plan(app: AppHandle, url: String) -> Result<ImportPlan, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || plan(&handle, &url))
        .await
        .map_err(|e| format!("could not read the link: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_a_track_on_title_artist_and_album() {
        let meta = TrackMeta {
            title: "Hey Jude".to_string(),
            artists: vec!["The Beatles".to_string()],
            album: "Past Masters".to_string(),
            ..TrackMeta::default()
        };

        assert_eq!(meta_key(&meta), track_key("Hey Jude", "The Beatles", "Past Masters"));
        // Case and stray spacing are not a different song.
        assert_eq!(
            meta_key(&meta),
            track_key("  hey   jude ", "THE BEATLES", "past masters")
        );
        // A different album is, though.
        assert_ne!(meta_key(&meta), track_key("Hey Jude", "The Beatles", "1"));
        // And so is a different artist.
        assert_ne!(meta_key(&meta), track_key("Hey Jude", "Someone", "Past Masters"));
    }

    #[test]
    fn says_what_it_will_do_about_the_duplicates() {
        assert_eq!(download_message(40, 0), "Downloading 40 tracks.");
        assert_eq!(
            download_message(28, 12),
            "Downloading 28 tracks. 12 already in your library."
        );
    }

    #[test]
    fn labels_a_track_the_way_the_history_shows_it() {
        let meta = TrackMeta {
            title: "Hey Jude".to_string(),
            artists: vec!["The Beatles".to_string(), "Someone".to_string()],
            ..TrackMeta::default()
        };
        assert_eq!(track_label(&meta), "The Beatles, Someone - Hey Jude");
    }
}
