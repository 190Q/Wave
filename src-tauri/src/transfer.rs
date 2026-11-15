use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
#[cfg(target_os = "android")]
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
#[cfg(target_os = "android")]
use std::{io::Write, str::FromStr};

use crate::catalog::{Catalog, TrackRow};
use crate::download;
use crate::download_log;
use crate::import::{self, ImportOutcome};
use crate::import_source;
use crate::library;
use crate::playlists;
use crate::progress::{Output, Reporter};
use crate::source::{read_env, TrackMeta};
use crate::state::PendingTrack;
use crate::state::{PersistedState, Store};
use crate::tools;

const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;

const VERSION: u32 = 2;

pub const PROGRESS_EVENT: &str = "wavelist-import";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WaveList {
    format: String,
    version: u32,
    name: String,
    tracks: Vec<TrackMeta>,
}

impl WaveList {
    fn validate(&self) -> Result<(), String> {
        if self.format != "wave-playlist" || self.version != VERSION {
            return Err("This is not a supported Wave playlist export.".into());
        }
        if self.name.trim().is_empty() || self.name.len() > 1024
            || self.tracks.is_empty() || self.tracks.len() > 10_000
        {
            return Err("The export needs a name and between 1 and 10,000 songs.".into());
        }
        for meta in &self.tracks {
            if meta.title.trim().is_empty() || meta.title.len() > 4096 {
                return Err("The export contains a song with no title.".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyList {
    format: String,
    name: String,
    tracks: Vec<LegacyEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyEntry {
    meta: TrackMeta,
}

fn read(path: &Path) -> Result<WaveList, String> {
    let file = fs::File::open(path).map_err(|e| format!("Could not open the export: {e}"))?;
    read_list(file)
}

fn read_list(file: impl Read) -> Result<WaveList, String> {
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("The playlist export is too large to read.".into());
    }

    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Could not read the Wave playlist export: {e}"))?;

    let list = match value.get("version").and_then(serde_json::Value::as_u64) {
        Some(version) if version == u64::from(VERSION) => serde_json::from_value(value)
            .map_err(|e| format!("Could not read the Wave playlist export: {e}"))?,
        Some(1) => {
            let legacy: LegacyList = serde_json::from_value(value)
                .map_err(|e| format!("Could not read the Wave playlist export: {e}"))?;
            WaveList {
                format: legacy.format,
                version: VERSION,
                name: legacy.name,
                tracks: legacy.tracks.into_iter().map(|entry| entry.meta).collect(),
            }
        }
        _ => return Err("This is not a supported Wave playlist export.".into()),
    };
    list.validate()?;
    Ok(list)
}

fn track_meta(track: &TrackRow) -> TrackMeta {
    TrackMeta {
        title: track.title.clone(),
        artists: track.artist.clone().into_iter().collect(),
        album: track.album.clone().unwrap_or_default(),
        album_artist: track.album_artist.clone().unwrap_or_default(),
        release_date: track.year.map(|year| year.to_string()).unwrap_or_default(),
        track_number: track.track_no,
        disc_number: track.disc_no,
        genres: track.genre.clone().into_iter().collect(),
        duration_ms: Some(track.duration_ms),
        ..TrackMeta::default()
    }
}

pub(crate) fn export(
    app: &AppHandle,
    path: &Path,
    name: String,
    ids: &[String],
) -> Result<usize, String> {
    let catalog = app.state::<Catalog>();
    let list = export_list(&catalog, name, ids)?;
    write_list(app, path, &list)
}

pub(crate) fn export_playlist(app: &AppHandle, path: &Path, playlist_id: &str) -> Result<usize, String> {
    let catalog = app.state::<Catalog>();
    let list = playlist_export_list(&catalog, playlist_id)?;
    write_list(app, path, &list)
}

fn playlist_export_list(catalog: &Catalog, playlist_id: &str) -> Result<WaveList, String> {
    let playlist = catalog.playlists()?.into_iter()
        .find(|playlist| playlist.id == playlist_id)
        .ok_or("That playlist is no longer available.")?;
    export_list(catalog, playlist.name, &catalog.playlist_entries(playlist_id)?)
}

fn export_list(catalog: &Catalog, name: String, ids: &[String]) -> Result<WaveList, String> {
    let tracks = catalog.tracks_by_ids(ids)?;
    let pending: HashMap<String, PendingTrack> = catalog.playlists()?.into_iter()
        .flat_map(|playlist| playlist.pending)
        .map(|track| (track.id.clone(), track))
        .collect();
    let entries = ids.iter().map(|id| {
        if let Some(track) = pending.get(id) {
            Ok(track.meta())
        } else if let Some(track) = tracks.get(id) {
            Ok(track_meta(track))
        } else {
            Err(format!("A selected song is no longer in the library: {id}"))
        }
    }).collect::<Result<Vec<_>, _>>()?;
    let list = WaveList {
        format: "wave-playlist".into(),
        version: VERSION,
        name,
        tracks: entries,
    };
    list.validate()?;
    Ok(list)
}

fn write_list(_app: &AppHandle, path: &Path, list: &WaveList) -> Result<usize, String> {
    let bytes = serde_json::to_vec(&list).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("The playlist export is too large to save.".into());
    }
    #[cfg(target_os = "android")]
    if path.to_string_lossy().starts_with("content://") {
        let target = FilePath::from_str(&path.to_string_lossy()).map_err(|e| e.to_string())?;
        let mut options = OpenOptions::new();
        options.write(true).truncate(true);
        let mut file = _app.fs().open(target, options)
            .map_err(|e| format!("Could not save the export: {e}"))?;
        file.write_all(&bytes).map_err(|e| format!("Could not save the export: {e}"))?;
        return Ok(list.tracks.len());
    }
    fs::write(path, bytes).map_err(|e| format!("Could not save the export: {e}"))?;
    Ok(list.tracks.len())
}

fn staging_dir(app: &AppHandle) -> Result<import_source::DownloadStaging, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("transfer");
    import_source::reserve_staging(&dir)
}

pub(crate) fn run(
    app: &AppHandle,
    path: &Path,
    report: &mut Reporter,
) -> Result<ImportOutcome, String> {
    let list = read(path)?;
    let catalog = app.state::<Catalog>();

    let existing = import_source::catalog_index(&catalog)?;

    // The download tools are only needed for the songs the library is missing.
    let wanted = list
        .tracks
        .iter()
        .any(|meta| import_source::held(&existing, meta).is_none());
    let tools = if wanted {
        let bundled = tools::bundled_dir(app);
        // A song the library already holds is never downloaded, so an import
        // with nothing left to fetch leaves the last log standing.
        download_log::begin(app, "wavelist");
        Some(download::resolve_tools(&read_env(app), bundled.as_deref())?)
    } else {
        None
    };
    if let Some(log) = tools.as_ref().and_then(|tools| tools.log.as_ref()) {
        log.link(&list.name, list.tracks.len());
    }

    let staging = staging_dir(app)?;

    let result = (|| {
        report.phase("downloading", "Downloading the audio. Spotify is not needed.");
        report.count(list.tracks.len());

        let mut ids: Vec<Option<String>> = vec![None; list.tracks.len()];
        let mut songs = 0usize;
        let mut images = 0usize;
        let mut lyrics = 0usize;
        let mut similar = 0usize;
        let mut duplicates = 0usize;

        for (position, meta) in list.tracks.iter().enumerate() {
            let label = import_source::track_label(meta);
            report.at(position + 1, &label);

            // A song the library already holds keeps its place without a download.
            if let Some(id) = import_source::held(&existing, meta) {
                ids[position] = Some(id.clone());
                duplicates += 1;
                report.reuse(&label);
                continue;
            }

            let file = match download::download(
                tools.as_ref().ok_or("Download tools are unavailable.")?,
                meta,
                &staging.path().join(position.to_string()),
                None,
            ) {
                Ok(file) => file,
                Err(error) => {
                    report.fail(format!("{label}: {error}"));
                    continue;
                }
            };

            match import::land(app, &file) {
                Ok(song) => {
                    let done = import::complete(app, &song.id);

                    songs += usize::from(!song.duplicate);
                    duplicates += usize::from(song.duplicate);
                    images += usize::from(song.cover || done.cover);
                    lyrics += usize::from(song.lyrics || done.lyrics);
                    similar += usize::from(song.similar);
                    ids[position] = Some(song.id);
                }
                Err(error) => report.fail(format!("{label}: {error}")),
            }
        }

        let mut outcome = ImportOutcome {
            songs,
            images,
            lyrics,
            skipped: 0,
            duplicates,
            similar,
            playlist: None,
            track_ids: Vec::new(),
            errors: Vec::new(),
            state: PersistedState::default(),
        };

        let playlist: Vec<String> = ids.into_iter().flatten().collect();
        if !playlist.is_empty() {
            outcome.playlist = Some(playlists::write(app, &list.name, &playlist)?);
        }

        outcome.errors.extend_from_slice(report.failures());
        import::remember_import(app, "wavelist", &list.name, &outcome);
        library::scan(app, &catalog, false);
        outcome.refresh_state(app, &app.state::<Store>());
        Ok(outcome)
    })();

    staging.cleanup();
    result
}

#[cfg(any(target_os = "android", test))]
fn imported_entries(
    tracks: &[TrackMeta],
    existing: &import_source::TrackIndex,
) -> (Vec<String>, Vec<PendingTrack>, usize) {
    let mut entries = Vec::with_capacity(tracks.len());
    let mut pending = Vec::new();
    let mut matched = 0;
    for meta in tracks {
        if let Some(id) = import_source::held(existing, meta) {
            entries.push(id.clone());
            matched += 1;
        } else {
            let track = PendingTrack::from_meta(meta, "wavelist", "");
            entries.push(track.id.clone());
            pending.push(track);
        }
    }
    (entries, pending, matched)
}

#[cfg(target_os = "android")]
fn run_phone(app: &AppHandle, path: &str, report: &mut Reporter) -> Result<ImportOutcome, String> {
    let selected = FilePath::from_str(path).map_err(|e| e.to_string())?;
    let mut options = OpenOptions::new();
    options.read(true);
    let file = app.fs().open(selected, options)
        .map_err(|e| format!("Could not open the export: {e}"))?;
    let list = read_list(file)?;
    report.phase("resolving", "Matching songs in your library.");
    let catalog = app.state::<Catalog>();
    let existing = import_source::catalog_index(&catalog)?;
    let (entries, pending, matched) = imported_entries(&list.tracks, &existing);
    catalog.create_imported_playlist(&list.name, &entries, &pending)?;
    let mut outcome = ImportOutcome {
        duplicates: matched,
        skipped: pending.len(),
        playlist: Some(list.name.clone()),
        ..ImportOutcome::default()
    };
    import::remember_import(app, "wavelist", &list.name, &outcome);
    outcome.refresh_state(app, &app.state::<Store>());
    Ok(outcome)
}

pub(crate) fn resolve_imported(catalog: &Catalog) -> Result<(), String> {
    let lists = catalog.playlists()?;
    if !lists.iter().any(|list| list.pending.iter().any(|track| track.source == "wavelist")) {
        return Ok(());
    }
    let existing = import_source::catalog_index(catalog)?;
    for list in lists {
        let matches: Vec<_> = list.pending.iter()
            .filter(|track| track.source == "wavelist")
            .filter_map(|track| {
                import_source::held(&existing, &track.meta())
                    .map(|id| (track.id.clone(), id.clone()))
            })
            .collect();
        if !matches.is_empty() {
            catalog.resolve_imported_pending(&list.id, &matches)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn export_wavelist(
    app: AppHandle,
    path: String,
    name: String,
    track_ids: Vec<String>,
    playlist_id: Option<String>,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || match playlist_id {
        Some(id) => export_playlist(&app, Path::new(&path), &id),
        None => export(&app, Path::new(&path), name, &track_ids),
    })
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_wavelist(app: AppHandle, path: String) -> Result<ImportOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut report = Reporter::new(&app, PROGRESS_EVENT, Output::Events);
        #[cfg(target_os = "android")]
        let result = run_phone(&app, &path, &mut report);
        #[cfg(not(target_os = "android"))]
        let result = run(&app, Path::new(&path), &mut report);
        match &result {
            Ok(_) => report.phase("done", "Finished."),
            Err(error) => report.phase("failed", error),
        }
        result
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list() -> WaveList {
        WaveList {
            format: "wave-playlist".into(),
            version: VERSION,
            name: "A playlist".into(),
            tracks: vec![TrackMeta {
                title: "Song".into(),
                artists: vec!["Artist".into()],
                album: "Album".into(),
                genres: vec!["Rock".into()],
                ..TrackMeta::default()
            }],
        }
    }

    fn write(name: &str, body: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wave-transfer-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("list.wavelist");
        fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn round_trip_keeps_the_song_list() {
        let list: WaveList = serde_json::from_slice(&serde_json::to_vec(&list()).unwrap()).unwrap();
        list.validate().unwrap();
        assert_eq!(list.tracks[0].title, "Song");
        assert_eq!(list.tracks[0].artists, vec!["Artist"]);
        assert_eq!(list.tracks[0].genres, vec!["Rock"]);
    }

    #[test]
    fn a_song_costs_a_few_hundred_bytes_and_no_more() {
        let bytes = serde_json::to_vec(&list()).unwrap();
        assert!(bytes.len() < 1024, "a song took {} bytes", bytes.len());
    }

    #[test]
    fn rejects_unknown_versions_and_invalid_songs() {
        let mut list = list();
        list.version = 3;
        assert!(list.validate().is_err());
        list.version = VERSION;
        list.tracks[0].title.clear();
        assert!(list.validate().is_err());
        list.tracks.clear();
        assert!(list.validate().is_err());
    }

    #[test]
    fn reads_the_first_format_for_its_song_list_alone() {
        let path = write(
            "legacy",
            r#"{
                "format": "wave-playlist",
                "version": 1,
                "name": "Old",
                "tracks": [
                    {
                        "meta": {"title": "Song", "artists": ["Artist"]},
                        "cover": [137, 80, 78, 71],
                        "syncedLyrics": "[00:01]Words"
                    }
                ]
            }"#,
        );

        let list = read(&path).unwrap();
        assert_eq!(list.version, VERSION);
        assert_eq!(list.tracks.len(), 1);
        assert_eq!(list.tracks[0].title, "Song");
    }

    #[test]
    fn refuses_a_file_that_is_not_a_wave_playlist() {
        let path = write("foreign", r#"{"format": "something-else", "version": 2}"#);
        assert!(read(&path).is_err());
    }

    #[test]
    fn exports_all_playlist_entries_in_order_with_pending_metadata() {
        let catalog = Catalog::in_memory().unwrap();
        catalog.upsert_track(&TrackRow {
            id: "held".into(), rel_path: "held.mp3".into(), title: "Held".into(),
            artist: Some("Artist".into()), album: Some("Album".into()),
            duration_ms: 180_000, ..TrackRow::default()
        }).unwrap();
        catalog.upsert_track(&TrackRow {
            id: "missing".into(), rel_path: "missing.mp3".into(), title: "Missing audio".into(),
            missing: true, ..TrackRow::default()
        }).unwrap();
        let meta = TrackMeta {
            title: "Waiting".into(), artists: vec!["One".into(), "Two".into()],
            album: "Release".into(), album_artist: "One".into(), release_date: "2022-03-05".into(),
            track_number: Some(4), disc_number: Some(2), genres: vec!["Rock".into(), "Metal".into()],
            isrc: "USABC1234567".into(), cover_url: Some("https://example.org/cover.jpg".into()),
            duration_ms: Some(215_000), ..TrackMeta::default()
        };
        let pending = PendingTrack::from_meta(&meta, "deezer", "source");
        let ids = vec![pending.id.clone(), "held".into(), "missing".into(), pending.id.clone()];
        let id = catalog.create_generated_playlist("Mixed", &ids, &[pending]).unwrap();

        let exported = playlist_export_list(&catalog, &id).unwrap();
        let parsed = read_list(serde_json::to_vec(&exported).unwrap().as_slice()).unwrap();
        assert_eq!(parsed.name, "Mixed");
        assert_eq!(parsed.tracks.iter().map(|track| track.title.as_str()).collect::<Vec<_>>(),
            ["Waiting", "Held", "Missing audio", "Waiting"]);
        assert_eq!(serde_json::to_value(&parsed.tracks[0]).unwrap(), serde_json::to_value(&meta).unwrap());
        assert_eq!(serde_json::to_value(&parsed.tracks[3]).unwrap(), serde_json::to_value(&meta).unwrap());
    }

    #[test]
    fn exports_pending_only_and_rejects_unresolvable_entries() {
        let catalog = Catalog::in_memory().unwrap();
        let pending = PendingTrack::from_meta(&list().tracks[0], "wavelist", "");
        let id = catalog.create_generated_playlist("Waiting", &[pending.id.clone()], &[pending.clone()]).unwrap();
        let exported = playlist_export_list(&catalog, &id).unwrap();
        assert_eq!(exported.tracks.len(), 1);
        assert_eq!(exported.tracks[0].title, "Song");
        assert_eq!(export_list(&catalog, "Selection".into(), &[pending.id]).unwrap().tracks.len(), 1);
        assert!(export_list(&catalog, "Selection".into(), &["unknown".into()]).is_err());
        catalog.set_playlist_entries(&id, &["unknown".into()]).unwrap();
        assert!(playlist_export_list(&catalog, &id).is_err());
        assert!(playlist_export_list(&catalog, "unknown").is_err());
    }

    #[test]
    fn imported_playlist_keeps_missing_tracks_and_resolves_them_in_order() {
        use crate::catalog::TrackRow;

        let catalog = Catalog::in_memory().unwrap();
        let track = |id: &str, title: &str| TrackRow {
            id: id.into(),
            rel_path: format!("songs/{id}/audio.mp3"),
            title: title.into(),
            artist: Some("Artist".into()),
            album: Some("Album".into()),
            ..TrackRow::default()
        };
        catalog.upsert_track(&track("one", "Song")).unwrap();
        let mut tracks = list().tracks;
        tracks.push(TrackMeta {
            title: "Missing".into(),
            artists: vec!["Artist".into()],
            album: "Album".into(),
            ..TrackMeta::default()
        });
        tracks.push(tracks[0].clone());
        let (entries, pending, matched) =
            imported_entries(&tracks, &import_source::catalog_index(&catalog).unwrap());
        assert_eq!(matched, 2);
        assert_eq!(entries, vec!["one", &pending[0].id, "one"]);

        let id = catalog.create_imported_playlist("Imported", &entries, &pending).unwrap();
        assert_eq!(catalog.playlists().unwrap()[0].kind, "custom");
        resolve_imported(&catalog).unwrap();
        assert_eq!(catalog.playlist_entries(&id).unwrap(), entries);

        catalog.upsert_track(&track("two", "Missing")).unwrap();
        resolve_imported(&catalog).unwrap();
        let playlist = catalog.playlists().unwrap().remove(0);
        assert_eq!(playlist.entries, vec!["one", "two", "one"]);
        assert!(playlist.pending.is_empty());
    }

    #[test]
    fn removing_a_missing_entry_does_not_restore_it_later() {
        let catalog = Catalog::in_memory().unwrap();
        let (entries, pending, _) = imported_entries(&list().tracks, &import_source::TrackIndex::default());
        let id = catalog.create_imported_playlist("Imported", &entries, &pending).unwrap();
        catalog.remove_from_playlist(&id, &entries).unwrap();
        assert!(catalog.pending_tracks(&id).unwrap().is_empty());
        assert!(catalog.playlist_entries(&id).unwrap().is_empty());
    }

}
