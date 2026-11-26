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
use crate::lyrics;
use crate::playlists;
use crate::progress::{Output, Reporter};
use crate::source::{read_env, TrackMeta};
use crate::state::PendingTrack;
use crate::state::{PersistedState, Store};
use crate::tools;

const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;

pub(crate) fn read_bytes(app: &AppHandle, path: &str) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "android")]
    let file = {
        let selected = FilePath::from_str(path).map_err(|e| e.to_string())?;
        let mut options = OpenOptions::new();
        options.read(true);
        app.fs().open(selected, options).map_err(|e| format!("Could not open the export: {e}"))?
    };
    #[cfg(not(target_os = "android"))]
    let file = {
        let _ = app;
        fs::File::open(path).map_err(|e| format!("Could not open the export: {e}"))?
    };
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("The export is too large to read.".into());
    }
    Ok(bytes)
}

pub(crate) fn write_bytes(app: &AppHandle, path: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("The export is too large to save.".into());
    }
    #[cfg(target_os = "android")]
    if path.starts_with("content://") {
        let target = FilePath::from_str(path).map_err(|e| e.to_string())?;
        let mut options = OpenOptions::new();
        options.write(true).truncate(true);
        let mut file = app.fs().open(target, options).map_err(|e| format!("Could not save the export: {e}"))?;
        return file.write_all(bytes).map_err(|e| format!("Could not save the export: {e}"));
    }
    let _ = app;
    fs::write(path, bytes).map_err(|e| format!("Could not save the export: {e}"))
}

const VERSION: u32 = 3;
const MAGIC: &[u8] = b"WAVE\x03";

pub const PROGRESS_EVENT: &str = "wavelist-import";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WaveList {
    format: String,
    version: u32,
    name: String,
    tracks: Vec<TrackMeta>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    lyrics: Vec<Option<String>>,
}

impl WaveList {
    fn validate(&self) -> Result<(), String> {
        if self.format != "wave-playlist" || self.version != VERSION {
            return Err("This is not a supported Wave playlist export.".into());
        }
        if !self.lyrics.is_empty() && self.lyrics.len() != self.tracks.len() {
            return Err("The playlist lyrics do not match the song list.".into());
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

    fn lyrics_at(&self, index: usize) -> Option<&str> {
        self.lyrics.get(index).and_then(Option::as_deref)
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
    #[serde(default)]
    synced_lyrics: Option<String>,
}

fn read(path: &Path) -> Result<WaveList, String> {
    let file = fs::File::open(path).map_err(|e| format!("Could not open the export: {e}"))?;
    read_list(file)
}

fn decompress(bytes: &[u8], limit: u64) -> Result<Vec<u8>, String> {
    let mut decoded = Vec::new();
    brotli::Decompressor::new(bytes, 4096)
        .take(limit + 1)
        .read_to_end(&mut decoded)
        .map_err(|e| format!("Could not decompress the Wave playlist export: {e}"))?;
    if decoded.len() as u64 > limit {
        return Err("The playlist export is too large to read.".into());
    }
    Ok(decoded)
}

fn read_list(file: impl Read) -> Result<WaveList, String> {
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("The playlist export is too large to read.".into());
    }

    if bytes.starts_with(MAGIC) {
        bytes = decompress(&bytes[MAGIC.len()..], MAX_FILE_BYTES)?;
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Could not read the Wave playlist export: {e}"))?;

    let list = match value.get("version").and_then(serde_json::Value::as_u64) {
        Some(version) if version == u64::from(VERSION) => serde_json::from_value(value)
            .map_err(|e| format!("Could not read the Wave playlist export: {e}"))?,
        Some(2) => {
            let mut list: WaveList = serde_json::from_value(value)
                .map_err(|e| format!("Could not read the Wave playlist export: {e}"))?;
            list.version = VERSION;
            list
        }
        Some(1) => {
            let legacy: LegacyList = serde_json::from_value(value)
                .map_err(|e| format!("Could not read the Wave playlist export: {e}"))?;
            let lyrics = legacy.tracks.iter().map(|entry| entry.synced_lyrics.clone()).collect();
            WaveList {
                format: legacy.format,
                version: VERSION,
                name: legacy.name,
                tracks: legacy.tracks.into_iter().map(|entry| entry.meta).collect(),
                lyrics,
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
    let mut words = Vec::with_capacity(ids.len());
    let mut total = 0u64;
    let mut cached: HashMap<String, Option<String>> = HashMap::new();
    let entries = ids.iter().map(|id| {
        let (meta, text) = if let Some(track) = pending.get(id) {
            (track.meta(), track.synced_lyrics.clone())
        } else if let Some(track) = tracks.get(id) {
            let text = match cached.get(id) {
                Some(text) => text.clone(),
                None => {
                    let text = lyrics::read_track(catalog.root(), track, MAX_FILE_BYTES - total)?;
                    cached.insert(id.clone(), text.clone());
                    text
                }
            };
            (track_meta(track), text)
        } else {
            return Err(format!("A selected song is no longer in the library: {id}"));
        };
        total = total.saturating_add(text.as_ref().map_or(0, |text| text.len() as u64));
        if total > MAX_FILE_BYTES {
            return Err("The playlist lyrics are too large to export.".into());
        }
        words.push(text);
        Ok(meta)
    }).collect::<Result<Vec<_>, _>>()?;
    let list = WaveList {
        format: "wave-playlist".into(),
        version: VERSION,
        name,
        tracks: entries,
        lyrics: if words.iter().any(Option::is_some) { words } else { Vec::new() },
    };
    list.validate()?;
    Ok(list)
}

fn encode_list(list: &WaveList) -> Result<Vec<u8>, String> {
    let raw = serde_json::to_vec(list).map_err(|e| e.to_string())?;
    if raw.len() as u64 > MAX_FILE_BYTES {
        return Err("The playlist export is too large to save.".into());
    }
    let mut bytes = MAGIC.to_vec();
    brotli::CompressorReader::new(raw.as_slice(), 4096, 11, 22)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Could not compress the playlist export: {e}"))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("The playlist export is too large to save.".into());
    }
    Ok(bytes)
}

fn write_list(_app: &AppHandle, path: &Path, list: &WaveList) -> Result<usize, String> {
    let bytes = encode_list(list)?;
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

fn restore_lyrics(catalog: &Catalog, id: &str, text: Option<&str>, label: &str, report: &mut Reporter) -> bool {
    match lyrics::restore(catalog, id, text) {
        Ok(saved) => saved,
        Err(error) => {
            report.fail(format!("{label}: {error}"));
            false
        }
    }
}

pub(crate) fn run(
    app: &AppHandle,
    path: &Path,
    report: &mut Reporter,
    create_playlist: bool,
) -> Result<ImportOutcome, String> {
    let list = read(path)?;
    let catalog = app.state::<Catalog>();

    let mut existing = import_source::catalog_index(&catalog)?;

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
                lyrics += usize::from(restore_lyrics(&catalog, id, list.lyrics_at(position), &label, report));
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
                    let restored = restore_lyrics(&catalog, &song.id, list.lyrics_at(position), &label, report);
                    let done = import::complete(app, &song.id);

                    songs += usize::from(!song.duplicate);
                    duplicates += usize::from(song.duplicate);
                    images += usize::from(song.cover || done.cover);
                    lyrics += usize::from(restored || song.lyrics || done.lyrics);
                    similar += usize::from(song.similar);
                    if let Some(row) = catalog.track(&song.id)? {
                        import_source::remember(&mut existing, row);
                    }
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
            playlist_id: None,
            track_ids: Vec::new(),
            errors: Vec::new(),
            state: PersistedState::default(),
        };

        let playlist: Vec<String> = ids.into_iter().flatten().collect();
        if create_playlist && !playlist.is_empty() {
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
    words: &[Option<String>],
    existing: &import_source::TrackIndex,
) -> (Vec<String>, Vec<PendingTrack>, usize) {
    let mut entries = Vec::with_capacity(tracks.len());
    let mut pending = Vec::new();
    let mut matched = 0;
    for (position, meta) in tracks.iter().enumerate() {
        if let Some(id) = import_source::held(existing, meta) {
            entries.push(id.clone());
            matched += 1;
        } else {
            let mut track = PendingTrack::from_meta(meta, "wavelist", "");
            track.synced_lyrics = words.get(position).cloned().flatten();
            entries.push(track.id.clone());
            pending.push(track);
        }
    }
    (entries, pending, matched)
}

#[cfg(target_os = "android")]
fn run_phone(app: &AppHandle, path: &str, report: &mut Reporter, create_playlist: bool) -> Result<ImportOutcome, String> {
    let selected = FilePath::from_str(path).map_err(|e| e.to_string())?;
    let mut options = OpenOptions::new();
    options.read(true);
    let file = app.fs().open(selected, options)
        .map_err(|e| format!("Could not open the export: {e}"))?;
    let list = read_list(file)?;
    report.phase("resolving", "Matching songs in your library.");
    let catalog = app.state::<Catalog>();
    if !create_playlist {
        return import_phone_songs(app, &catalog, &list, report);
    }
    let existing = import_source::catalog_index(&catalog)?;
    let (entries, pending, matched) = imported_entries(&list.tracks, &list.lyrics, &existing);
    let playlist_id = catalog.create_imported_playlist(&list.name, &entries, &pending)?;
    let pending_ids: std::collections::HashSet<&str> = pending.iter().map(|track| track.id.as_str()).collect();
    let restored = entries.iter().enumerate().filter(|(_, id)| !pending_ids.contains(id.as_str()))
        .map(|(position, id)| {
            let label = import_source::track_label(&list.tracks[position]);
            usize::from(restore_lyrics(&catalog, id, list.lyrics_at(position), &label, report))
        }).sum();
    let mut outcome = ImportOutcome {
        duplicates: matched,
        skipped: pending.len(),
        lyrics: restored,
        errors: report.failures().to_vec(),
        playlist: Some(list.name.clone()),
        playlist_id: Some(playlist_id),
        ..ImportOutcome::default()
    };
    import::remember_import(app, "wavelist", &list.name, &outcome);
    outcome.refresh_state(app, &app.state::<Store>());
    Ok(outcome)
}

#[cfg(any(target_os = "android", test))]
fn import_songs(
    catalog: &Catalog,
    tracks: &[TrackMeta],
    words: &[Option<String>],
    report: &mut Reporter,
    mut fetch: impl FnMut(usize, &TrackMeta) -> Result<import::Landed, String>,
    mut complete: impl FnMut(&str) -> import::Complete,
) -> Result<ImportOutcome, String> {
    let mut known = import_source::catalog_index(catalog)?;
    let mut outcome = ImportOutcome::default();
    report.phase("downloading", "Downloading missing songs.");
    report.count(tracks.len());
    for (position, meta) in tracks.iter().enumerate() {
        let label = import_source::track_label(meta);
        report.at(position + 1, &label);
        if let Some(id) = import_source::held(&known, meta) {
            outcome.lyrics += usize::from(restore_lyrics(
                catalog, id, words.get(position).and_then(Option::as_deref), &label, report,
            ));
            outcome.duplicates += 1;
            report.reuse(&label);
            continue;
        }
        match fetch(position, meta) {
            Ok(song) => {
                outcome.songs += usize::from(!song.duplicate);
                outcome.duplicates += usize::from(song.duplicate);
                outcome.similar += usize::from(song.similar);
                let restored = restore_lyrics(
                    catalog, &song.id, words.get(position).and_then(Option::as_deref), &label, report,
                );
                let done = complete(&song.id);
                outcome.images += usize::from(song.cover || done.cover);
                outcome.lyrics += usize::from(restored || song.lyrics || done.lyrics);
                if let Some(row) = catalog.track(&song.id)? {
                    import_source::remember(&mut known, row);
                }
            }
            Err(error) => report.fail(format!("{label}: {error}")),
        }
    }
    outcome.errors = report.failures().to_vec();
    Ok(outcome)
}

#[cfg(target_os = "android")]
fn import_phone_songs(
    app: &AppHandle,
    catalog: &Catalog,
    list: &WaveList,
    report: &mut Reporter,
) -> Result<ImportOutcome, String> {
    let guard = crate::library_work::Guard::start(app, "Importing songs");
    let staging = staging_dir(app)?;
    let mut yt = None;
    let result = import_songs(catalog, &list.tracks, &list.lyrics, report, |position, meta| {
        if yt.is_none() {
            yt = Some(crate::youtube_phone::extractor()?);
        }
        let job = download::Job {
            key: position,
            meta,
            dir: staging.path().join(position.to_string()),
            cover: None,
        };
        let result = crate::youtube_phone::fetch_matching(yt.as_ref().unwrap(), &job)
            .and_then(|file| import::land(app, &file));
        let _ = fs::remove_dir_all(&job.dir);
        result
    }, |id| import::complete(app, id));
    staging.cleanup();
    crate::loudness::schedule(app, guard);
    let mut outcome = result?;
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
        let mut matches = Vec::new();
        for track in list.pending.iter().filter(|track| track.source == "wavelist") {
            if let Some(id) = import_source::held(&existing, &track.meta()) {
                lyrics::restore(catalog, id, track.synced_lyrics.as_deref())?;
                matches.push((track.id.clone(), id.clone()));
            }
        }
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
pub async fn import_wavelist(app: AppHandle, path: String, create_playlist: bool) -> Result<ImportOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut report = Reporter::new(&app, PROGRESS_EVENT, Output::Events);
        #[cfg(target_os = "android")]
        let result = run_phone(&app, &path, &mut report, create_playlist);
        #[cfg(not(target_os = "android"))]
        let result = run(&app, Path::new(&path), &mut report, create_playlist);
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
            lyrics: Vec::new(),
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
        let list = read_list(encode_list(&list()).unwrap().as_slice()).unwrap();
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
    fn compresses_the_entire_playlist_and_preserves_timed_lyrics() {
        let mut original = list();
        original.tracks = (0..20).map(|index| TrackMeta {
            title: format!("Song number {index}"),
            artists: vec!["The test artist".into()],
            album: "The test album".into(),
            ..TrackMeta::default()
        }).collect();
        let text = "[ar:An artist]\r\n[offset:250]\r\n[00:01.25][00:08.50]Héllo, 世界!\r\n".repeat(20);
        original.lyrics = (0..20).map(|index| (index != 5).then(|| text.clone())).collect();
        let raw = serde_json::to_vec(&original).unwrap();
        let encoded = encode_list(&original).unwrap();
        assert!(encoded.starts_with(MAGIC));
        assert!(encoded.len() < raw.len() / 3, "{} versus {}", encoded.len(), raw.len());
        assert!(!encoded.windows(b"Song number".len()).any(|window| window == b"Song number"));
        assert!(!encoded.windows(b"offset:250".len()).any(|window| window == b"offset:250"));
        let decoded = read_list(encoded.as_slice()).unwrap();
        assert_eq!(decoded.tracks[19].title, "Song number 19");
        assert_eq!(decoded.lyrics_at(0), Some(text.as_str()));
        assert_eq!(decoded.lyrics_at(5), None);
        assert_eq!(decoded.lyrics_at(19), Some(text.as_str()));
    }

    #[test]
    fn rejects_corrupt_or_oversized_compressed_data_and_mismatched_lyrics() {
        let mut encoded = encode_list(&list()).unwrap();
        encoded.truncate(encoded.len() / 2);
        assert!(read_list(encoded.as_slice()).is_err());
        let mut compressed = Vec::new();
        brotli::CompressorReader::new(&vec![b'a'; 16_384][..], 4096, 1, 22)
            .read_to_end(&mut compressed).unwrap();
        assert!(decompress(&compressed, 1024).is_err());
        let mut invalid = list();
        invalid.lyrics = vec![None, Some("[00:01]Extra".into())];
        assert!(read_list(encode_list(&invalid).unwrap().as_slice()).is_err());
    }

    #[test]
    fn reads_the_second_json_format_without_lyrics() {
        let mut legacy = list();
        legacy.version = 2;
        let read = read_list(serde_json::to_vec(&legacy).unwrap().as_slice()).unwrap();
        assert_eq!(read.version, VERSION);
        assert_eq!(read.tracks[0].title, "Song");
        assert_eq!(read.lyrics_at(0), None);
    }

    #[test]
    fn rejects_unknown_versions_and_invalid_songs() {
        let mut list = list();
        list.version = 4;
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
        assert_eq!(list.lyrics_at(0), Some("[00:01]Words"));
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
        let parsed = read_list(encode_list(&exported).unwrap().as_slice()).unwrap();
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
    fn exports_sidecars_and_pending_lyrics_then_restores_them_after_restart() {
        let root = std::env::temp_dir().join(format!("wave-transfer-{}", crate::identity::new_id()));
        let catalog = Catalog::open(&root).unwrap();
        let held_dir = library::track_dir(&root, "held");
        fs::create_dir_all(&held_dir).unwrap();
        let held_words = "[00:01.000]Déjà vu\r\n[00:02.500]Again\r\n";
        fs::write(held_dir.join("lyrics.lrc"), held_words).unwrap();
        catalog.upsert_track(&TrackRow {
            id: "held".into(), rel_path: "songs/held/audio.mp3".into(), title: "Held".into(),
            artist: Some("Artist".into()), ..TrackRow::default()
        }).unwrap();
        let words = vec![Some("[00:03.250]Waiting\n".to_string())];
        let missing = TrackMeta { title: "Waiting".into(), artists: vec!["Artist".into()], ..TrackMeta::default() };
        let (entries, pending, _) = imported_entries(&[missing], &words, &import_source::TrackIndex::default());
        let ids = vec!["held".into(), entries[0].clone(), "held".into()];
        let playlist_id = catalog.create_imported_playlist("Mixed", &ids, &pending).unwrap();
        drop(catalog);

        let catalog = Catalog::open(&root).unwrap();
        let exported = playlist_export_list(&catalog, &playlist_id).unwrap();
        let decoded = read_list(encode_list(&exported).unwrap().as_slice()).unwrap();
        assert_eq!(decoded.lyrics_at(0), Some(held_words));
        assert_eq!(decoded.lyrics_at(1), words[0].as_deref());
        assert_eq!(decoded.lyrics_at(2), Some(held_words));

        let downloaded_dir = library::track_dir(&root, "downloaded");
        fs::create_dir_all(&downloaded_dir).unwrap();
        catalog.upsert_track(&TrackRow {
            id: "downloaded".into(), rel_path: "songs/downloaded/audio.mp3".into(),
            title: "Waiting".into(), artist: Some("Artist".into()), ..TrackRow::default()
        }).unwrap();
        resolve_imported(&catalog).unwrap();
        assert_eq!(fs::read_to_string(downloaded_dir.join("lyrics.lrc")).unwrap(), words[0].as_deref().unwrap());
        assert_eq!(catalog.track("downloaded").unwrap().unwrap().lyrics_path.as_deref(), Some("songs/downloaded/lyrics.lrc"));
        assert_eq!(catalog.playlist_entries(&playlist_id).unwrap(), ["held", "downloaded", "held"]);
        assert!(catalog.pending_tracks(&playlist_id).unwrap().is_empty());
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn songs_only_import_restores_before_completion_without_overwriting() {
        let root = std::env::temp_dir().join(format!("wave-transfer-{}", crate::identity::new_id()));
        let catalog = Catalog::open(&root).unwrap();
        for id in ["held", "downloaded"] {
            fs::create_dir_all(library::track_dir(&root, id)).unwrap();
        }
        let original = "[00:01]Destination lyrics";
        fs::write(library::lyrics_path(&root, "held"), original).unwrap();
        catalog.upsert_track(&TrackRow {
            id: "held".into(), rel_path: "songs/held/audio.mp3".into(),
            title: "Held".into(), artist: Some("Artist".into()), ..TrackRow::default()
        }).unwrap();
        let tracks = ["Held", "New"].map(|title| TrackMeta {
            title: title.into(), artists: vec!["Artist".into()], ..TrackMeta::default()
        });
        let words = [Some("[00:02]Exported held".into()), Some("[00:03]Exported new".into())];
        let mut report = Reporter::quiet();
        let outcome = import_songs(&catalog, &tracks, &words, &mut report, |_, meta| {
            catalog.upsert_track(&TrackRow {
                id: "downloaded".into(), rel_path: "songs/downloaded/audio.mp3".into(),
                title: meta.title.clone(), artist: Some("Artist".into()), ..TrackRow::default()
            }).unwrap();
            Ok(import::Landed { id: "downloaded".into(), duplicate: false, similar: false, cover: false, lyrics: false })
        }, |id| {
            assert_eq!(fs::read_to_string(library::lyrics_path(&root, id)).unwrap(), "[00:03]Exported new");
            import::Complete::default()
        }).unwrap();
        assert_eq!(outcome.lyrics, 1);
        assert!(outcome.errors.is_empty());
        assert_eq!(fs::read_to_string(library::lyrics_path(&root, "held")).unwrap(), original);
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
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
            imported_entries(&tracks, &[], &import_source::catalog_index(&catalog).unwrap());
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
        let (entries, pending, _) = imported_entries(&list().tracks, &[], &import_source::TrackIndex::default());
        let id = catalog.create_imported_playlist("Imported", &entries, &pending).unwrap();
        catalog.remove_from_playlist(&id, &entries).unwrap();
        assert!(catalog.pending_tracks(&id).unwrap().is_empty());
        assert!(catalog.playlist_entries(&id).unwrap().is_empty());
    }

    #[test]
    fn songs_only_import_reuses_and_downloads_without_creating_a_playlist() {
        let catalog = Catalog::in_memory().unwrap();
        catalog.upsert_track(&TrackRow {
            id: "held".into(), rel_path: "held.mp3".into(), title: "Song".into(),
            artist: Some("Artist".into()), album: Some("Album".into()), ..TrackRow::default()
        }).unwrap();
        let mut tracks = list().tracks;
        tracks.push(TrackMeta {
            title: "New".into(), artists: vec!["Artist".into()], ..TrackMeta::default()
        });
        tracks.push(tracks[1].clone());
        tracks.push(TrackMeta {
            title: "Failed".into(), artists: vec!["Artist".into()], ..TrackMeta::default()
        });
        let mut fetched = Vec::new();
        let mut report = Reporter::quiet();
        let outcome = import_songs(&catalog, &tracks, &[], &mut report, |_, meta| {
            fetched.push(meta.title.clone());
            if meta.title == "Failed" {
                return Err("offline".into());
            }
            catalog.upsert_track(&TrackRow {
                id: "new".into(), rel_path: "new.mp3".into(), title: meta.title.clone(),
                artist: Some("Artist".into()), ..TrackRow::default()
            }).unwrap();
            Ok(import::Landed { id: "new".into(), duplicate: false, similar: false, cover: false, lyrics: false })
        }, |_| import::Complete::default()).unwrap();
        assert_eq!(fetched, ["New", "Failed"]);
        assert_eq!((outcome.songs, outcome.duplicates, outcome.errors.len()), (1, 2, 1));
        assert!(outcome.playlist.is_none());
        assert!(catalog.playlists().unwrap().is_empty());
    }

}
