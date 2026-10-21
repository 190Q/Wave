use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::catalog::Catalog;
use crate::download;
use crate::import::{self, ImportOutcome};
use crate::import_source;
use crate::library;
use crate::playlists;
use crate::progress::Reporter;
use crate::source::{now_ms, read_env, TrackMeta};
use crate::state::{PersistedState, Store};

const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;

const VERSION: u32 = 2;

pub const PROGRESS_EVENT: &str = "wavelist-import";
static NEXT_JOB: AtomicU64 = AtomicU64::new(0);

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

fn export(app: &AppHandle, path: &Path, name: String, ids: &[String]) -> Result<usize, String> {
    let catalog = app.state::<Catalog>();
    let tracks: HashMap<_, _> = library::scan(app, &catalog)
        .tracks
        .into_iter()
        .map(|track| (track.id.clone(), track))
        .collect();

    let mut entries = Vec::with_capacity(ids.len());
    for id in ids {
        let track = tracks
            .get(id)
            .ok_or("A selected song is no longer in the library.")?;
        entries.push(TrackMeta {
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
        });
    }

    let list = WaveList {
        format: "wave-playlist".into(),
        version: VERSION,
        name,
        tracks: entries,
    };
    list.validate()?;

    let bytes = serde_json::to_vec(&list).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("The playlist export is too large to save.".into());
    }
    fs::write(path, bytes).map_err(|e| format!("Could not save the export: {e}"))?;
    Ok(list.tracks.len())
}

fn staging_dir(app: &AppHandle, job: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("transfer")
        .join(job);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn run(app: &AppHandle, path: &Path, report: &mut Reporter) -> Result<ImportOutcome, String> {
    let list = read(path)?;
    let catalog = app.state::<Catalog>();

    let existing = import_source::catalog_index(&catalog)?;

    // The download tools are only needed for the songs the library is missing.
    let wanted = list
        .tracks
        .iter()
        .any(|meta| import_source::held(&existing, meta).is_none());
    let tools = if wanted {
        Some(download::resolve_tools(&read_env(app))?)
    } else {
        None
    };

    let job = format!("{}-{}", now_ms(), NEXT_JOB.fetch_add(1, Ordering::Relaxed));
    let staging = staging_dir(app, &job)?;

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
                &staging.join(position.to_string()),
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
            errors: Vec::new(),
            state: PersistedState::default(),
        };

        let playlist: Vec<String> = ids.into_iter().flatten().collect();
        if !playlist.is_empty() {
            outcome.playlist = Some(playlists::write(app, &list.name, &playlist)?);
        }

        outcome.errors.extend_from_slice(report.failures());
        import::remember_import(app, "wavelist", &list.name, &outcome);
        library::scan(app, &catalog);
        outcome.state = playlists::refresh(app, &app.state::<Store>());
        Ok(outcome)
    })();

    let _ = fs::remove_dir_all(&staging);
    result
}

#[tauri::command]
pub async fn export_wavelist(app: AppHandle, path: String, name: String, track_ids: Vec<String>) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || export(&app, Path::new(&path), name, &track_ids))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_wavelist(app: AppHandle, path: String) -> Result<ImportOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut report = Reporter::new(&app, PROGRESS_EVENT);
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

}
