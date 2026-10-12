use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use lofty::file::FileType;
use lofty::prelude::{Accessor, AudioFile, ItemKey, TaggedFileExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::state::Store;

/// Extensions treated as music. `mp4`/`m4v` are deliberately absent.
pub const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "m4a", "m4b", "aac", "ogg", "opus", "wav", "aiff", "aif", "wma",
];

/// Extensions treated as artwork.
pub const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "bmp"];
pub const SOURCE_ARTWORK_DIR: &str = "images";

/// Extensions treated as lyrics.
pub const LYRICS_EXTENSIONS: &[&str] = &["lrc"];
pub const SOURCE_LYRICS_DIR: &str = "lyrics";

pub const SONGS_DIR: &str = "songs";
pub const IMAGES_DIR: &str = "images";
pub const LYRICS_DIR: &str = "lyrics";
pub const PLAYLISTS_DIR: &str = "playlists";
pub const CONFIG_DIR: &str = "config";
pub const INDEX_FILE: &str = "index.json";

/// Song path relative to the library root, mapped to the relative paths of its
/// sidecars.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct LibraryIndex {
    #[serde(default)]
    pub songs: HashMap<String, String>,
    #[serde(default)]
    pub lyrics: HashMap<String, String>,
}

#[derive(Default)]
pub struct TrackPaths(pub Mutex<HashMap<String, String>>);

impl TrackPaths {
    pub fn ids_to_files(&self, track_ids: &[String]) -> Vec<String> {
        let guard = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        track_ids
            .iter()
            .filter_map(|id| guard.get(id).cloned())
            .collect()
    }

    /// A copy of the whole map, for resolving every playlist file at once.
    pub fn ids_to_file_map(&self) -> HashMap<String, String> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub path: String,
    pub relative_path: String,
    pub title: String,
    /// `None` when the file carries no artist tag.
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track_no: Option<u32>,
    pub disc_no: Option<u32>,
    pub year: Option<u16>,
    pub genre: Option<String>,
    pub duration_ms: u64,
    pub codec: String,
    pub bitrate: Option<u32>,
    pub sample_rate: Option<u32>,
    /// Copied sidecar image if the index has one, otherwise extracted tag art.
    pub artwork_path: Option<String>,
    /// Copied sidecar lyrics if the index has one.
    pub lyrics_path: Option<String>,
    pub has_embedded_art: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub tracks: Vec<Track>,
    pub root: String,
    /// Files in the songs folder that were deliberately not read.
    pub skipped: usize,
    pub errors: Vec<String>,
}

pub fn library_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data directory: {e}"))?
        .join("library");

    for dir in [SONGS_DIR, IMAGES_DIR, LYRICS_DIR, PLAYLISTS_DIR, CONFIG_DIR] {
        let path = root.join(dir);
        fs::create_dir_all(&path).map_err(|e| format!("could not create {}: {e}", path.display()))?;
    }

    Ok(root)
}

pub fn read_index(root: &Path) -> LibraryIndex {
    fs::read_to_string(root.join(CONFIG_DIR).join(INDEX_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn write_index(root: &Path, index: &LibraryIndex) -> Result<(), String> {
    let json = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    let path = root.join(CONFIG_DIR).join(INDEX_FILE);
    fs::write(&path, json).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Lookup table for the sidecar files in an imported folder. Covers and lyrics
/// are matched the same way, so one index serves both.
#[derive(Default)]
pub struct SidecarIndex {
    /// Keyed by the song part of `artist - song.ext`.
    by_song: HashMap<String, PathBuf>,
    /// Keyed by the whole lowercased file stem.
    by_stem: HashMap<String, PathBuf>,
}

impl SidecarIndex {
    pub fn build(dir: &Path, extensions: &[&str]) -> Self {
        let mut index = Self::default();
        let Ok(entries) = fs::read_dir(dir) else {
            return index;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || !has_extension(&path, extensions) {
                continue;
            }
            let stem = file_stem_lower(&path);
            if stem.is_empty() {
                continue;
            }
            // Audio files are usually named after the song alone.
            if let Some((_, song)) = stem.split_once(" - ") {
                let song = song.trim();
                if !song.is_empty() {
                    index
                        .by_song
                        .entry(song.to_string())
                        .or_insert_with(|| path.clone());
                }
            }
            index.by_stem.entry(stem).or_insert(path);
        }

        index
    }

    pub fn resolve(&self, title: &str, file_name: &str) -> Option<PathBuf> {
        let title = title.to_lowercase();
        let stem = file_stem_lower(Path::new(file_name));

        for candidate in [title.as_str(), stem.as_str()] {
            if candidate.is_empty() {
                continue;
            }
            if let Some(found) = self.by_song.get(candidate) {
                return Some(found.clone());
            }
            if let Some(found) = self.by_stem.get(candidate) {
                return Some(found.clone());
            }
        }

        None
    }
}

/// Locates a subfolder of an imported folder, matching the name case-insensitively.
pub fn source_subdir(root: &Path, name: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        if is_dir && entry.file_name().to_string_lossy().eq_ignore_ascii_case(name) {
            return Some(entry.path());
        }
    }
    None
}

pub fn scan<R: Runtime>(app: &AppHandle<R>, paths: &TrackPaths) -> ScanSummary {
    let root = match library_root(app) {
        Ok(root) => root,
        Err(error) => {
            return ScanSummary {
                tracks: Vec::new(),
                root: String::new(),
                skipped: 0,
                errors: vec![error],
            };
        }
    };

    let index = read_index(&root);
    let cache = app.path().app_cache_dir().ok().map(|dir| dir.join("artwork"));
    if let Some(dir) = &cache {
        let _ = fs::create_dir_all(dir);
    }

    let mut tracks = Vec::new();
    let mut errors = Vec::new();
    let mut skipped = 0usize;

    let songs = root.join(SONGS_DIR);
    match fs::read_dir(&songs) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                if !has_extension(&path, AUDIO_EXTENSIONS) {
                    skipped += 1;
                    continue;
                }
                match read_track(&path, &root, &index, cache.as_deref()) {
                    Ok(track) => tracks.push(track),
                    Err(error) => errors.push(error),
                }
            }
        }
        Err(error) => errors.push(format!("could not read {}: {error}", songs.display())),
    }

    tracks.sort_by_key(|track| track.title.to_lowercase());

    if let Ok(mut guard) = paths.0.lock() {
        *guard = tracks
            .iter()
            .map(|track| (track.id.clone(), track.relative_path.clone()))
            .collect();
    }

    ScanSummary {
        tracks,
        root: root.to_string_lossy().into_owned(),
        skipped,
        errors,
    }
}

fn read_track(
    path: &Path,
    root: &Path,
    index: &LibraryIndex,
    artwork_cache: Option<&Path>,
) -> Result<Track, String> {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let relative_path = format!("{SONGS_DIR}/{file_name}");
    let id = track_id(&relative_path);

    let tagged = lofty::read_from_path(path).map_err(|e| format!("could not read {file_name}: {e}"))?;

    let properties = tagged.properties();
    let duration_ms = properties.duration().as_millis() as u64;
    let bitrate = properties.audio_bitrate();
    let sample_rate = properties.sample_rate();
    let codec = codec_label(tagged.file_type());

    let mut title: Option<String> = None;
    let mut artist = None;
    let mut album = None;
    let mut album_artist = None;
    let mut track_no = None;
    let mut disc_no = None;
    let mut year = None;
    let mut genre = None;
    let mut embedded: Option<(Vec<u8>, String)> = None;

    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        title = tag.title().map(|value| value.to_string());
        artist = tag.artist().map(|value| value.to_string());
        album = tag.album().map(|value| value.to_string());
        album_artist = tag.get_string(ItemKey::AlbumArtist).map(str::to_string);
        track_no = tag.track();
        disc_no = tag.disk();
        year = tag.date().map(|date| date.year);
        genre = tag.genre().map(|value| value.to_string());

        if let Some(picture) = tag.pictures().first() {
            let extension = picture
                .mime_type()
                .and_then(|mime| mime.ext())
                .unwrap_or("jpg")
                .to_string();
            embedded = Some((picture.data().to_vec(), extension));
        }
    }

    let has_embedded_art = embedded.is_some();

    // An untitled file still needs something to show in a list.
    let title = title
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| file_stem_lower(path));

    let artwork_path = match index.songs.get(&relative_path) {
        Some(relative) => Some(root.join(relative).to_string_lossy().into_owned()),
        None => embedded
            .as_ref()
            .and_then(|(data, extension)| cache_embedded(data, extension, &id, artwork_cache)),
    };

    let lyrics_path = index
        .lyrics
        .get(&relative_path)
        .map(|relative| root.join(relative).to_string_lossy().into_owned());

    Ok(Track {
        id,
        path: path.to_string_lossy().into_owned(),
        relative_path,
        title,
        artist: clean(artist),
        album: clean(album),
        album_artist: clean(album_artist),
        track_no,
        disc_no,
        year,
        genre: clean(genre),
        duration_ms,
        codec,
        bitrate,
        sample_rate,
        artwork_path,
        lyrics_path,
        has_embedded_art,
    })
}

/// Writes embedded art to the cache so it can be served like any other image.
fn cache_embedded(data: &[u8], extension: &str, id: &str, cache: Option<&Path>) -> Option<String> {
    let cache = cache?;
    let target = cache.join(format!("{id}.{extension}"));
    if !target.exists() && fs::write(&target, data).is_err() {
        return None;
    }
    Some(target.to_string_lossy().into_owned())
}

/// Tag values are frequently empty strings; treat those as absent.
fn clean(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.trim().is_empty())
}

pub fn has_extension(path: &Path, allowed: &[&str]) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| allowed.contains(&extension.to_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn file_stem_lower(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default()
        .to_lowercase()
}

/// FNV-1a over the library-relative path, so ids survive the library moving.
fn track_id(relative_path: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in relative_path.to_lowercase().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn codec_label(file_type: FileType) -> String {
    match file_type {
        FileType::Mpeg => "MP3".to_string(),
        FileType::Mp4 | FileType::Aac => "AAC".to_string(),
        FileType::Flac => "FLAC".to_string(),
        FileType::Vorbis => "Vorbis".to_string(),
        FileType::Opus => "Opus".to_string(),
        FileType::Wav => "WAV".to_string(),
        FileType::Aiff => "AIFF".to_string(),
        FileType::Ape => "APE".to_string(),
        FileType::Mpc => "Musepack".to_string(),
        FileType::Speex => "Speex".to_string(),
        FileType::WavPack => "WavPack".to_string(),
        // `FileType` is non-exhaustive, so anything newer lands here.
        other => format!("{other:?}"),
    }
}

#[tauri::command]
pub fn scan_library(
    app: AppHandle,
    store: State<'_, Store>,
    paths: State<'_, TrackPaths>,
) -> ScanSummary {
    let summary = scan(&app, &paths);
    // Playlist files store paths, so they can only be resolved after a scan.
    let _ = crate::playlists::refresh(&app, &store, &paths);
    summary
}
