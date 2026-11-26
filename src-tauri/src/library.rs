use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use lofty::config::WriteOptions;
use lofty::file::FileType;
use lofty::prelude::{Accessor, AudioFile, ItemKey, TagExt, TaggedFileExt};
use lofty::tag::{items::Timestamp, Tag};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};
#[cfg(not(target_os = "android"))]
use tauri_plugin_opener::OpenerExt;

use crate::catalog::{Catalog, TrackRow, LAYOUT_VERSION};
use crate::identity;
use crate::state::{PersistedState, Store};

/// `mp4`/`m4v` are deliberately absent.
pub const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "m4a", "m4b", "aac", "ogg", "opus", "wav", "aiff", "aif", "wma",
];

pub const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "bmp"];
pub const LYRICS_EXTENSIONS: &[&str] = &["lrc"];

/// Where an imported folder keeps its own covers and lyrics, if it does.
pub const SOURCE_ARTWORK_DIR: &str = "images";
pub const SOURCE_LYRICS_DIR: &str = "lyrics";

/// Each song owns a directory named after its id, so nothing is identified by a
/// file name and two songs may share one.
pub const SONGS_DIR: &str = "songs";
pub const CONFIG_DIR: &str = "config";
pub const PENDING_DIR: &str = "pending";

pub const AUDIO_STEM: &str = "audio";
pub const COVER_STEM: &str = "cover";
pub const LYRICS_NAME: &str = "lyrics.lrc";

static ROOT: OnceLock<PathBuf> = OnceLock::new();

pub fn library_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let root = match ROOT.get() {
        Some(root) => root.clone(),
        None => {
            #[cfg(desktop)]
            let shared = crate::dev_library::shared();
            #[cfg(not(desktop))]
            let shared = false;

            #[cfg(desktop)]
            let shared_root = if shared {
                Some(crate::dev_library::installed_data_dir(app)?.join("library"))
            } else {
                None
            };
            #[cfg(not(desktop))]
            let shared_root: Option<PathBuf> = None;

            let resolved = match shared_root {
                Some(root) => root,
                None => app
                    .path()
                    .app_data_dir()
                    .map_err(|e| format!("could not resolve the app data directory: {e}"))?
                    .join("library"),
            };
            if shared && !resolved.join(SONGS_DIR).is_dir() {
                return Err(format!(
                    "the installed Wave library was not found at {}; use npm run tauri dev isolated for a test library",
                    resolved.display()
                ));
            }
            let _ = ROOT.set(resolved.clone());
            resolved
        }
    };

    #[cfg(desktop)]
    if crate::dev_library::shared() {
        return Ok(root);
    }

    for dir in [SONGS_DIR, CONFIG_DIR] {
        let path = root.join(dir);
        fs::create_dir_all(&path).map_err(|e| format!("could not create {}: {e}", path.display()))?;
    }

    Ok(root)
}

pub fn track_dir(root: &Path, id: &str) -> PathBuf {
    root.join(SONGS_DIR).join(id)
}

/// Where the audio goes for a song being written for the first time. An existing
/// song's own `rel_path` is the authority, not this.
pub fn audio_path(root: &Path, id: &str, extension: &str) -> PathBuf {
    track_dir(root, id).join(format!("{AUDIO_STEM}.{extension}"))
}

pub fn cover_path(root: &Path, id: &str, extension: &str) -> PathBuf {
    track_dir(root, id).join(format!("{COVER_STEM}.{extension}"))
}

pub fn lyrics_path(root: &Path, id: &str) -> PathBuf {
    track_dir(root, id).join(LYRICS_NAME)
}

/// Where the cover of a song that is still only a catalogue entry is kept.
pub fn pending_cover_path(root: &Path, id: &str, extension: &str) -> PathBuf {
    root.join(CONFIG_DIR).join(PENDING_DIR).join(format!("{id}.{extension}"))
}

/// A library-relative path, always with forward slashes, which is what the
/// catalog stores.
pub fn relative(root: &Path, path: &Path) -> Option<String> {
    let stripped = path.strip_prefix(root).ok()?;
    Some(stripped.to_string_lossy().replace('\\', "/"))
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
    pub artwork_path: Option<String>,
    pub lyrics_path: Option<String>,
    pub has_embedded_art: bool,
    /// Integrated loudness in LUFS, `None` until the song has been measured.
    pub lufs: Option<f32>,
    /// True peak, linear. `None` until the song has been measured.
    pub peak: Option<f32>,
    pub added_at: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackMetadata {
    title: String,
    artist: Option<String>,
    album: Option<String>,
    album_artist: Option<String>,
    genre: Option<String>,
    year: Option<u16>,
    track_no: Option<u32>,
    disc_no: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditedTrack {
    track: Track,
    previous_path: Option<String>,
    cleanup_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct MetadataCleanup {
    track_id: String,
    previous_path: String,
    updated_path: String,
}

impl TrackMetadata {
    fn from_row(row: &TrackRow) -> Self {
        Self {
            title: row.title.clone(),
            artist: row.artist.clone(),
            album: row.album.clone(),
            album_artist: row.album_artist.clone(),
            genre: row.genre.clone(),
            year: row.year,
            track_no: row.track_no,
            disc_no: row.disc_no,
        }
    }

    fn validate(mut self) -> Result<Self, String> {
        self.title = self.title.trim().to_string();
        if self.title.is_empty() {
            return Err("Enter a title.".to_string());
        }
        let trim = |value: Option<String>| {
            value.map(|text| text.trim().to_string()).filter(|text| !text.is_empty())
        };
        self.artist = trim(self.artist);
        self.album = trim(self.album);
        self.album_artist = trim(self.album_artist);
        self.genre = trim(self.genre);
        if self.year.is_some_and(|year| year == 0 || year > 9999) {
            return Err("The year must be between 1 and 9999.".to_string());
        }
        if [self.track_no, self.disc_no].into_iter().flatten().any(|n| n == 0 || n > 65535) {
            return Err("Track and disc numbers must be between 1 and 65535.".to_string());
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub changed: Vec<Track>,
    pub removed: Vec<String>,
    pub total: usize,
    pub root: String,
    pub skipped: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    pub format_version: u32,
    pub tracks: usize,
    /// Songs whose audio is gone, whose likes, playlists and history are kept.
    pub missing: usize,
    pub db_bytes: u64,
}

/// Every song the library holds, in title order, which is the listing the
/// window draws.
pub fn all_tracks<R: Runtime>(app: &AppHandle<R>, catalog: &Catalog) -> Result<Vec<Track>, String> {
    let root = library_root(app)?;
    let mut tracks: Vec<Track> = catalog
        .tracks()?
        .iter()
        .map(|row| to_track(row, &root))
        .collect();
    tracks.sort_by_key(|track| track.title.to_lowercase());
    Ok(tracks)
}

pub fn scan<R: Runtime>(app: &AppHandle<R>, catalog: &Catalog, full: bool) -> ScanSummary {
    sweep(app, catalog, full, false)
}

pub fn reread<R: Runtime>(app: &AppHandle<R>, catalog: &Catalog) -> ScanSummary {
    sweep(app, catalog, false, true)
}

fn sweep<R: Runtime>(
    app: &AppHandle<R>,
    catalog: &Catalog,
    full: bool,
    reread: bool,
) -> ScanSummary {
    let root = match library_root(app) {
        Ok(root) => root,
        Err(error) => {
            let root = catalog.root();
            let tracks = if full {
                catalog.tracks().unwrap_or_default()
                    .iter()
                    .map(|row| to_track(row, root))
                    .collect()
            } else {
                Vec::new()
            };
            return ScanSummary {
                changed: tracks,
                removed: Vec::new(),
                total: catalog.present_count().unwrap_or(0),
                root: root.to_string_lossy().into_owned(),
                skipped: 0,
                errors: vec![error],
            };
        }
    };

    sweep_root(&root, catalog, full, reread)
}

fn sweep_root(root: &Path, catalog: &Catalog, full: bool, reread: bool) -> ScanSummary {
    let _operation = catalog.library_operation();
    let known = match catalog.rows_by_id() {
        Ok(known) => known,
        Err(error) => {
            return ScanSummary {
                changed: Vec::new(),
                removed: Vec::new(),
                total: 0,
                root: root.to_string_lossy().into_owned(),
                skipped: 0,
                errors: vec![error],
            };
        }
    };

    let mut errors = Vec::new();
    let mut changed: Vec<TrackRow> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut skipped = 0usize;
    let mut incomplete = false;

    let songs = root.join(SONGS_DIR);
    match fs::read_dir(&songs) {
        Ok(entries) => {
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => {
                        errors.push(format!("could not read {}: {error}", songs.display()));
                        incomplete = true;
                        continue;
                    }
                };
                let path = entry.path();
                let is_dir = match entry.file_type() {
                    Ok(kind) => kind.is_dir(),
                    Err(error) => {
                        errors.push(format!("could not read {}: {error}", path.display()));
                        incomplete = true;
                        continue;
                    }
                };

                if !is_dir {
                    if has_extension(&path, AUDIO_EXTENSIONS) {
                        errors.push(format!(
                            "{} is not in a song folder yet; restart Wave to finish filing the library",
                            entry.file_name().to_string_lossy()
                        ));
                    } else {
                        skipped += 1;
                    }
                    continue;
                }

                match reconcile(&path, root, &known, &mut errors, reread) {
                    Ok(Some((row, moved))) => {
                        seen.push(row.id.clone());
                        if moved || full {
                            changed.push(row);
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        errors.push(error);
                        incomplete = true;
                    }
                }
            }
        }
        Err(error) => {
            errors.push(format!("could not read {}: {error}", songs.display()));
            incomplete = true;
        }
    }

    // A song the scan did not see is gone, which is the one change that has to
    // be worked out for every row rather than only the rows the scan touched.
    let present: HashSet<&str> = seen.iter().map(String::as_str).collect();
    let mut removed: Vec<String> = known
        .values()
        .filter(|row| !row.missing && !present.contains(row.id.as_str()))
        .map(|row| row.id.clone())
        .collect();
    removed.sort();

    if !incomplete {
        let known_ids: Vec<String> = known.keys().cloned().collect();
        if let Err(error) = catalog.sync_scan(&changed, &seen, &known_ids) {
            errors.push(error);
            incomplete = true;
        }
    }
    if incomplete {
        changed = if full {
            match catalog.tracks() {
                Ok(rows) => rows,
                Err(error) => {
                    errors.push(error);
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };
        removed.clear();
    }

    let total = if incomplete {
        catalog.present_count().unwrap_or(0)
    } else {
        seen.len()
    };
    let mut tracks: Vec<Track> = changed.iter().map(|row| to_track(row, root)).collect();
    tracks.sort_by_key(|track| track.title.to_lowercase());

    ScanSummary {
        changed: tracks,
        removed,
        total,
        root: root.to_string_lossy().into_owned(),
        skipped,
        errors,
    }
}

/// Brings one song's directory in line with the catalog, or returns `None` when
/// the directory holds no audio. The flag says whether the row actually moved,
/// so a scan only writes what changed.
fn reconcile(
    dir: &Path,
    root: &Path,
    known_rows: &HashMap<String, TrackRow>,
    errors: &mut Vec<String>,
    reread: bool,
) -> Result<Option<(TrackRow, bool)>, String> {
    let dir_name = dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();

    let named_as_id = identity::is_id(&dir_name);
    let known = if named_as_id {
        known_rows.get(&dir_name)
    } else {
        None
    };

    // The file the catalog recorded, or the only audio file in the directory,
    // which covers a file renamed by hand.
    let recorded = known
        .map(|row| root.join(&row.rel_path))
        .filter(|path| path.is_file());

    let audio_name = match &recorded {
        Some(path) => path.file_name().map(OsString::from).unwrap_or_default(),
        None => {
            let found = audio_files(dir)?;
            if found.len() > 1 {
                errors.push(format!(
                    "{} holds more than one audio file; {} was used",
                    dir.display(),
                    found[0].to_string_lossy()
                ));
            }
            match found.into_iter().next() {
                Some(name) => name,
                None => return Ok(None),
            }
        }
    };

    let (id, dir) = if named_as_id {
        (dir_name, dir.to_path_buf())
    } else {
        let id = identity::new_id();
        let target = track_dir(root, &id);
        if target.exists() {
            return Err(format!(
                "{} is already taken, so {} was left alone",
                target.display(),
                dir.display()
            ));
        }
        fs::rename(dir, &target)
            .map_err(|e| format!("could not rename {}: {e}", dir.display()))?;
        (id, target)
    };

    let audio = dir.join(&audio_name);
    let rel_path = relative(root, &audio)
        .ok_or_else(|| format!("{} is outside the library", audio.display()))?;
    let stamp = identity::stamp_of(&audio)?;

    // An explicit tag refresh bypasses the unchanged-file shortcut.
    let unchanged = !reread
        && known.is_some_and(|row| {
            row.rel_path == rel_path
                && row.bytes == stamp.bytes
                && row.modified_ms == stamp.modified_ms
        });

    if unchanged {
        let source = known.expect("checked just above");
        let mut row = source.clone();
        let cover = kept(root, row.cover_path.clone(), &dir, cover_in);
        let lyrics = kept(root, row.lyrics_path.clone(), &dir, lyrics_in);
        let moved = source.missing || cover != row.cover_path || lyrics != row.lyrics_path;
        row.cover_path = cover;
        row.lyrics_path = lyrics;
        row.missing = false;
        return Ok(Some((row, moved)));
    }

    let original_name = known
        .map(|row| row.original_name.clone())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| {
            audio
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        });

    let mut row = read_row(&id, &audio, &dir, &rel_path, &original_name, stamp, None)?;
    if let Some(previous) = known {
        row.added_at = previous.added_at;
        row.lufs = previous.lufs;
        row.peak = previous.peak;
        row.loudness_bytes = previous.loudness_bytes;
    }
    Ok(Some((row, true)))
}

/// Describes a song that has just been written into the library, so the catalog
/// records what is on disk: tags, hash, and whatever sits beside it.
pub fn describe(
    root: &Path,
    id: &str,
    audio: &Path,
    original_name: &str,
    hash: Option<&str>,
) -> Result<TrackRow, String> {
    let dir = audio
        .parent()
        .ok_or_else(|| format!("{} has no folder", audio.display()))?;
    let rel_path = relative(root, audio)
        .ok_or_else(|| format!("{} is outside the library", audio.display()))?;
    let stamp = identity::stamp_of(audio)?;

    read_row(
        id,
        audio,
        dir,
        &rel_path,
        original_name,
        stamp,
        hash.map(str::to_string),
    )
}

fn read_row(
    id: &str,
    audio: &Path,
    dir: &Path,
    rel_path: &str,
    original_name: &str,
    stamp: identity::Stamp,
    hash: Option<String>,
) -> Result<TrackRow, String> {
    let file_name = audio
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tagged = if audio.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("ogg")) {
        lofty::probe::Probe::open(audio)
            .and_then(|probe| probe.guess_file_type().map_err(Into::into))
            .and_then(|probe| probe.read())
    } else {
        lofty::read_from_path(audio)
    }
    .map_err(|e| format!("could not read {file_name}: {e}"))?;

    let properties = tagged.properties();
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

    let (title, artist) = name_of(title, artist, original_name, audio);

    // Art inside the file is written out beside it, so a cover lives with the
    // song rather than in a cache that can be cleared.
    let cover = cover_in(dir).or_else(|| {
        embedded
            .as_ref()
            .and_then(|(data, extension)| write_cover(dir, data, extension))
    });

    let content_hash = match hash {
        Some(hash) => hash,
        None => identity::content_hash(audio)?,
    };

    Ok(TrackRow {
        id: id.to_string(),
        rel_path: rel_path.to_string(),
        original_name: original_name.to_string(),
        bytes: stamp.bytes,
        modified_ms: stamp.modified_ms,
        content_hash: Some(content_hash),
        title,
        artist,
        album: clean(album),
        album_artist: clean(album_artist),
        track_no,
        disc_no,
        year,
        genre: clean(genre),
        duration_ms: properties.duration().as_millis() as u64,
        codec: codec_label(tagged.file_type()),
        bitrate: properties.audio_bitrate(),
        sample_rate: properties.sample_rate(),
        has_embedded_art,
        cover_path: cover.as_deref().and_then(|path| relative_owned(path, dir)),
        lyrics_path: lyrics_in(dir).as_deref().and_then(|path| relative_owned(path, dir)),
        // Left to the measuring pass.
        lufs: None,
        peak: None,
        loudness_bytes: None,
        missing: false,
        added_at: identity::now_ms(),
        updated_at: identity::now_ms(),
    })
}

fn relative_owned(path: &Path, dir: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy();
    let id = dir.file_name()?.to_string_lossy();
    Some(format!("{SONGS_DIR}/{id}/{name}"))
}

/// Best candidate first: the name the importer writes, so a stray extra file
/// cannot take a song's place.
fn audio_files(dir: &Path) -> Result<Vec<OsString>, String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("could not read {}: {e}", dir.display()))?;

    let mut found: Vec<OsString> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("could not read {}: {e}", dir.display()))?;
        let path = entry.path();
        let kind = fs::metadata(&path)
            .map_err(|e| format!("could not read {}: {e}", path.display()))?;
        if kind.is_file() && has_extension(&path, AUDIO_EXTENSIONS) {
            found.push(entry.file_name());
        }
    }

    found.sort_by_key(|name| {
        let text = name.to_string_lossy().to_lowercase();
        (u8::from(!text.starts_with(AUDIO_STEM)), text)
    });
    Ok(found)
}

/// A path the catalog recorded and that is still there stands; otherwise
/// whatever is beside the song now is taken, so a copy added or deleted by hand
/// is noticed.
fn kept(
    root: &Path,
    recorded: Option<String>,
    dir: &Path,
    find: impl Fn(&Path) -> Option<PathBuf>,
) -> Option<String> {
    if let Some(relative) = recorded {
        if root.join(&relative).is_file() {
            return Some(relative);
        }
    }

    find(dir).as_deref().and_then(|path| relative_owned(path, dir))
}

pub(crate) fn cover_in(dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    entries.flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_cover_file(path))
        .max_by_key(|path| {
            let stem = file_stem_lower(path);
            (stem != COVER_STEM, stem)
        })
}

pub(crate) fn is_cover_file(path: &Path) -> bool {
    let stem = file_stem_lower(path);
    let versioned = stem.strip_prefix("cover-").is_some_and(|version| {
        version.split_once('-').is_some_and(|(stamp, id)| {
            stamp.len() == 20 && stamp.bytes().all(|byte| byte.is_ascii_digit()) && identity::is_id(id)
        })
    });
    has_extension(path, IMAGE_EXTENSIONS) && (stem == COVER_STEM || versioned)
}

pub(crate) fn replace_cover(
    root: &Path,
    catalog: &Catalog,
    track_id: &str,
    bytes: &[u8],
) -> Result<Track, String> {
    let _operation = catalog.library_operation();
    let mut row = catalog.track(track_id)?
        .filter(|row| !row.missing)
        .ok_or_else(|| "That song is no longer in the library.".to_string())?;
    let format = image::guess_format(bytes)
        .map_err(|_| "Choose a valid JPEG, PNG, WebP, GIF or BMP image.".to_string())?;
    let extension = match format {
        image::ImageFormat::Jpeg => "jpg",
        image::ImageFormat::Png => "png",
        image::ImageFormat::WebP => "webp",
        image::ImageFormat::Gif => "gif",
        image::ImageFormat::Bmp => "bmp",
        _ => return Err("Choose a valid JPEG, PNG, WebP, GIF or BMP image.".to_string()),
    };
    image::load_from_memory_with_format(bytes, format)
        .map_err(|e| format!("Could not read the selected image: {e}"))?;

    let dir = track_dir(root, &row.id);
    if !root.join(&row.rel_path).is_file() || !dir.is_dir() {
        return Err("That song is no longer in the library.".to_string());
    }
    let previous_stamp = row.cover_path.as_deref()
        .and_then(|path| Path::new(path).file_stem())
        .and_then(|stem| stem.to_str())
        .and_then(|stem| stem.strip_prefix("cover-"))
        .and_then(|version| version.split_once('-'))
        .and_then(|(stamp, _)| stamp.parse::<i64>().ok())
        .unwrap_or(0);
    let stamp = identity::now_ms().max(previous_stamp.saturating_add(1)).max(0);
    let target = dir.join(format!(
        "cover-{:020}-{}.{}",
        stamp,
        identity::new_id(),
        extension
    ));
    let staged = target.with_extension("tmp");
    if let Err(error) = fs::write(&staged, bytes).and_then(|()| fs::rename(&staged, &target)) {
        let _ = fs::remove_file(&staged);
        return Err(format!("Could not save the cover: {error}"));
    }
    let relative = relative(root, &target).ok_or_else(|| "Could not locate the cover.".to_string())?;
    if let Err(error) = catalog.set_cover(&row.id, Some(&relative)) {
        let _ = fs::remove_file(&target);
        return Err(error);
    }
    if let Some(previous) = row.cover_path.as_deref().map(|path| root.join(path)) {
        if previous.parent() == Some(dir.as_path()) && is_cover_file(&previous) {
            let _ = fs::remove_file(previous);
        }
    }
    row.cover_path = Some(relative);
    Ok(to_track(&row, root))
}

pub(crate) fn lyrics_in(dir: &Path) -> Option<PathBuf> {
    fs::read_dir(dir).ok()?.flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            if !path.is_file() || !has_extension(path, LYRICS_EXTENSIONS) {
                return false;
            }
            let stem = file_stem_lower(path);
            stem == "lyrics" || stem.strip_prefix("lyrics-").is_some_and(|version| {
                version.split_once('-').is_some_and(|(stamp, id)| {
                    stamp.len() == 20 && stamp.bytes().all(|byte| byte.is_ascii_digit()) && identity::is_id(id)
                })
            })
        })
        .max_by_key(|path| file_stem_lower(path))
}

fn write_cover(dir: &Path, data: &[u8], extension: &str) -> Option<PathBuf> {
    let target = dir.join(format!("{COVER_STEM}.{extension}"));
    if target.exists() {
        return Some(target);
    }
    fs::write(&target, data).ok()?;
    Some(target)
}

pub fn to_track(row: &TrackRow, root: &Path) -> Track {
    let path = root.join(&row.rel_path);
    Track {
        id: row.id.clone(),
        path: path.to_string_lossy().into_owned(),
        relative_path: row.rel_path.clone(),
        title: row.title.clone(),
        artist: row.artist.clone(),
        album: row.album.clone(),
        album_artist: row.album_artist.clone(),
        track_no: row.track_no,
        disc_no: row.disc_no,
        year: row.year,
        genre: row.genre.clone(),
        duration_ms: row.duration_ms,
        codec: row.codec.clone(),
        bitrate: row.bitrate,
        sample_rate: row.sample_rate,
        artwork_path: absolute(root, row.cover_path.as_deref()),
        lyrics_path: absolute(root, row.lyrics_path.as_deref()),
        has_embedded_art: row.has_embedded_art,
        lufs: row.lufs,
        peak: row.peak,
        added_at: row.added_at,
    }
}

pub fn songs<R: Runtime>(app: &AppHandle<R>, catalog: &Catalog, ids: &[String]) -> Vec<Track> {
    let Ok(root) = library_root(app) else {
        return Vec::new();
    };

    ids.iter()
        .filter_map(|id| catalog.track(id).ok().flatten())
        .map(|row| to_track(&row, &root))
        .collect()
}

fn absolute(root: &Path, relative: Option<&str>) -> Option<String> {
    relative.map(|relative| root.join(relative).to_string_lossy().into_owned())
}

/// Tag values are frequently empty strings; treat those as absent.
fn clean(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.trim().is_empty())
}

/// The title and artist a row ends up with: what the file's own tags say, and
/// where they say nothing, what the name it arrived with gives away.
fn name_of(
    tag_title: Option<String>,
    tag_artist: Option<String>,
    original_name: &str,
    audio: &Path,
) -> (String, Option<String>) {
    let named = named_from_file(original_name, audio);
    let title = tag_title
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(named.title);
    let artist = clean(tag_artist).or(named.artist);
    (title, artist)
}

/// What a file name gives away about a song whose own tags say nothing.
struct Named {
    /// The first half of an `Artist - Title` name, when it names one.
    artist: Option<String>,
    title: String,
}

/// `Artist - Title` names both, anything else is a title on its own. The name
/// the song arrived with is preferred over the one it is filed under.
fn named_from_file(original_name: &str, audio: &Path) -> Named {
    let stem = stem_of(original_name)
        .filter(|stem| usable_stem(stem))
        .or_else(|| stem_of(&audio.to_string_lossy()).filter(|stem| usable_stem(stem)));

    let Some(stem) = stem else {
        return Named {
            artist: None,
            title: "Untitled".to_string(),
        };
    };

    match stem.split_once(" - ") {
        Some((artist, title)) if !artist.trim().is_empty() && !title.trim().is_empty() => Named {
            artist: Some(artist.trim().to_string()),
            title: title.trim().to_string(),
        },
        _ => Named {
            artist: None,
            title: stem,
        },
    }
}

fn stem_of(value: &str) -> Option<String> {
    Path::new(value)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
}

fn usable_stem(stem: &str) -> bool {
    !stem.trim().is_empty() && stem != AUDIO_STEM
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

pub fn track_label(track: &Track) -> String {
    match track.artist.as_deref() {
        Some(artist) if !artist.trim().is_empty() => format!("{artist} - {}", track.title),
        _ => track.title.clone(),
    }
}

/// Locates a subfolder of an imported folder, matching the name
/// case-insensitively.
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

/// Matches the covers and lyrics in a folder Wave has never seen, where a file
/// name is all there is to go on.
#[derive(Default)]
pub struct SidecarIndex {
    by_song: HashMap<String, PathBuf>,
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

#[tauri::command(async)]
pub fn scan_library(
    app: AppHandle,
    store: State<'_, Store>,
    catalog: State<'_, Catalog>,
    full: bool,
) -> ScanSummary {
    #[cfg(target_os = "android")]
    let guard = crate::library_work::Guard::start(&app, "Scanning your library");
    let mut summary = scan(&app, &catalog, full);
    if let Err(error) = crate::transfer::resolve_imported(&catalog) {
        summary.errors.push(error);
    }
    if let Err(error) = crate::playlists::refresh(&app, &store) {
        summary.errors.push(error);
    }
    #[cfg(target_os = "android")]
    crate::loudness::schedule(&app, guard);
    summary
}

#[tauri::command(async)]
pub fn reread_tags(
    app: AppHandle,
    store: State<'_, Store>,
    catalog: State<'_, Catalog>,
) -> ScanSummary {
    #[cfg(target_os = "android")]
    let guard = crate::library_work::Guard::start(&app, "Reading song tags");
    let mut summary = reread(&app, &catalog);
    if let Err(error) = crate::playlists::refresh(&app, &store) {
        summary.errors.push(error);
    }
    #[cfg(target_os = "android")]
    crate::loudness::schedule(&app, guard);
    summary
}

#[tauri::command(async)]
pub fn edit_track(
    app: AppHandle,
    catalog: State<'_, Catalog>,
    track_id: String,
    metadata: TrackMetadata,
) -> Result<EditedTrack, String> {
    let root = library_root(&app)?;
    let (row, cleanup) = edit_metadata(&root, &catalog, &track_id, metadata)?;
    Ok(EditedTrack {
        track: to_track(&row, &root),
        previous_path: cleanup.as_ref().map(|(_, previous)| root.join(previous).to_string_lossy().into_owned()),
        cleanup_id: cleanup.map(|(id, _)| id),
    })
}

fn edit_metadata(
    root: &Path,
    catalog: &Catalog,
    track_id: &str,
    metadata: TrackMetadata,
) -> Result<(TrackRow, Option<(String, String)>), String> {
    let _operation = catalog.library_operation();
    let metadata = metadata.validate()?;
    let previous = catalog.track(track_id)?
        .filter(|row| !row.missing)
        .ok_or_else(|| "That song is no longer in the library.".to_string())?;
    let before = TrackMetadata::from_row(&previous);
    if metadata == before {
        return Ok((previous, None));
    }

    let audio = root.join(&previous.rel_path);
    let stamp = identity::stamp_of(&audio)?;
    if stamp.bytes != previous.bytes || stamp.modified_ms != previous.modified_ms {
        return Err("The song changed since the last scan. Rescan the library and try again.".to_string());
    }
    let tagged = lofty::read_from_path(&audio)
        .map_err(|e| format!("Could not read the song tags: {e}"))?;
    let tag_type = tagged.file_type().primary_tag_type();
    if !tagged.file_type().tag_support(tag_type).is_writable() {
        return Err("This song's format does not support editing tags.".to_string());
    }
    let mut tag = tagged.primary_tag().cloned().unwrap_or_else(|| {
        let mut tag = tagged.first_tag().cloned().unwrap_or_else(|| Tag::new(tag_type));
        if tag.tag_type() != tag_type {
            tag.re_map(tag_type);
        }
        tag
    });
    drop(tagged);

    if metadata.title != before.title {
        tag.set_title(metadata.title.clone());
    }
    if metadata.artist != before.artist {
        match &metadata.artist {
            Some(value) => tag.set_artist(value.clone()),
            None => tag.remove_artist(),
        }
    }
    if metadata.album != before.album {
        match &metadata.album {
            Some(value) => tag.set_album(value.clone()),
            None => tag.remove_album(),
        }
    }
    if metadata.album_artist != before.album_artist {
        match &metadata.album_artist {
            Some(value) => { tag.insert_text(ItemKey::AlbumArtist, value.clone()); }
            None => tag.remove_key(ItemKey::AlbumArtist),
        }
    }
    if metadata.genre != before.genre {
        match &metadata.genre {
            Some(value) => tag.set_genre(value.clone()),
            None => tag.remove_genre(),
        }
    }
    if metadata.year != before.year {
        match metadata.year {
            Some(year) => tag.set_date(Timestamp { year, ..tag.date().unwrap_or_default() }),
            None => tag.remove_date(),
        }
    }
    if metadata.track_no != before.track_no {
        match metadata.track_no {
            Some(value) => tag.set_track(value),
            None => tag.remove_track(),
        }
    }
    if metadata.disc_no != before.disc_no {
        match metadata.disc_no {
            Some(value) => tag.set_disk(value),
            None => tag.remove_disk(),
        }
    }

    let extension = audio.extension().and_then(|value| value.to_str()).unwrap_or("audio");
    let edit_id = identity::new_id();
    let temp = root.join(CONFIG_DIR).join(format!(".edit-{edit_id}.{extension}"));
    let dir = audio.parent().ok_or_else(|| "The song has no folder.".to_string())?;
    let target = dir.join(format!("audio-{edit_id}.{extension}"));
    let target_relative = relative(root, &target).ok_or_else(|| "Could not locate the edited song.".to_string())?;
    let cleanup_dir = root.join(CONFIG_DIR).join("metadata-edits");
    let marker = cleanup_dir.join(format!("{edit_id}.json"));
    let cleanup = MetadataCleanup {
        track_id: previous.id.clone(),
        previous_path: previous.rel_path.clone(),
        updated_path: target_relative.clone(),
    };
    let mut committed = false;
    let result = (|| {
        fs::copy(&audio, &temp).map_err(|e| format!("Could not prepare the song for editing: {e}"))?;
        tag.save_to_path(&temp, WriteOptions::default())
            .map_err(|e| format!("Could not write the song tags: {e}"))?;
        let mut updated = read_row(
            &previous.id, &temp, dir, &target_relative, &previous.original_name,
            identity::stamp_of(&temp)?, None,
        )?;
        if TrackMetadata::from_row(&updated) != metadata {
            return Err("This song's format or original filename could not preserve all the requested values.".to_string());
        }
        if identity::stamp_of(&audio)? != stamp {
            return Err("The song changed while it was being edited. Try again.".to_string());
        }
        fs::create_dir_all(&cleanup_dir).map_err(|e| format!("Could not prepare the song edit: {e}"))?;
        let record = serde_json::to_vec(&cleanup).map_err(|e| format!("Could not prepare the song edit: {e}"))?;
        fs::write(&marker, record).map_err(|e| format!("Could not prepare the song edit: {e}"))?;
        fs::rename(&temp, &target)
            .map_err(|e| format!("Could not save the edited song file: {e}"))?;
        updated.added_at = previous.added_at;
        catalog.upsert_edited_track(&updated, previous.bytes)?;
        committed = true;
        let row = catalog.track(&updated.id)?
            .ok_or_else(|| "The updated song is no longer in the library.".to_string())?;
        Ok((row, Some((edit_id, previous.rel_path.clone()))))
    })();
    let _ = fs::remove_file(&temp);
    if result.is_err() && !committed {
        let _ = fs::remove_file(&target);
        let _ = fs::remove_file(&marker);
    }
    result
}

fn cleanup_metadata_edit(root: &Path, catalog: &Catalog, edit_id: &str) -> Result<(), String> {
    if !identity::is_id(edit_id) {
        return Err("That song edit is not valid.".to_string());
    }
    let _operation = catalog.library_operation();
    let marker = root.join(CONFIG_DIR).join("metadata-edits").join(format!("{edit_id}.json"));
    let bytes = match fs::read(&marker) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not read the song edit: {error}")),
    };
    let edit: MetadataCleanup = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Could not read the song edit: {e}"))?;
    let dir = track_dir(root, &edit.track_id);
    let previous = root.join(&edit.previous_path);
    let updated = root.join(&edit.updated_path);
    let expected_stem = format!("audio-{edit_id}");
    if !identity::is_id(&edit.track_id)
        || previous.parent() != Some(dir.as_path())
        || updated.parent() != Some(dir.as_path())
        || !has_extension(&previous, AUDIO_EXTENSIONS)
        || !has_extension(&updated, AUDIO_EXTENSIONS)
        || updated.file_stem().and_then(|stem| stem.to_str()) != Some(expected_stem.as_str())
        || previous == updated
    {
        return Err("That song edit is not valid.".to_string());
    }
    let row = catalog.track(&edit.track_id)?
        .filter(|row| !row.missing && root.join(&row.rel_path).is_file())
        .ok_or_else(|| "The current song file is unavailable.".to_string())?;
    let obsolete = if row.rel_path == edit.previous_path { &updated } else { &previous };
    match fs::remove_file(obsolete) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Could not remove the previous song file: {error}")),
    }
    fs::remove_file(marker).map_err(|e| format!("Could not finish the song edit: {e}"))
}

#[tauri::command(async)]
pub fn cleanup_track_edit(catalog: State<'_, Catalog>, edit_id: String) -> Result<(), String> {
    cleanup_metadata_edit(catalog.root(), &catalog, &edit_id)
}

pub fn recover_metadata_edits(root: &Path, catalog: &Catalog) {
    let Ok(entries) = fs::read_dir(root.join(CONFIG_DIR).join("metadata-edits")) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if let Some(id) = path.file_stem().and_then(|value| value.to_str()) {
            let _ = cleanup_metadata_edit(root, catalog, id);
        }
    }
}

#[tauri::command]
pub fn library_info(catalog: State<'_, Catalog>) -> LibraryInfo {
    let (tracks, missing) = catalog.counts();
    LibraryInfo {
        format_version: LAYOUT_VERSION.parse().unwrap_or(2),
        tracks,
        missing,
        db_bytes: catalog.file_size(),
    }
}

#[tauri::command(async)]
pub fn open_library_folder(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        app.state::<crate::media_session::Session>().open_music_folder()
    }
    #[cfg(not(target_os = "android"))]
    {
        let root = library_root(&app)?;
        app.opener()
            .open_path(root.to_string_lossy().into_owned(), None::<&str>)
            .map_err(|e| format!("could not open {}: {e}", root.display()))
    }
}

#[tauri::command(async)]
pub fn delete_tracks(
    app: AppHandle,
    store: State<'_, Store>,
    catalog: State<'_, Catalog>,
    track_ids: Vec<String>,
) -> Result<PersistedState, String> {
    delete(&app, &catalog, &store, &track_ids)
}

/// Removes the given songs, with their files and their playlist entries.
pub fn delete(
    app: &AppHandle,
    catalog: &Catalog,
    store: &Store,
    track_ids: &[String],
) -> Result<PersistedState, String> {
    let _operation = catalog.library_operation();
    let root = library_root(app)?;
    let mut removed: Vec<String> = Vec::new();

    for id in track_ids {
        let Some(row) = catalog.track(id)? else {
            continue;
        };

        let dir = track_dir(&root, id);
        if dir.is_dir() {
            fs::remove_dir_all(&dir)
                .map_err(|e| format!("could not delete {}: {e}", dir.display()))?;
        } else {
            let audio = root.join(&row.rel_path);
            if audio.is_file() {
                fs::remove_file(&audio)
                    .map_err(|e| format!("could not delete {}: {e}", audio.display()))?;
            }
        }

        removed.push(id.clone());
    }

    if removed.is_empty() {
        return Err("none of those songs are in the library".to_string());
    }

    catalog.delete_tracks(&removed)?;

    store.update_saved(app, |state| {
        state.likes.retain(|id| !removed.contains(id));
        for id in &removed {
            state.artwork_colours.remove(id);
        }
    })?;

    crate::playlists::refresh_saved(app, store)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn editable_song(original_name: &str) -> (PathBuf, Catalog, TrackRow) {
        let root = std::env::temp_dir().join(format!("wave-edit-{}", identity::new_id()));
        let id = identity::new_id();
        let dir = track_dir(&root, &id);
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(root.join(CONFIG_DIR)).unwrap();
        let audio = dir.join("audio.wav");
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&38u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&8000u32.to_le_bytes());
        wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&2u32.to_le_bytes());
        wav.extend_from_slice(&[0, 0]);
        fs::write(&audio, wav).unwrap();
        let catalog = Catalog::open(&root).unwrap();
        let mut row = describe(&root, &id, &audio, original_name, None).unwrap();
        row.lufs = Some(-12.0);
        row.peak = Some(0.8);
        row.loudness_bytes = Some(row.bytes);
        catalog.upsert_track(&row).unwrap();
        catalog.set_loudness(&row.id, -12.0, 0.8, row.bytes).unwrap();
        (root, catalog, row)
    }

    #[test]
    fn unreadable_songs_directory_does_not_mark_anything_missing() {
        let (root, catalog, row) = editable_song("Song.wav");
        let songs = root.join(SONGS_DIR);
        let moved = root.join("unavailable-songs");
        fs::rename(&songs, &moved).unwrap();
        let summary = sweep_root(&root, &catalog, false, false);
        assert!(!summary.errors.is_empty());
        assert!(summary.removed.is_empty());
        assert!(summary.changed.is_empty());
        assert!(!catalog.track(&row.id).unwrap().unwrap().missing);
        let full = sweep_root(&root, &catalog, true, false);
        assert!(!full.errors.is_empty());
        assert_eq!(full.total, 1);
        assert_eq!(full.changed.iter().map(|track| &track.id).collect::<Vec<_>>(), vec![&row.id]);
        assert!(full.removed.is_empty());
        fs::rename(&moved, &songs).unwrap();
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_song_reconciliation_does_not_mark_other_tracks_missing() {
        let (root, catalog, row) = editable_song("Song.wav");
        let song_dir = track_dir(&root, &row.id);
        fs::rename(&song_dir, root.join("unavailable-song")).unwrap();
        let invalid_dir = track_dir(&root, &identity::new_id());
        fs::create_dir_all(&invalid_dir).unwrap();
        fs::write(invalid_dir.join("audio.wav"), b"not audio").unwrap();
        let summary = sweep_root(&root, &catalog, false, false);
        assert!(!summary.errors.is_empty());
        assert!(summary.removed.is_empty());
        assert!(!catalog.track(&row.id).unwrap().unwrap().missing);
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scan_waits_for_placement_to_finish_before_reading_the_library() {
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        let (root, catalog, row) = editable_song("Song.wav");
        let catalog = Arc::new(catalog);
        let operation = catalog.library_operation();
        catalog.delete_tracks(&[row.id.clone()]).unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let scan_catalog = Arc::clone(&catalog);
        let scan_root = root.clone();
        let scan = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let summary = sweep_root(&scan_root, &scan_catalog, false, false);
            done_tx.send(summary).unwrap();
        });
        started_rx.recv().unwrap();
        assert!(done_rx.recv_timeout(Duration::from_millis(100)).is_err());
        catalog.upsert_track(&row).unwrap();
        drop(operation);
        let summary = done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        scan.join().unwrap();
        assert!(summary.errors.is_empty(), "{:?}", summary.errors);
        assert!(summary.removed.is_empty());
        assert!(!catalog.track(&row.id).unwrap().unwrap().missing);
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    fn image_bytes(format: image::ImageFormat, colour: [u8; 3]) -> Vec<u8> {
        let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(2, 2, image::Rgb(colour)));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes, format).unwrap();
        bytes.into_inner()
    }

    #[test]
    fn replacing_covers_accepts_supported_formats_and_survives_rereads() {
        let (root, catalog, row) = editable_song("Song.wav");
        let dir = track_dir(&root, &row.id);
        let original_audio = fs::read(root.join(&row.rel_path)).unwrap();
        let old_cover = cover_path(&root, &row.id, "jpg");
        fs::write(&old_cover, image_bytes(image::ImageFormat::Jpeg, [50, 50, 50])).unwrap();
        catalog.set_cover(&row.id, relative(&root, &old_cover).as_deref()).unwrap();
        let mut previous = Some(old_cover);
        for (format, extension) in [
            (image::ImageFormat::Jpeg, "jpg"),
            (image::ImageFormat::Png, "png"),
            (image::ImageFormat::WebP, "webp"),
            (image::ImageFormat::Gif, "gif"),
            (image::ImageFormat::Bmp, "bmp"),
        ] {
            let bytes = image_bytes(format, [200, 30, 60]);
            let track = replace_cover(&root, &catalog, &row.id, &bytes).unwrap();
            let path = PathBuf::from(track.artwork_path.unwrap());
            assert_eq!(path.extension().unwrap(), extension);
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert!(is_cover_file(&path));
            assert_eq!(cover_in(&dir), Some(path.clone()));
            if let Some(old) = previous {
                assert!(!Path::new(&old).exists());
            }
            let known = catalog.rows_by_id().unwrap();
            let (reread, _) = reconcile(&dir, &root, &known, &mut Vec::new(), true)
                .unwrap().unwrap();
            assert_eq!(reread.cover_path, relative(&root, &path));
            assert_eq!(reread.lufs, row.lufs);
            previous = Some(path);
        }
        assert_eq!(fs::read(root.join(&row.rel_path)).unwrap(), original_audio);
        assert!(!is_cover_file(Path::new("cover-art.png")));
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_cover_replacements_leave_the_existing_cover_untouched() {
        let (root, catalog, row) = editable_song("Song.wav");
        let bytes = image_bytes(image::ImageFormat::Png, [20, 60, 200]);
        let track = replace_cover(&root, &catalog, &row.id, &bytes).unwrap();
        let path = PathBuf::from(track.artwork_path.unwrap());
        assert!(replace_cover(&root, &catalog, &row.id, b"not an image").is_err());
        assert!(replace_cover(&root, &catalog, "missing", &bytes).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(catalog.track(&row.id).unwrap().unwrap().cover_path, relative(&root, &path));
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn editing_tags_survives_a_reread_and_preserves_loudness() {
        let (root, catalog, row) = editable_song("Artist - Song.wav");
        let metadata = TrackMetadata {
            title: "Renamed".to_string(),
            artist: Some("Another artist".to_string()),
            album: Some("Album".to_string()),
            album_artist: Some("Album artist".to_string()),
            genre: Some("Rock".to_string()),
            year: Some(2024),
            track_no: Some(3),
            disc_no: Some(2),
        };
        let original = fs::read(root.join(&row.rel_path)).unwrap();
        let (updated, cleanup) = edit_metadata(&root, &catalog, &row.id, metadata.clone()).unwrap();
        assert_ne!(updated.rel_path, row.rel_path);
        assert_eq!(fs::read(root.join(&row.rel_path)).unwrap(), original);
        assert_eq!(cleanup.as_ref().unwrap().1, row.rel_path);
        assert_eq!(TrackMetadata::from_row(&updated), metadata);
        assert_eq!(updated.id, row.id);
        assert_eq!(updated.added_at, row.added_at);
        assert_eq!(updated.lufs, row.lufs);
        assert_eq!(updated.peak, row.peak);
        assert_eq!(updated.loudness_bytes, Some(updated.bytes));
        assert_eq!(TrackMetadata::from_row(&catalog.track(&row.id).unwrap().unwrap()), metadata);
        let known = catalog.rows_by_id().unwrap();
        let (reread, _) = reconcile(&track_dir(&root, &row.id), &root, &known, &mut Vec::new(), true)
            .unwrap().unwrap();
        assert_eq!(TrackMetadata::from_row(&reread), metadata);
        cleanup_metadata_edit(&root, &catalog, &cleanup.unwrap().0).unwrap();
        assert!(!root.join(&row.rel_path).exists());
        assert!(root.join(&updated.rel_path).exists());
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn editing_one_field_preserves_unedited_tags() {
        let (root, catalog, row) = editable_song("Song.wav");
        let audio = root.join(&row.rel_path);
        let mut tag = Tag::new(lofty::tag::TagType::Id3v2);
        tag.set_title("Song".to_string());
        tag.set_comment("Keep this comment".to_string());
        tag.set_track(2);
        tag.set_track_total(12);
        tag.set_date(Timestamp { year: 2020, month: Some(5), day: Some(10), ..Timestamp::default() });
        tag.insert_text(ItemKey::Isrc, "ABC123".to_string());
        tag.save_to_path(&audio, WriteOptions::default()).unwrap();
        let refreshed = describe(&root, &row.id, &audio, &row.original_name, None).unwrap();
        catalog.upsert_track(&refreshed).unwrap();
        let mut metadata = TrackMetadata::from_row(&refreshed);
        metadata.title = "New title".to_string();
        let (updated, _) = edit_metadata(&root, &catalog, &row.id, metadata).unwrap();
        let tagged = lofty::read_from_path(root.join(&updated.rel_path)).unwrap();
        let tag = tagged.primary_tag().unwrap();
        assert_eq!(tag.comment().as_deref(), Some("Keep this comment"));
        assert_eq!(tag.track_total(), Some(12));
        assert_eq!(tag.get_string(ItemKey::Isrc), Some("ABC123"));
        assert_eq!(tag.date().unwrap().to_string(), "2020-05-10");
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "requires ffmpeg"]
    fn editing_common_audio_formats() {
        use std::process::{Command, Stdio};

        let root = std::env::temp_dir().join(format!("wave-edit-formats-{}", identity::new_id()));
        let catalog = Catalog::open(&root).unwrap();
        for extension in ["mp3", "flac", "m4a", "ogg", "opus", "wav", "aiff", "aac"] {
            let id = identity::new_id();
            let dir = track_dir(&root, &id);
            fs::create_dir_all(&dir).unwrap();
            let audio = dir.join(format!("audio.{extension}"));
            let output = Command::new("ffmpeg")
                .args(["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "0.3",
                    "-metadata", "title=Original", "-metadata", "artist=Artist", "-metadata", "comment=Keep",
                    "-metadata", "date=2020-05-10"])
                .arg(&audio)
                .stdin(Stdio::null())
                .output()
                .unwrap();
            assert!(output.status.success(), "{extension}: {}", String::from_utf8_lossy(&output.stderr));
            let row = describe(&root, &id, &audio, &format!("Original.{extension}"), None).unwrap();
            catalog.upsert_track(&row).unwrap();
            let mut metadata = TrackMetadata::from_row(&row);
            metadata.title = format!("Edited {extension}");
            metadata.artist = Some("New artist".to_string());
            metadata.album = Some("New album".to_string());
            metadata.genre = Some("Rock".to_string());
            metadata.year = Some(2024);
            metadata.track_no = Some(2);
            metadata.disc_no = Some(1);
            let (updated, _) = edit_metadata(&root, &catalog, &id, metadata.clone())
                .unwrap_or_else(|error| panic!("{extension}: {error}"));
            assert_eq!(TrackMetadata::from_row(&updated), metadata, "{extension}");
            let known = catalog.rows_by_id().unwrap();
            let (reread, _) = reconcile(&dir, &root, &known, &mut Vec::new(), true).unwrap().unwrap();
            assert_eq!(TrackMetadata::from_row(&reread), metadata, "{extension}");
        }
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_or_unrepresentable_edits_leave_the_original_file_and_catalog_alone() {
        let (root, catalog, row) = editable_song("Artist - Song.wav");
        let audio = root.join(&row.rel_path);
        let original = fs::read(&audio).unwrap();
        let mut metadata = TrackMetadata::from_row(&row);
        metadata.title = "  ".to_string();
        assert!(edit_metadata(&root, &catalog, &row.id, metadata).is_err());
        let mut metadata = TrackMetadata::from_row(&row);
        metadata.artist = None;
        assert!(edit_metadata(&root, &catalog, &row.id, metadata).is_err());
        assert_eq!(fs::read(audio).unwrap(), original);
        assert_eq!(TrackMetadata::from_row(&catalog.track(&row.id).unwrap().unwrap()), TrackMetadata::from_row(&row));
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clearing_optional_tags_and_saving_without_changes() {
        let (root, catalog, row) = editable_song("Song.wav");
        let mut metadata = TrackMetadata::from_row(&row);
        metadata.album = Some("Album".to_string());
        metadata.genre = Some("Rock".to_string());
        metadata.year = Some(2020);
        let (updated, _) = edit_metadata(&root, &catalog, &row.id, metadata).unwrap();
        let audio = root.join(&updated.rel_path);
        let stamp = identity::stamp_of(&audio).unwrap();
        let (_, cleanup) = edit_metadata(&root, &catalog, &row.id, TrackMetadata::from_row(&updated)).unwrap();
        assert!(cleanup.is_none());
        assert_eq!(identity::stamp_of(&audio).unwrap(), stamp);
        let mut cleared = TrackMetadata::from_row(&updated);
        cleared.album = None;
        cleared.genre = None;
        cleared.year = None;
        let (updated, _) = edit_metadata(&root, &catalog, &row.id, cleared.clone()).unwrap();
        assert_eq!(TrackMetadata::from_row(&updated), cleared);
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pending_metadata_edits_recover_after_restart_without_removing_current_audio() {
        let (root, catalog, row) = editable_song("Song.wav");
        let mut metadata = TrackMetadata::from_row(&row);
        metadata.title = "First edit".to_string();
        let (first, _) = edit_metadata(&root, &catalog, &row.id, metadata.clone()).unwrap();
        metadata.title = "Second edit".to_string();
        let (second, _) = edit_metadata(&root, &catalog, &row.id, metadata).unwrap();
        assert!(root.join(&row.rel_path).exists());
        assert!(root.join(&first.rel_path).exists());
        assert!(root.join(&second.rel_path).exists());

        recover_metadata_edits(&root, &catalog);
        assert!(!root.join(&row.rel_path).exists());
        assert!(!root.join(&first.rel_path).exists());
        assert!(root.join(&second.rel_path).exists());
        assert_eq!(catalog.track(&row.id).unwrap().unwrap().rel_path, second.rel_path);
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_preserves_the_original_when_a_metadata_edit_was_not_committed() {
        let (root, catalog, row) = editable_song("Song.wav");
        let id = identity::new_id();
        let updated = track_dir(&root, &row.id).join(format!("audio-{id}.wav"));
        fs::copy(root.join(&row.rel_path), &updated).unwrap();
        let directory = root.join(CONFIG_DIR).join("metadata-edits");
        fs::create_dir_all(&directory).unwrap();
        let record = MetadataCleanup {
            track_id: row.id.clone(),
            previous_path: row.rel_path.clone(),
            updated_path: relative(&root, &updated).unwrap(),
        };
        fs::write(directory.join(format!("{id}.json")), serde_json::to_vec(&record).unwrap()).unwrap();

        recover_metadata_edits(&root, &catalog);
        assert!(root.join(&row.rel_path).exists());
        assert!(!updated.exists());
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_keeps_the_old_audio_if_the_current_file_is_missing() {
        let (root, catalog, row) = editable_song("Song.wav");
        let mut metadata = TrackMetadata::from_row(&row);
        metadata.title = "Edited".to_string();
        let (updated, cleanup) = edit_metadata(&root, &catalog, &row.id, metadata).unwrap();
        fs::remove_file(root.join(&updated.rel_path)).unwrap();
        assert!(cleanup_metadata_edit(&root, &catalog, &cleanup.unwrap().0).is_err());
        assert!(root.join(&row.rel_path).exists());
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rereading_tags_preserves_existing_loudness_in_the_returned_row() {
        let root = std::env::temp_dir().join(format!("wave-reread-{}", uuid::Uuid::new_v4()));
        let id = identity::new_id();
        let dir = track_dir(&root, &id);
        fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("audio.wav");
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&38u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&8000u32.to_le_bytes());
        wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&2u32.to_le_bytes());
        wav.extend_from_slice(&[0, 0]);
        fs::write(&audio, wav).unwrap();

        let mut previous = describe(&root, &id, &audio, "Artist - Song.wav", None).unwrap();
        previous.lufs = Some(-12.0);
        previous.peak = Some(0.8);
        previous.loudness_bytes = Some(previous.bytes);
        let known = HashMap::from([(id, previous.clone())]);
        let (updated, changed) = reconcile(&dir, &root, &known, &mut Vec::new(), true)
            .unwrap()
            .unwrap();
        assert!(changed);
        assert_eq!(updated.lufs, previous.lufs);
        assert_eq!(updated.peak, previous.peak);
        assert_eq!(updated.loudness_bytes, previous.loudness_bytes);
        fs::remove_dir_all(root).unwrap();
    }

    /// A song already filed in the library, so its own name says nothing.
    fn filed(name: &str) -> (String, Option<String>) {
        name_of(None, None, name, Path::new("/library/songs/abc/audio.mp3"))
    }

    #[test]
    fn reads_an_artist_and_a_title_out_of_a_file_name() {
        let (title, artist) = filed("Slipknot - Eyeless.mp3");
        assert_eq!(title, "Eyeless");
        assert_eq!(artist.as_deref(), Some("Slipknot"));
    }

    #[test]
    fn a_name_with_no_dash_is_a_title_on_its_own() {
        let (title, artist) = filed("Eyeless.mp3");
        assert_eq!(title, "Eyeless");
        assert_eq!(artist, None);
    }

    #[test]
    fn a_name_with_nothing_before_the_dash_is_a_title_on_its_own() {
        let (title, artist) = filed(" - Eyeless.mp3");
        assert_eq!(title, " - Eyeless");
        assert_eq!(artist, None);
    }

    #[test]
    fn the_first_dash_is_the_one_that_separates_the_two() {
        let (title, artist) = filed("A Tout Le Monde - Remastered 2004.mp3");
        assert_eq!(title, "Remastered 2004");
        assert_eq!(artist.as_deref(), Some("A Tout Le Monde"));
    }

    #[test]
    fn a_name_that_is_only_the_stem_wave_writes_names_nothing() {
        let (title, artist) = name_of(None, None, "audio.mp3", Path::new("/library/songs/abc/audio.mp3"));
        assert_eq!(title, "Untitled");
        assert_eq!(artist, None);
    }

    #[test]
    fn the_name_the_song_arrived_with_is_preferred_over_the_one_on_disk() {
        let (title, artist) = name_of(
            None,
            None,
            "Korn - Freak On a Leash.mp3",
            Path::new("/library/songs/abc/Something Else.mp3"),
        );
        assert_eq!(title, "Freak On a Leash");
        assert_eq!(artist.as_deref(), Some("Korn"));
    }

    #[test]
    fn a_song_already_filed_falls_back_to_the_name_it_came_in_as() {
        let (title, artist) = name_of(
            None,
            None,
            "",
            Path::new("/somewhere/Korn - Freak On a Leash.mp3"),
        );
        assert_eq!(title, "Freak On a Leash");
        assert_eq!(artist.as_deref(), Some("Korn"));
    }

    #[test]
    fn a_tag_beats_the_file_name() {
        let (title, artist) = name_of(
            Some("Eyeless".to_string()),
            Some("Slipknot".to_string()),
            "Something - Else.mp3",
            Path::new("/library/songs/abc/audio.mp3"),
        );
        assert_eq!(title, "Eyeless");
        assert_eq!(artist.as_deref(), Some("Slipknot"));
    }

    #[test]
    fn a_title_tag_with_no_artist_tag_still_takes_the_name_apart() {
        let (title, artist) = name_of(
            Some("Eyeless".to_string()),
            None,
            "Slipknot - Eyeless.mp3",
            Path::new("/library/songs/abc/audio.mp3"),
        );
        assert_eq!(title, "Eyeless");
        assert_eq!(artist.as_deref(), Some("Slipknot"));
    }

    #[test]
    fn an_empty_tag_counts_as_no_tag_at_all() {
        let (title, artist) = name_of(
            Some("   ".to_string()),
            Some(String::new()),
            "Slipknot - Eyeless.mp3",
            Path::new("/library/songs/abc/audio.mp3"),
        );
        assert_eq!(title, "Eyeless");
        assert_eq!(artist.as_deref(), Some("Slipknot"));
    }
}
