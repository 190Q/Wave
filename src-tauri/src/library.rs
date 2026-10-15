use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use lofty::file::FileType;
use lofty::prelude::{Accessor, AudioFile, ItemKey, TaggedFileExt};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::catalog::{Catalog, TrackRow, LAYOUT_VERSION};
use crate::identity;
use crate::state::{save, PersistedState, Store};

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

pub fn library_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data directory: {e}"))?
        .join("library");

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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub tracks: Vec<Track>,
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

pub fn scan<R: Runtime>(app: &AppHandle<R>, catalog: &Catalog) -> ScanSummary {
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

    let mut errors = Vec::new();
    let mut rows: Vec<TrackRow> = Vec::new();
    let mut skipped = 0usize;

    let songs = root.join(SONGS_DIR);
    match fs::read_dir(&songs) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);

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

                match reconcile(&path, &root, catalog, &mut errors) {
                    Ok(Some(row)) => rows.push(row),
                    Ok(None) => {}
                    Err(error) => errors.push(error),
                }
            }
        }
        Err(error) => errors.push(format!("could not read {}: {error}", songs.display())),
    }

    // One write for the whole scan. Anything the scan did not see keeps its row.
    if let Err(error) = catalog.sync_scan(&rows) {
        errors.push(error);
    }

    let mut tracks: Vec<Track> = rows.iter().map(|row| to_track(row, &root)).collect();
    tracks.sort_by_key(|track| track.title.to_lowercase());

    ScanSummary {
        tracks,
        root: root.to_string_lossy().into_owned(),
        skipped,
        errors,
    }
}

/// Brings one song's directory in line with the catalog, or returns `None` when
/// the directory holds no audio.
fn reconcile(
    dir: &Path,
    root: &Path,
    catalog: &Catalog,
    errors: &mut Vec<String>,
) -> Result<Option<TrackRow>, String> {
    let dir_name = dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();

    let named_as_id = identity::is_id(&dir_name);
    let known = if named_as_id {
        catalog.track(&dir_name)?
    } else {
        None
    };

    // The file the catalog recorded, or the only audio file in the directory,
    // which covers a file renamed by hand.
    let recorded = known
        .as_ref()
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

    // Nothing has changed since the catalog last looked, so the tags are taken
    // as read instead of being read again.
    let unchanged = known.as_ref().is_some_and(|row| {
        row.rel_path == rel_path && row.bytes == stamp.bytes && row.modified_ms == stamp.modified_ms
    });

    if unchanged {
        let mut row = known.unwrap_or_default();
        row.missing = false;
        let cover = kept(root, row.cover_path.clone(), &dir, cover_in);
        let lyrics = kept(root, row.lyrics_path.clone(), &dir, lyrics_in);
        row.cover_path = cover;
        row.lyrics_path = lyrics;
        return Ok(Some(row));
    }

    let original_name = known
        .as_ref()
        .map(|row| row.original_name.clone())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| {
            audio
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        });

    let mut row = read_row(&id, &audio, &dir, &rel_path, &original_name, stamp)?;
    row.added_at = known
        .as_ref()
        .map(|row| row.added_at)
        .unwrap_or(row.added_at);
    Ok(Some(row))
}

/// Describes a song that has just been written into the library, so the catalog
/// records what is on disk: tags, hash, and whatever sits beside it.
pub fn describe(
    root: &Path,
    id: &str,
    audio: &Path,
    original_name: &str,
) -> Result<TrackRow, String> {
    let dir = audio
        .parent()
        .ok_or_else(|| format!("{} has no folder", audio.display()))?;
    let rel_path = relative(root, audio)
        .ok_or_else(|| format!("{} is outside the library", audio.display()))?;
    let stamp = identity::stamp_of(audio)?;

    read_row(id, audio, dir, &rel_path, original_name, stamp)
}

fn read_row(
    id: &str,
    audio: &Path,
    dir: &Path,
    rel_path: &str,
    original_name: &str,
    stamp: identity::Stamp,
) -> Result<TrackRow, String> {
    let file_name = audio
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tagged =
        lofty::read_from_path(audio).map_err(|e| format!("could not read {file_name}: {e}"))?;

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

    let title = title
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback_title(original_name, audio));

    // Art inside the file is written out beside it, so a cover lives with the
    // song rather than in a cache that can be cleared.
    let cover = cover_in(dir).or_else(|| {
        embedded
            .as_ref()
            .and_then(|(data, extension)| write_cover(dir, data, extension))
    });

    Ok(TrackRow {
        id: id.to_string(),
        rel_path: rel_path.to_string(),
        original_name: original_name.to_string(),
        bytes: stamp.bytes,
        modified_ms: stamp.modified_ms,
        content_hash: Some(identity::content_hash(audio)?),
        title,
        artist: clean(artist),
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
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && has_extension(&path, AUDIO_EXTENSIONS) {
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

fn cover_in(dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && has_extension(&path, IMAGE_EXTENSIONS)
            && file_stem_lower(&path) == COVER_STEM
        {
            return Some(path);
        }
    }
    None
}

fn lyrics_in(dir: &Path) -> Option<PathBuf> {
    let path = dir.join(LYRICS_NAME);
    path.is_file().then_some(path)
}

fn write_cover(dir: &Path, data: &[u8], extension: &str) -> Option<PathBuf> {
    let target = dir.join(format!("{COVER_STEM}.{extension}"));
    if target.exists() {
        return Some(target);
    }
    fs::write(&target, data).ok()?;
    Some(target)
}

fn to_track(row: &TrackRow, root: &Path) -> Track {
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
    }
}

fn absolute(root: &Path, relative: Option<&str>) -> Option<String> {
    relative.map(|relative| root.join(relative).to_string_lossy().into_owned())
}

/// Tag values are frequently empty strings; treat those as absent.
fn clean(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.trim().is_empty())
}

/// A song with no title tag is shown under the name it arrived with.
fn fallback_title(original_name: &str, audio: &Path) -> String {
    let from_original = Path::new(original_name)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .filter(|stem| !stem.trim().is_empty() && stem != AUDIO_STEM);

    from_original
        .or_else(|| {
            audio
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .filter(|stem| !stem.trim().is_empty() && stem != AUDIO_STEM)
        })
        .unwrap_or_else(|| "Untitled".to_string())
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
) -> ScanSummary {
    let summary = scan(&app, &catalog);
    let _ = crate::playlists::refresh(&app, &store);
    summary
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

#[tauri::command]
pub fn delete_tracks(
    app: AppHandle,
    store: State<'_, Store>,
    catalog: State<'_, Catalog>,
    track_ids: Vec<String>,
) -> Result<PersistedState, String> {
    let root = library_root(&app)?;
    let mut removed: Vec<String> = Vec::new();

    for id in &track_ids {
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

    let next = store.update(|state| {
        state.likes.retain(|id| !removed.contains(id));
        for id in &removed {
            state.artwork_colours.remove(id);
        }
    });
    save(&app, &next)?;

    Ok(crate::playlists::refresh(&app, &store))
}
