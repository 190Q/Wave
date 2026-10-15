use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::{ItemKey, TagExt, TaggedFileExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::download;
use crate::import::{self, ImportOutcome};
use crate::library::{self, TrackPaths, IMAGES_DIR, LYRICS_DIR, SONGS_DIR};
use crate::playlists;
use crate::progress::Reporter;
use crate::spotify::{self, TrackMeta};
use crate::state::Store;

const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
pub const PROGRESS_EVENT: &str = "wavelist-import";
static NEXT_JOB: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WaveList {
    format: String,
    version: u32,
    name: String,
    tracks: Vec<Entry>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    meta: TrackMeta,
    cover: Option<Vec<u8>>,
    synced_lyrics: Option<String>,
    plain_lyrics: Option<String>,
}

impl WaveList {
    fn validate(&self) -> Result<(), String> {
        if self.format != "wave-playlist" || self.version != 1 {
            return Err("This is not a supported Wave playlist export.".into());
        }
        if self.name.trim().is_empty() || self.name.len() > 1024
            || self.tracks.is_empty() || self.tracks.len() > 10_000
        {
            return Err("The export needs a name and between 1 and 10,000 songs.".into());
        }
        for entry in &self.tracks {
            if entry.meta.title.trim().is_empty() || entry.meta.title.len() > 4096
                || entry.cover.as_ref().is_some_and(|bytes| bytes.len() > 8 * 1024 * 1024)
                || [&entry.synced_lyrics, &entry.plain_lyrics].iter()
                    .any(|text| text.as_ref().is_some_and(|text| text.len() > 2 * 1024 * 1024))
            {
                return Err("The export contains an invalid song or oversized asset.".into());
            }
        }
        Ok(())
    }
}

fn read(path: &Path) -> Result<WaveList, String> {
    let file = fs::File::open(path).map_err(|e| format!("Could not open the export: {e}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("The playlist export is too large (maximum 128 MB).".into());
    }
    let list: WaveList = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Could not read the Wave playlist export: {e}"))?;
    list.validate()?;
    Ok(list)
}

fn export(app: &AppHandle, path: &Path, name: String, ids: &[String]) -> Result<usize, String> {
    let paths = app.state::<TrackPaths>();
    let tracks: HashMap<_, _> = library::scan(app, &paths).tracks.into_iter()
        .map(|track| (track.id.clone(), track)).collect();
    let mut entries = Vec::new();
    for id in ids {
        let track = tracks.get(id).ok_or("A selected song is no longer in the library.")?;
        let tagged = lofty::read_from_path(&track.path).map_err(|e| e.to_string())?;
        let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
        let cover = match &track.artwork_path {
            Some(path) => Some(fs::read(path).map_err(|e| format!("Could not read a cover: {e}"))?),
            None => tag.and_then(|tag| tag.pictures().first()).map(|pic| pic.data().to_vec()),
        };
        let synced_lyrics = match &track.lyrics_path {
            Some(path) => Some(fs::read_to_string(path).map_err(|e| format!("Could not read lyrics: {e}"))?),
            None => fs::read_to_string(Path::new(&track.path).with_extension("lrc")).ok(),
        };
        entries.push(Entry {
            meta: TrackMeta {
                title: track.title.clone(),
                artists: track.artist.clone().into_iter().collect(),
                album: track.album.clone().unwrap_or_default(),
                album_artist: track.album_artist.clone().unwrap_or_default(),
                release_date: track.year.map(|year| year.to_string()).unwrap_or_default(),
                track_number: track.track_no,
                disc_number: track.disc_no,
                genres: track.genre.clone().into_iter().collect(),
                isrc: tag.and_then(|tag| tag.get_string(ItemKey::Isrc)).unwrap_or_default().into(),
                ..TrackMeta::default()
            },
            cover,
            synced_lyrics,
            plain_lyrics: tag.and_then(|tag| tag.get_string(ItemKey::UnsyncLyrics)).map(str::to_string),
        });
    }
    let list = WaveList { format: "wave-playlist".into(), version: 1, name, tracks: entries };
    list.validate()?;
    let bytes = serde_json::to_vec(&list).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("The playlist export exceeds 128 MB. Export a smaller collection.".into());
    }
    fs::write(path, bytes).map_err(|e| format!("Could not save the export: {e}"))?;
    Ok(list.tracks.len())
}

fn key(title: &str, artist: &str, album: &str) -> String {
    [title, artist, album].map(|part| part.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()).join("\u{1}")
}

fn unique_playlist(name: &str, exists: impl Fn(&str) -> bool) -> String {
    let base = spotify::sanitize(name).trim_end_matches('.').to_string();
    let mut candidate = base.clone();
    let mut suffix = 2;
    while exists(&candidate) {
        candidate = format!("{base} ({suffix})");
        suffix += 1;
    }
    candidate
}

fn restore(entry: &Entry, root: &Path, relative: &str) -> Result<(usize, usize), String> {
    let mut index = library::read_index(root);
    let stem = library::song_stem(relative);
    let mut images = 0;
    let mut lyrics = 0;
    if let Some(bytes) = &entry.cover {
        let extension = if bytes.starts_with(b"\x89PNG") { "png" } else { "jpg" };
        let image = format!("{IMAGES_DIR}/{stem}.{extension}");
        fs::write(root.join(&image), bytes).map_err(|e| e.to_string())?;
        index.songs.insert(relative.into(), image);
        images = 1;
    }
    if let Some(text) = &entry.synced_lyrics {
        let lyric = format!("{LYRICS_DIR}/{stem}.lrc");
        fs::write(root.join(&lyric), text).map_err(|e| e.to_string())?;
        index.lyrics.insert(relative.into(), lyric);
        lyrics = 1;
    }
    library::write_index(root, &index)?;
    // The downloader already writes metadata/genres. Restore portable tag assets too.
    if entry.cover.is_some() || entry.plain_lyrics.is_some() {
        let song = root.join(relative);
        let mut tag = {
            let tagged = lofty::read_from_path(&song).map_err(|e| e.to_string())?;
            tagged.primary_tag().or_else(|| tagged.first_tag()).cloned()
                .ok_or("The downloaded song has no tags.")?
        };
        if let Some(text) = &entry.plain_lyrics {
            tag.insert_text(ItemKey::UnsyncLyrics, text.clone());
        }
        if let Some(bytes) = &entry.cover {
            let mime = if bytes.starts_with(b"\x89PNG") { MimeType::Png } else { MimeType::Jpeg };
            tag.remove_picture_type(PictureType::CoverFront);
            tag.push_picture(Picture::unchecked(bytes.clone()).pic_type(PictureType::CoverFront).mime_type(mime).build());
        }
        tag.save_to_path(&song, WriteOptions::default()).map_err(|e| e.to_string())?;
    }
    Ok((images, lyrics))
}

fn run(app: &AppHandle, path: &Path, report: &mut Reporter) -> Result<ImportOutcome, String> {
    let list = read(path)?;
    let root = library::library_root(app)?;
    let paths = app.state::<TrackPaths>();
    let mut existing: HashMap<String, String> = library::scan(app, &paths).tracks.into_iter()
        .map(|track| (key(&track.title, track.artist.as_deref().unwrap_or_default(), track.album.as_deref().unwrap_or_default()), track.relative_path)).collect();
    let missing = list.tracks.iter().any(|entry| !existing.contains_key(&key(&entry.meta.title, &entry.meta.artists.join(", "), &entry.meta.album)));
    let tools = if missing { Some(download::resolve_tools(&spotify::read_env(app))?) } else { None };
    let job = format!("{}-{}", spotify::now_ms(), NEXT_JOB.fetch_add(1, Ordering::Relaxed));
    let staging = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("transfer").join(&job);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let result = (|| {
        report.phase("downloading", "Downloading audio directly. Spotify is not needed.");
        report.count(list.tracks.len());
        let mut files = Vec::new();
        let mut assets = Vec::new();
        for (position, entry) in list.tracks.iter().enumerate() {
            let label = entry.meta.title.clone();
            report.at(position + 1, &label);
            let track_key = key(&entry.meta.title, &entry.meta.artists.join(", "), &entry.meta.album);
            if let Some(relative) = existing.get(&track_key) {
                files.push(relative.clone());
                assets.push((entry, relative.clone()));
                report.reuse();
                continue;
            }
            // Names never come from paths in the document, and never overwrite library files.
            let stem = format!("wave-{job}-{position}");
            let mut meta = entry.meta.clone();
            meta.cover_url = None;
            match download::download_named(tools.as_ref().ok_or("Download tools are unavailable.")?, &meta, &staging, &stem) {
                Ok(_) => {
                    let relative = format!("{SONGS_DIR}/{stem}.mp3");
                    existing.insert(track_key, relative.clone());
                    files.push(relative.clone());
                    assets.push((entry, relative));
                }
                Err(error) => report.fail(format!("{label}: {error}")),
            }
        }
        report.phase("importing", "Restoring the playlist, covers and lyrics.");
        let mut outcome = import::import_into_library(app, &staging, false, None)?;
        for (entry, relative) in assets {
            match restore(entry, &root, &relative) {
                Ok((images, lyrics)) => { outcome.images += images; outcome.lyrics += lyrics; }
                Err(error) => report.fail(format!("{}: {error}", entry.meta.title)),
            }
        }
        if !files.is_empty() {
            let name = unique_playlist(&list.name, |name| root.join(library::PLAYLISTS_DIR).join(format!("{name}.json")).exists());
            playlists::write(app, &name, &files)?;
            outcome.playlist = Some(name);
        }
        outcome.errors.extend_from_slice(report.failures());
        import::remember_import(app, "wavelist", &list.name, &outcome);
        library::scan(app, &paths);
        outcome.state = playlists::refresh(app, &app.state::<Store>(), &paths);
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

    fn fixture() -> WaveList {
        WaveList {
            format: "wave-playlist".into(), version: 1, name: "A playlist".into(),
            tracks: vec![Entry {
                meta: TrackMeta { title: "Song".into(), genres: vec!["Rock".into()], ..TrackMeta::default() },
                cover: Some(vec![1, 2, 3]), synced_lyrics: Some("[00:01]Words".into()), plain_lyrics: Some("Words".into()),
            }],
        }
    }

    #[test]
    fn round_trip_keeps_metadata_and_assets() {
        let list: WaveList = serde_json::from_slice(&serde_json::to_vec(&fixture()).unwrap()).unwrap();
        list.validate().unwrap();
        assert_eq!(list.tracks[0].meta.genres, vec!["Rock"]);
        assert_eq!(list.tracks[0].cover, Some(vec![1, 2, 3]));
        assert_eq!(list.tracks[0].plain_lyrics.as_deref(), Some("Words"));
        assert_eq!(list.tracks[0].synced_lyrics.as_deref(), Some("[00:01]Words"));
    }

    #[test]
    fn rejects_unknown_versions_and_invalid_songs() {
        let mut list = fixture();
        list.version = 2;
        assert!(list.validate().is_err());
        list.version = 1;
        list.tracks[0].meta.title.clear();
        assert!(list.validate().is_err());
        list.tracks.clear();
        assert!(list.validate().is_err());
    }

    #[test]
    fn playlist_names_are_safe_and_do_not_replace_existing_ones() {
        assert_eq!(unique_playlist("../Rock", |_| false), ".._Rock");
        assert_eq!(unique_playlist("Rock", |name| name == "Rock" || name == "Rock (2)"), "Rock (3)");
    }

    #[test]
    fn duplicate_matching_preserves_artist_and_album_identity() {
        assert_eq!(key("  SONG ", "Artist", " Album"), key("song", "artist", "album"));
        assert_ne!(key("Song", "A", "Album"), key("Song", "B", "Album"));
    }
}
