use std::collections::HashMap;
#[cfg(any(target_os = "android", test))]
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::catalog::Catalog;
use crate::download;
use crate::download_log;
use crate::import::{self, ImportOutcome};
use crate::import_source::{self, PROGRESS_EVENT};
use crate::progress::{Output, Reporter};
use crate::source::{read_env, TrackMeta};
use crate::state::{PendingTrack, PersistedState, Store};
use crate::tools;

/// Where the downloads wait while they are being fetched, so nothing lands in
/// the library until it is known what it is.
const STAGING: &str = "playlist";

struct Wanted {
    place: usize,
    id: String,
    meta: TrackMeta,
    cover: Option<PathBuf>,
}

pub fn run(
    app: &AppHandle,
    playlist_id: &str,
    entry_ids: &[String],
    output: Output,
) -> Result<ImportOutcome, String> {
    let mut report = Reporter::new(app, PROGRESS_EVENT, output);
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
    download_log::begin(app, "playlist");
    let bundled = tools::bundled_dir(app);
    let tools = download::resolve_tools(&read_env(app), bundled.as_deref())?;
    if let Some(log) = &tools.log {
        log.link(&name, chosen.len());
    }
    let known = import_source::catalog_index(&catalog)?;
    let staging = staging_dir(app, playlist_id)?;

    // The waiting id -> the library track it became.
    let mut landed: HashMap<String, String> = HashMap::new();

    let mut wanted: Vec<Wanted> = Vec::new();
    let mut reused: Vec<String> = Vec::new();

    for (place, track) in chosen.iter().enumerate() {
        let meta = track.meta();
        let label = import_source::track_label(&meta);

        match import_source::held(&known, &meta) {
            Some(id) => {
                landed.insert(track.id.clone(), id.clone());
                reused.push(label);
            }
            None => wanted.push(Wanted {
                place,
                id: track.id.clone(),
                cover: track.cover_path.as_deref().map(PathBuf::from),
                meta,
            }),
        }
    }

    let jobs: Vec<download::Job> = wanted
        .iter()
        .enumerate()
        .map(|(position, want)| download::Job {
            key: position,
            meta: &want.meta,
            dir: staging.path().join(want.place.to_string()),
            cover: want.cover.clone(),
        })
        .collect();

    report.phase("downloading", &download_message(jobs.len()));
    report.count(jobs.len());
    for label in &reused {
        report.reuse(label);
    }

    let mut songs = 0usize;
    let mut images = 0usize;
    let mut lyrics = 0usize;
    let mut similar = 0usize;
    let mut duplicates = reused.len();
    let mut handled = 0usize;

    download::fetch_all(&tools, &jobs, |fetched| {
        let want = &wanted[fetched.key];
        let label = import_source::track_label(&want.meta);
        handled += 1;

        match fetched.file.and_then(|file| import::land(app, &file)) {
            Ok(song) => {
                let done = import::complete(app, &song.id);

                songs += usize::from(!song.duplicate);
                duplicates += usize::from(song.duplicate);
                images += usize::from(song.cover || done.cover);
                lyrics += usize::from(song.lyrics || done.lyrics);
                similar += usize::from(song.similar);
                landed.insert(want.id.clone(), song.id);
            }
            Err(error) => report.fail(format!("{label}: {error}")),
        }

        report.at(handled, &label);
    });

    let outcome = ImportOutcome {
        songs,
        images,
        lyrics,
        skipped: 0,
        duplicates,
        similar,
        playlist: Some(playlist_id.to_string()),
        playlist_id: None,
        track_ids: Vec::new(),
        errors: report.failures().to_vec(),
        state: PersistedState::default(),
    };

    let done: Vec<(String, String)> = landed.into_iter().collect();
    if !done.is_empty() {
        catalog.resolve_pending(playlist_id, &done)?;
    }

    import::remember_import(app, "playlist", &name, &outcome);
    let mut outcome = outcome;
    if outcome.errors.is_empty() {
        staging.cleanup();
    }
    outcome.refresh_state(app, &store);
    Ok(outcome)
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

#[cfg(any(target_os = "android", test))]
fn fill_phone(
    catalog: &Catalog,
    playlist_id: &str,
    entry_ids: &[String],
    report: &mut Reporter,
    mut fetch: impl FnMut(usize, &PendingTrack) -> Result<import::Landed, String>,
    mut complete: impl FnMut(&str) -> import::Complete,
    mut updated: impl FnMut(),
) -> Result<ImportOutcome, String> {
    let entries = catalog.playlist_entries(playlist_id)?;
    let waiting: HashMap<String, PendingTrack> = catalog.pending_tracks(playlist_id)?
        .into_iter().map(|track| (track.id.clone(), track)).collect();
    let selected: HashSet<&str> = entry_ids.iter().map(String::as_str).collect();
    let mut seen = HashSet::new();
    let chosen: Vec<&PendingTrack> = entries.iter()
        .filter(|id| selected.is_empty() || selected.contains(id.as_str()))
        .filter(|id| seen.insert(id.as_str()))
        .filter_map(|id| waiting.get(id))
        .collect();
    if chosen.is_empty() {
        return Ok(ImportOutcome {
            playlist: Some(playlist_id.to_string()),
            skipped: waiting.len(),
            ..ImportOutcome::default()
        });
    }

    let mut known = import_source::catalog_index(catalog)?;
    let mut outcome = ImportOutcome {
        playlist: Some(playlist_id.to_string()),
        ..ImportOutcome::default()
    };
    report.phase("downloading", &download_message(chosen.len()));
    report.count(chosen.len());

    for (position, track) in chosen.iter().enumerate() {
        if !catalog.is_pending_entry(playlist_id, &track.id)? {
            continue;
        }
        let meta = track.meta();
        let label = import_source::track_label(&meta);
        report.at(position + 1, &label);
        let mut downloaded = None;
        let id = if let Some(id) = import_source::held(&known, &meta) {
            outcome.duplicates += 1;
            report.reuse(&label);
            id.clone()
        } else {
            match fetch(position, track) {
                Ok(song) => {
                    outcome.songs += usize::from(!song.duplicate);
                    outcome.duplicates += usize::from(song.duplicate);
                    outcome.similar += usize::from(song.similar);
                    if let Some(row) = catalog.track(&song.id)? {
                        import_source::remember(&mut known, row);
                    }
                    downloaded = Some((song.id.clone(), song.cover, song.lyrics));
                    song.id
                }
                Err(error) => {
                    report.fail(format!("{label}: {error}"));
                    continue;
                }
            }
        };
        catalog.resolve_pending(playlist_id, &[(track.id.clone(), id)])?;
        updated();
        if let Some((id, cover, lyrics)) = downloaded {
            let done = complete(&id);
            outcome.images += usize::from(cover || done.cover);
            outcome.lyrics += usize::from(lyrics || done.lyrics);
        }
    }
    outcome.errors = report.failures().to_vec();
    outcome.skipped = catalog.pending_tracks(playlist_id)?.len();
    Ok(outcome)
}

#[cfg(target_os = "android")]
fn run_phone(app: &AppHandle, playlist_id: &str, entry_ids: &[String]) -> Result<ImportOutcome, String> {
    use tauri::Emitter;
    static DOWNLOAD: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _download = DOWNLOAD.try_lock().map_err(|_| "Another playlist is already downloading.")?;
    let guard = crate::library_work::Guard::start(app, "Downloading playlist");
    let catalog = app.state::<Catalog>();
    let store = app.state::<Store>();
    let yt = crate::youtube_phone::extractor()?;
    let staging = staging_dir(app, playlist_id)?;
    let mut report = Reporter::new(app, PROGRESS_EVENT, Output::Events);
    let mut last_update: Option<std::time::Instant> = None;
    let result = fill_phone(&catalog, playlist_id, entry_ids, &mut report, |position, track| {
        let meta = track.meta();
        let job = download::Job {
            key: position,
            meta: &meta,
            dir: staging.path().join(position.to_string()),
            cover: track.cover_path.as_deref().map(PathBuf::from),
        };
        let result = crate::youtube_phone::fetch_matching(&yt, &job)
            .and_then(|file| import::land(app, &file));
        let _ = std::fs::remove_dir_all(&job.dir);
        result
    }, |id| import::complete(app, id), || {
        if last_update.is_none_or(|last| last.elapsed() >= std::time::Duration::from_millis(250)) {
            last_update = Some(std::time::Instant::now());
            let _ = app.emit(crate::api::STATE_EVENT, ());
        }
    });
    staging.cleanup();
    crate::loudness::schedule(app, guard);
    let _ = app.emit(crate::api::STATE_EVENT, ());
    match result {
        Ok(mut outcome) => {
            import::remember_import(app, "playlist", &playlist_name(&catalog, playlist_id), &outcome);
            outcome.refresh_state(app, &store);
            report.phase("done", "Finished.");
            Ok(outcome)
        }
        Err(error) => {
            report.phase("failed", &error);
            Err(error)
        }
    }
}

fn staging_dir_at(root: &Path, playlist_id: &str) -> Result<import_source::DownloadStaging, String> {
    import_source::reserve_staging(&root.join(STAGING).join(playlist_id))
}

fn staging_dir(app: &AppHandle, playlist_id: &str) -> Result<import_source::DownloadStaging, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data directory: {e}"))?;
    staging_dir_at(&root, playlist_id)
}

#[tauri::command]
pub async fn download_playlist(
    app: AppHandle,
    playlist_id: String,
    entry_ids: Vec<String>,
) -> Result<ImportOutcome, String> {
    #[cfg(target_os = "android")]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            run_phone(&app, &playlist_id, &entry_ids)
        })
        .await
        .map_err(|e| format!("the download stopped unexpectedly: {e}"))?;
    }

    #[cfg(all(not(desktop), not(target_os = "android")))]
    {
        let _ = (app, playlist_id, entry_ids);
        return Err(import_source::NOT_ON_ANDROID.to_string());
    }

    #[cfg(desktop)]
    {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            run(&handle, &playlist_id, &entry_ids, Output::Events)
        })
        .await
        .map_err(|e| format!("the download stopped unexpectedly: {e}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(title: &str) -> PendingTrack {
        PendingTrack::from_meta(&TrackMeta {
            title: title.to_string(),
            artists: vec!["Artist".to_string()],
            duration_ms: Some(180_000),
            ..TrackMeta::default()
        }, "wavelist", "")
    }

    fn add_song(catalog: &Catalog, id: &str, title: &str) -> import::Landed {
        catalog.upsert_track(&crate::catalog::TrackRow {
            id: id.into(),
            rel_path: format!("songs/{id}/audio.m4a"),
            title: title.into(),
            artist: Some("Artist".into()),
            duration_ms: 180_000,
            ..crate::catalog::TrackRow::default()
        }).unwrap();
        import::Landed {
            id: id.into(), duplicate: false, similar: false, cover: true, lyrics: false,
        }
    }

    #[test]
    fn phone_downloads_resolve_in_order_reuse_duplicates_and_retry_failures() {
        let catalog = Catalog::in_memory().unwrap();
        add_song(&catalog, "held", "Existing");
        let waiting = vec![pending("First"), pending("Existing"), pending("First"), pending("Failed")];
        let entries: Vec<_> = waiting.iter().map(|track| track.id.clone()).collect();
        let id = catalog.create_imported_playlist("Imported", &entries, &waiting).unwrap();
        let mut fetched = Vec::new();
        let mut updates = 0;
        let mut report = Reporter::quiet();
        let result = fill_phone(&catalog, &id, &[], &mut report, |_, track| {
            fetched.push(track.title.clone());
            if track.title == "Failed" {
                Err("offline".into())
            } else {
                Ok(add_song(&catalog, "first", &track.title))
            }
        }, |_| import::Complete::default(), || updates += 1).unwrap();
        assert_eq!(fetched, ["First", "Failed"]);
        assert_eq!(result.songs, 1);
        assert_eq!(result.duplicates, 2);
        assert_eq!(result.images, 1);
        assert_eq!(result.skipped, 1);
        assert_eq!(updates, 3);
        assert!(result.errors[0].contains("offline"));
        assert_eq!(catalog.playlist_entries(&id).unwrap(), vec!["first", "held", "first", &entries[3]]);

        let mut report = Reporter::quiet();
        let result = fill_phone(&catalog, &id, &[entries[3].clone()], &mut report, |_, track| {
            Ok(add_song(&catalog, "last", &track.title))
        }, |_| import::Complete::default(), || {}).unwrap();
        assert_eq!(result.songs, 1);
        assert_eq!(result.skipped, 0);
        assert_eq!(catalog.playlist_entries(&id).unwrap(), vec!["first", "held", "first", "last"]);
    }

    #[test]
    fn phone_download_resolves_before_completing_metadata() {
        let catalog = Catalog::in_memory().unwrap();
        let track = pending("First");
        let id = catalog.create_imported_playlist("Imported", &[track.id.clone()], &[track]).unwrap();
        let notified = std::cell::Cell::new(false);
        let mut report = Reporter::quiet();
        let outcome = fill_phone(&catalog, &id, &[], &mut report, |_, track| {
            Ok(add_song(&catalog, "first", &track.title))
        }, |song_id| {
            assert!(notified.get());
            assert_eq!(catalog.playlist_entries(&id).unwrap(), [song_id]);
            import::Complete { lyrics: true, ..import::Complete::default() }
        }, || notified.set(true)).unwrap();
        assert_eq!(outcome.images, 1);
        assert_eq!(outcome.lyrics, 1);
    }

    #[test]
    fn phone_download_does_not_restore_an_entry_removed_during_fetch() {
        let catalog = Catalog::in_memory().unwrap();
        let track = pending("Removed");
        let id = catalog.create_imported_playlist("Imported", &[track.id.clone()], &[track.clone()]).unwrap();
        let mut report = Reporter::quiet();
        fill_phone(&catalog, &id, &[], &mut report, |_, item| {
            catalog.remove_from_playlist(&id, &[item.id.clone()]).unwrap();
            Ok(add_song(&catalog, "song", &item.title))
        }, |_| import::Complete::default(), || {}).unwrap();
        assert!(catalog.playlist_entries(&id).unwrap().is_empty());
        assert!(catalog.pending_tracks(&id).unwrap().is_empty());
    }

    #[test]
    fn phone_download_skips_entries_removed_before_their_turn() {
        let catalog = Catalog::in_memory().unwrap();
        let first = pending("First");
        let second = pending("Second");
        let id = catalog.create_imported_playlist(
            "Imported", &[first.id.clone(), second.id.clone()], &[first, second.clone()],
        ).unwrap();
        let mut report = Reporter::quiet();
        let mut fetched = Vec::new();
        fill_phone(&catalog, &id, &[], &mut report, |_, track| {
            fetched.push(track.title.clone());
            catalog.remove_from_playlist(&id, &[second.id.clone()]).unwrap();
            Ok(add_song(&catalog, "first", &track.title))
        }, |_| import::Complete::default(), || {}).unwrap();
        assert_eq!(fetched, ["First"]);
        assert_eq!(catalog.playlist_entries(&id).unwrap(), ["first"]);
    }

    #[test]
    fn phone_download_allows_entries_already_resolved_by_a_scan() {
        let catalog = Catalog::in_memory().unwrap();
        let id = catalog.create_imported_playlist("Imported", &[], &[]).unwrap();
        let mut report = Reporter::quiet();
        let outcome = fill_phone(&catalog, &id, &[], &mut report, |_, _| {
            panic!("nothing should be downloaded")
        }, |_| import::Complete::default(), || {}).unwrap();
        assert_eq!(outcome.skipped, 0);
    }

    #[test]
    fn concurrent_playlist_downloads_do_not_share_job_files() {
        let root = std::env::temp_dir().join(format!("wave-playlist-staging-{}", crate::identity::new_id()));
        let first = staging_dir_at(&root, "same-playlist").unwrap();
        let second = staging_dir_at(&root, "same-playlist").unwrap();
        assert_ne!(first.path(), second.path());
        for (stage, contents) in [(&first, b"first"), (&second, b"other")] {
            std::fs::create_dir(stage.path().join("0")).unwrap();
            std::fs::write(stage.path().join("0").join("audio.mp3"), contents).unwrap();
        }
        first.cleanup();
        assert_eq!(std::fs::read(second.path().join("0").join("audio.mp3")).unwrap(), b"other");
        let retained = second.path().to_path_buf();
        drop(second);
        assert!(retained.join("0").join("audio.mp3").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn says_how_many_songs_it_is_fetching() {
        assert_eq!(download_message(1), "Downloading 1 song.");
        assert_eq!(download_message(7), "Downloading 7 songs.");
    }
}
