use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::catalog::Catalog;
use crate::download;
use crate::import::{self, ImportOutcome};
use crate::import_source::{self, PROGRESS_EVENT};
use crate::library;
use crate::playlists;
use crate::progress::Reporter;
use crate::source::read_env;
use crate::state::{PendingTrack, PersistedState, Store};

/// Where the downloads wait while they are being fetched, so nothing lands in
/// the library until it is known what it is.
const STAGING: &str = "playlist";

pub fn run(
    app: &AppHandle,
    playlist_id: &str,
    entry_ids: &[String],
) -> Result<ImportOutcome, String> {
    let mut report = Reporter::new(app, PROGRESS_EVENT);
    let outcome = run_inner(app, playlist_id, entry_ids, &mut report);

    match &outcome {
        Ok(_) => report.phase("done", "Finished."),
        Err(error) => report.phase("failed", error),
    }

    outcome
}

fn run_inner(
    app: &AppHandle,
    playlist_id: &str,
    entry_ids: &[String],
    report: &mut Reporter,
) -> Result<ImportOutcome, String> {
    let catalog = app.state::<Catalog>();
    let store = app.state::<Store>();

    let entries = catalog.playlist_entries(playlist_id)?;
    let waiting = catalog.pending_tracks(playlist_id)?;

    // An empty list means every song the playlist is waiting on.
    let chosen: Vec<PendingTrack> = waiting
        .iter()
        .filter(|track| entry_ids.is_empty() || entry_ids.contains(&track.id))
        .filter(|track| entries.contains(&track.id))
        .cloned()
        .collect();
    if chosen.is_empty() {
        return Err("nothing in that playlist is waiting to be downloaded".to_string());
    }

    let name = playlist_name(&catalog, playlist_id);
    let tools = download::resolve_tools(&read_env(app))?;
    let known = import_source::catalog_index(&catalog)?;
    let staging = staging_dir(app, playlist_id)?;

    report.phase("downloading", &download_message(chosen.len()));
    report.count(chosen.len());

    // The waiting id -> the library track it became.
    let mut landed: HashMap<String, String> = HashMap::new();
    // Staged folders, so the import can say which file became which song.
    let mut fetched: Vec<(usize, String)> = Vec::new();

    for (index, track) in chosen.iter().enumerate() {
        let meta = track.meta();
        let label = import_source::track_label(&meta);

        // A song the library already holds is used as it stands.
        if let Some(id) = import_source::held(&known, &meta) {
            landed.insert(track.id.clone(), id.clone());
            report.reuse(&label);
            continue;
        }

        report.at(index + 1, &label);
        let cover = track.cover_path.as_deref().map(Path::new);
        match download::download(&tools, &meta, &staging.join(index.to_string()), cover) {
            Ok(_) => fetched.push((index, track.id.clone())),
            Err(error) => report.fail(format!("{label}: {error}")),
        }
    }

    let mut outcome = ImportOutcome {
        songs: 0,
        images: 0,
        lyrics: 0,
        skipped: 0,
        duplicates: 0,
        similar: 0,
        playlist: Some(playlist_id.to_string()),
        errors: Vec::new(),
        state: PersistedState::default(),
    };

    if !fetched.is_empty() {
        report.phase("importing", "Adding the songs to your library.");
        let imported = import::import_into_library(app, &staging, false, None)?;
        outcome = imported.outcome;
        outcome.playlist = Some(playlist_id.to_string());

        for (index, pending_id) in &fetched {
            let source = format!("{index}/{}.mp3", library::AUDIO_STEM);
            if let Some(track_id) = imported.by_source.get(&source) {
                landed.insert(pending_id.clone(), track_id.clone());
            }
        }
    }

    // A song that would not download keeps its place, so it stays waiting.
    let next = rewritten(&entries, &landed);
    let done: Vec<String> = landed.keys().cloned().collect();
    if !done.is_empty() {
        catalog.resolve_pending(playlist_id, &next, &done)?;
    }

    outcome.errors.extend(report.failures().to_vec());
    import::remember_import(app, "playlist", &name, &outcome);
    outcome.state = playlists::refresh(app, &store);

    Ok(outcome)
}

/// The playlist's entries with every download in the place its waiting song
/// held.
fn rewritten(entries: &[String], landed: &HashMap<String, String>) -> Vec<String> {
    entries
        .iter()
        .map(|entry| landed.get(entry).cloned().unwrap_or_else(|| entry.clone()))
        .collect()
}

fn playlist_name(catalog: &Catalog, id: &str) -> String {
    catalog
        .playlists()
        .ok()
        .and_then(|lists| {
            lists
                .into_iter()
                .find(|list| list.id == id)
                .map(|list| list.name)
        })
        .unwrap_or_else(|| "Generated playlist".to_string())
}

fn download_message(total: usize) -> String {
    if total == 1 {
        return "Downloading 1 song.".to_string();
    }
    format!("Downloading {total} songs.")
}

fn staging_dir(app: &AppHandle, playlist_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data directory: {e}"))?
        .join(STAGING)
        .join(playlist_id);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

#[tauri::command]
pub async fn download_playlist(
    app: AppHandle,
    playlist_id: String,
    entry_ids: Vec<String>,
) -> Result<ImportOutcome, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || run(&handle, &playlist_id, &entry_ids))
        .await
        .map_err(|e| format!("the download stopped unexpectedly: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_how_many_songs_it_is_fetching() {
        assert_eq!(download_message(1), "Downloading 1 song.");
        assert_eq!(download_message(7), "Downloading 7 songs.");
    }

    #[test]
    fn a_download_takes_the_place_its_waiting_song_held() {
        let entries = vec![
            "one".to_string(),
            "waiting-a".to_string(),
            "waiting-b".to_string(),
        ];
        // Only the first waiting song landed, so the other keeps its place.
        let landed = HashMap::from([("waiting-a".to_string(), "two".to_string())]);

        assert_eq!(
            rewritten(&entries, &landed),
            vec!["one".to_string(), "two".to_string(), "waiting-b".to_string()]
        );
    }
}
