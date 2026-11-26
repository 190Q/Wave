use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

use crate::catalog::Catalog;
use crate::cover_fetch;
use crate::genre_fetch;
use crate::identity;
use crate::library::{
    self, audio_path, cover_path, has_extension, library_root, lyrics_path, source_subdir,
    SidecarIndex, AUDIO_EXTENSIONS, CONFIG_DIR, IMAGE_EXTENSIONS, LYRICS_EXTENSIONS,
    SOURCE_ARTWORK_DIR, SOURCE_LYRICS_DIR,
};
use crate::lyrics_fetch;
use crate::playlists;
use crate::state::{PersistedState, Store};

const COPY_BUFFER: usize = 128 * 1024;

/// Where a song sits while it is being hashed, so nothing lands in the library
/// until it is known what it is.
const STAGING_DIR: &str = "staging";

const PICKED_DIR: &str = "picked";

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub songs: usize,
    pub images: usize,
    pub lyrics: usize,
    pub skipped: usize,
    /// Skipped because the library already holds this exact audio.
    pub duplicates: usize,
    /// Added even though something else shares their title, artist and album.
    pub similar: usize,
    pub playlist: Option<String>,
    pub playlist_id: Option<String>,
    /// The songs that landed, so the front end can fill in what they are missing.
    pub track_ids: Vec<String>,
    pub errors: Vec<String>,
    pub state: PersistedState,
}

impl ImportOutcome {
    pub(crate) fn refresh_state(&mut self, app: &AppHandle, store: &Store) {
        self.state = match playlists::refresh(app, store) {
            Ok(state) => state,
            Err(error) => {
                self.errors.push(format!("Import finished, but the playlists could not be refreshed: {error}"));
                store.snapshot()
            }
        };
    }
}

struct PlacedFiles {
    dir: PathBuf,
    paths: Vec<PathBuf>,
    committed: bool,
}

impl Drop for PlacedFiles {
    fn drop(&mut self) {
        if !self.committed {
            for path in &self.paths {
                let _ = fs::remove_file(path);
            }
            let _ = fs::remove_dir(&self.dir);
        }
    }
}

pub const LANDED_EVENT: &str = "library-landed";
const FOLDER_PROGRESS_EVENT: &str = "folder-import-progress";

#[derive(Debug, Clone, Copy)]
pub enum Placed {
    /// The library already held this audio, so nothing was written.
    Duplicate,
    Added {
        similar: bool,
        cover: bool,
        lyrics: bool,
    },
}

/// What became of one song that was filed into the library.
pub struct Landed {
    pub id: String,
    /// The library already held this audio, so nothing was written for it.
    pub duplicate: bool,
    /// Added even though something else shares its title, artist and album.
    pub similar: bool,
    pub cover: bool,
    pub lyrics: bool,
}

pub fn land(app: &AppHandle, path: &Path) -> Result<Landed, String> {
    land_with_source(app, path, None)
}

pub fn land_download(app: &AppHandle, file: &crate::download::Downloaded) -> Result<Landed, String> {
    land_with_source(app, &file.path, file.youtube_id.as_deref())
}

fn land_with_source(app: &AppHandle, path: &Path, youtube_id: Option<&str>) -> Result<Landed, String> {
    let root = library_root(app)?;
    let catalog = app.state::<Catalog>();
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| format!("{} has no name", path.display()))?;

    // A song that arrives on its own has no folder of sidecars to match against.
    let (placed, id) = import_one(
        &root,
        &catalog,
        path,
        &file_name,
        &SidecarIndex::default(),
        &SidecarIndex::default(),
        false,
    )?;
    if let Some(video_id) = youtube_id {
        catalog.set_youtube_id(&id, video_id)?;
    }

    let landed = Landed {
        id: id.clone(),
        duplicate: matches!(placed, Placed::Duplicate),
        similar: matches!(placed, Placed::Added { similar: true, .. }),
        cover: matches!(placed, Placed::Added { cover: true, .. }),
        lyrics: matches!(placed, Placed::Added { lyrics: true, .. }),
    };

    // The row is the one just written, so the UI can show the song at once.
    if let Some(row) = catalog.track(&id)? {
        let _ = app.emit(LANDED_EVENT, vec![library::to_track(&row, &root)]);
    }

    Ok(landed)
}

/// What a song was still missing when it landed.
#[derive(Debug, Clone, Copy, Default)]
pub struct Complete {
    pub cover: bool,
    pub genre: bool,
    pub lyrics: bool,
}

pub fn complete(app: &AppHandle, id: &str) -> Complete {
    let ids = [id.to_string()];
    let mut done = Complete::default();

    if let Ok(outcome) = cover_fetch::fill(app, &ids) {
        done.cover = outcome.restored > 0;
    }
    if let Ok(outcome) = genre_fetch::fill(app, &ids) {
        done.genre = outcome.tagged > 0;
    }
    if let Ok(outcome) = lyrics_fetch::fill(app, &ids) {
        done.lyrics = outcome.fetched > 0;
    }

    let _ = refresh(app, id);
    done
}

pub fn refresh(app: &AppHandle, id: &str) -> Result<(), String> {
    let root = library_root(app)?;
    let catalog = app.state::<Catalog>();
    let _operation = catalog.library_operation();
    let Some(known) = catalog.track(id)? else {
        return Ok(());
    };

    let audio = root.join(&known.rel_path);
    let mut row = library::describe(
        &root,
        id,
        &audio,
        &known.original_name,
        None,
    )?;
    // A song is not newly added just because something was written into it.
    row.added_at = known.added_at;
    row.youtube_id = known.youtube_id;
    catalog.upsert_track(&row)?;

    let _ = app.emit(LANDED_EVENT, vec![library::to_track(&row, &root)]);
    Ok(())
}

pub(crate) fn fetched_track(
    root: &Path,
    catalog: &Catalog,
    track: &library::Track,
) -> Result<crate::catalog::TrackRow, String> {
    let row = catalog.track(&track.id)?
        .filter(|row| !row.missing)
        .ok_or_else(|| "the song is no longer in the library".to_string())?;
    if row.rel_path != track.relative_path
        || Path::new(&track.path) != root.join(&row.rel_path)
        || row.title != track.title
        || row.artist != track.artist
        || row.album != track.album
        || row.album_artist != track.album_artist
        || row.genre != track.genre
        || row.track_no != track.track_no
        || row.disc_no != track.disc_no
        || row.year != track.year
    {
        return Err("the song changed while it was being looked up".to_string());
    }
    let stamp = identity::stamp_of(&root.join(&row.rel_path))?;
    if stamp.bytes != row.bytes || stamp.modified_ms != row.modified_ms {
        return Err("the song changed since the last scan".to_string());
    }
    Ok(row)
}

pub(crate) fn refresh_after_tags(
    root: &Path,
    catalog: &Catalog,
    known: &crate::catalog::TrackRow,
) -> Result<crate::catalog::TrackRow, String> {
    let mut row = library::describe(
        root, &known.id, &root.join(&known.rel_path), &known.original_name, None,
    )?;
    row.added_at = known.added_at;
    row.youtube_id = known.youtube_id.clone();
    catalog.upsert_edited_track(&row, known.bytes)?;
    Ok(row)
}

#[tauri::command]
pub async fn import_folder(
    app: AppHandle,
    folder: String,
    create_playlist: bool,
    playlist_name: Option<String>,
) -> Result<ImportOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_folder_inner(app, folder, create_playlist, playlist_name)
    })
    .await
    .map_err(|error| format!("The folder import stopped unexpectedly: {error}"))?
}

fn import_folder_inner(
    app: AppHandle,
    folder: String,
    create_playlist: bool,
    playlist_name: Option<String>,
) -> Result<ImportOutcome, String> {
    let source = PathBuf::from(&folder);
    if !source.is_dir() {
        return Err(format!("{folder} is not a folder"));
    }

    #[cfg(target_os = "android")]
    let guard = crate::library_work::Guard::start(&app, "Importing music");
    let mut outcome = import_into_library(&app, &source, create_playlist, playlist_name.as_deref())?;

    let name = outcome
        .playlist
        .clone()
        .or_else(|| source.file_name().map(|name| name.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "Imported folder".to_string());
    remember_import(&app, "folder", &name, &outcome);

    outcome.state = app.state::<Store>().snapshot();
    #[cfg(target_os = "android")]
    crate::loudness::schedule(&app, guard);
    Ok(outcome)
}

/// Imports the files the user picked out of the system's own file picker.
///
/// On Android the picker hands back a `content://` URI, which `std::fs` cannot
/// open and only the fs plugin can, so the bytes come in through it and are
/// staged inside the library before the usual tagging pass reads them. On
/// desktop the picker hands back a plain path and the same code reads it.
#[tauri::command(async)]
pub fn import_picked_files(app: AppHandle, paths: Vec<String>) -> Result<ImportOutcome, String> {
    if paths.is_empty() {
        return Err("nothing was picked".to_string());
    }

    #[cfg(target_os = "android")]
    let guard = crate::library_work::Guard::start(&app, "Importing music");
    let store = app.state::<Store>();
    let names = picked_names(&app, &paths)?;
    let selected = paths.into_iter().enumerate().map(|(index, uri)| {
        let name = names
            .get(index)
            .cloned()
            .unwrap_or_else(|| picked_name(&uri));
        (uri, name)
    });
    let mut outcome = import_selected(&app, selected);
    remember_import(&app, "files", "Picked files", &outcome);
    outcome.state = store.snapshot();
    #[cfg(target_os = "android")]
    crate::loudness::schedule(&app, guard);
    Ok(outcome)
}

fn import_selected(
    app: &AppHandle,
    files: impl IntoIterator<Item = (String, String)>,
) -> ImportOutcome {
    let mut outcome = ImportOutcome::default();
    let files: Vec<_> = files.into_iter().collect();
    let total = files.len();
    for (index, (uri, name)) in files.into_iter().enumerate() {
        let _ = app.emit(FOLDER_PROGRESS_EVENT, format!("Importing song {} of {total}: {name}", index + 1));
        if let Err(error) = validate_picked_audio(&name) {
            outcome.errors.push(error);
            continue;
        }
        let staged = match stage_picked(app, &uri, &name) {
            Ok(staged) => staged,
            Err(error) => {
                outcome.errors.push(format!("{name}: {error}"));
                continue;
            }
        };

        let landed = land(app, &staged.path);

        match landed {
            Ok(landed) => {
                outcome.songs += usize::from(!landed.duplicate);
                outcome.duplicates += usize::from(landed.duplicate);
                outcome.similar += usize::from(landed.similar);
                outcome.images += usize::from(landed.cover);
                outcome.lyrics += usize::from(landed.lyrics);
                if !landed.duplicate {
                    outcome.track_ids.push(landed.id.clone());
                }
            }
            Err(error) => outcome.errors.push(format!("{name}: {error}")),
        }
    }

    outcome
}

fn validate_picked_audio(name: &str) -> Result<(), String> {
    if has_extension(Path::new(name), AUDIO_EXTENSIONS) {
        Ok(())
    } else {
        Err(format!("{name}: unsupported audio format"))
    }
}

#[cfg(target_os = "android")]
#[tauri::command(async)]
pub fn import_phone_folder(app: AppHandle) -> Result<Option<ImportOutcome>, String> {
    let phone = app.state::<crate::music_library::MusicLibrary>();
    let Some(uri) = phone.pick_folder()? else {
        return Ok(None);
    };
    let guard = crate::library_work::Guard::start(&app, "Importing music");
    let _ = app.emit("phone-folder-import", "Reading the selected folder...");
    let files = phone.folder_files(&uri)?;
    let mut folders = std::collections::BTreeMap::new();
    for file in &files {
        folders.entry(&file.parent).or_insert_with(Vec::new).push(file);
    }
    let total = files.iter()
        .filter(|file| has_extension(Path::new(&file.name), AUDIO_EXTENSIONS))
        .count();

    let root = library_root(&app)?;
    let catalog = app.state::<Catalog>();
    let store = app.state::<Store>();
    let mut outcome = ImportOutcome::default();
    let mut processed = 0;

    for siblings in folders.values_mut() {
        siblings.sort_by(|a, b| a.name.cmp(&b.name));
        let audio_files: Vec<_> = siblings.iter()
            .filter(|file| has_extension(Path::new(&file.name), AUDIO_EXTENSIONS))
            .collect();
        let mut sidecars = std::collections::HashMap::new();
        for file in siblings.iter() {
            let path = Path::new(&file.name);
            if has_extension(path, IMAGE_EXTENSIONS) || has_extension(path, LYRICS_EXTENSIONS) {
                sidecars.entry(library::file_stem_lower(path)).or_insert_with(Vec::new).push(*file);
            }
        }
        for file in &audio_files {
            processed += 1;
            let _ = app.emit("phone-folder-import", format!("Importing song {processed} of {total}: {}", file.name));
            let name = picked_name(&file.name);
            let staged = PickedStage::new(&root, &name)?;
            let dir = &staged.dir;
            let audio = &staged.path;
            if let Err(error) = stage_picked_at(&app, &file.uri, &audio) {
                outcome.errors.push(format!("{name}: {error}"));
                continue;
            }

            let stem = library::file_stem_lower(Path::new(&name));
            let mut associated = sidecars.get(&stem).cloned().unwrap_or_default();
            associated.extend(sidecars.values().flatten()
                .filter(|file| library::file_stem_lower(Path::new(&file.name)) != stem
                    && phone_generic_sidecar(&file.name, audio_files.len() == 1))
                .copied());
            for sidecar in associated {
                let sidecar_name = picked_name(&sidecar.name);
                let path = Path::new(&sidecar_name);
                let target = if library::file_stem_lower(path) == "lyrics"
                    && has_extension(path, LYRICS_EXTENSIONS)
                {
                    dir.join(library::LYRICS_NAME)
                } else {
                    dir.join(sidecar_name)
                };
                if let Err(error) = stage_picked_at(&app, &sidecar.uri, &target) {
                    outcome.errors.push(format!("{}: {error}", sidecar.name));
                }
            }

            let images = SidecarIndex::build(&dir, IMAGE_EXTENSIONS);
            let lyrics = SidecarIndex::build(&dir, LYRICS_EXTENSIONS);
            match import_one(&root, &catalog, audio, &name, &images, &lyrics, true) {
                Ok((Placed::Duplicate, _)) => outcome.duplicates += 1,
                Ok((Placed::Added { similar, cover, lyrics }, id)) => {
                    outcome.songs += 1;
                    outcome.similar += usize::from(similar);
                    outcome.images += usize::from(cover);
                    outcome.lyrics += usize::from(lyrics);
                    outcome.track_ids.push(id);
                }
                Err(error) => outcome.errors.push(format!("{name}: {error}")),
            }
        }
    }

    remember_import(&app, "phone", "Selected folder", &outcome);
    outcome.refresh_state(&app, &store);
    crate::loudness::schedule(&app, guard);
    Ok(Some(outcome))
}

#[cfg(any(target_os = "android", test))]
fn phone_generic_sidecar(name: &str, single_song: bool) -> bool {
    let path = Path::new(name);
    library::is_cover_file(path)
        || (single_song && library::file_stem_lower(path) == "lyrics"
            && has_extension(path, LYRICS_EXTENSIONS))
}

/// Imports indexed audio accessible to the phone.
#[cfg(target_os = "android")]
#[tauri::command(async)]
pub fn scan_phone_music(app: AppHandle) -> Result<ImportOutcome, String> {
    let library = app.state::<crate::music_library::MusicLibrary>();
    if !library.request_audio_permission()? {
        return Err(
            "Wave needs the permission to read this phone's music before it can scan for \
             it"
                .to_string(),
        );
    }

    let guard = crate::library_work::Guard::start(&app, "Importing music");
    let files = library.music_files()?;
    let store = app.state::<Store>();
    let mut skipped = 0;
    let selected = files.into_iter().filter_map(|file| {
        match indexed_audio_name(&file.name, file.mime.as_deref()) {
            Some(name) => Some((file.uri, name)),
            None => {
                skipped += 1;
                None
            }
        }
    }).collect::<Vec<_>>();
    let mut outcome = import_selected(&app, selected);
    outcome.skipped = skipped;

    remember_import(&app, "phone", "This phone's music", &outcome);
    outcome.state = store.snapshot();
    crate::loudness::schedule(&app, guard);
    Ok(outcome)
}

#[cfg(any(target_os = "android", test))]
fn indexed_audio_name(name: &str, mime: Option<&str>) -> Option<String> {
    let name = picked_name(name);
    if has_extension(Path::new(&name), AUDIO_EXTENSIONS) {
        return Some(name);
    }
    let extension = match mime?.to_ascii_lowercase().as_str() {
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/mp4" | "audio/x-m4a" => "m4a",
        "audio/flac" | "audio/x-flac" => "flac",
        "audio/aac" | "audio/aacp" => "aac",
        "audio/ogg" | "application/ogg" => "ogg",
        "audio/opus" => "opus",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/aiff" | "audio/x-aiff" => "aiff",
        "audio/x-ms-wma" => "wma",
        _ => return None,
    };
    Some(format!("{name}.{extension}"))
}

/// What the system calls each picked file. Android is the one platform where
/// the picker hands back something that is not already a name, so everywhere
/// else the name is taken from the path itself.
fn picked_names(app: &AppHandle, paths: &[String]) -> Result<Vec<String>, String> {
    #[cfg(target_os = "android")]
    {
        let library = app
            .try_state::<crate::music_library::MusicLibrary>()
            .ok_or_else(|| "the phone's music library is not loaded".to_string())?;
        return library.names(paths);
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(paths.iter().map(|path| picked_name(path)).collect())
    }
}

/// The name to fall back on when the system cannot say what a picked file is
/// called: the last part of the URI, which is all a plain path needs.
fn picked_name(path: &str) -> String {
    let last = path.rsplit(['/', '\\']).next().unwrap_or(path).trim();
    if last.is_empty() || last == "." || last == ".." {
        return "picked".to_string();
    }
    last.to_string()
}

/// Copies a picked file into the library, so the tagging pass has a real path
/// to read. The fs plugin is what opens a `content://` URI; a plain path goes
/// straight through it.
struct PickedStage {
    dir: PathBuf,
    path: PathBuf,
}

impl PickedStage {
    fn new(root: &Path, name: &str) -> Result<Self, String> {
        let parent = root.join(CONFIG_DIR).join(PICKED_DIR);
        fs::create_dir_all(&parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        loop {
            let dir = parent.join(identity::new_id());
            match fs::create_dir(&dir) {
                Ok(()) => return Ok(Self { path: dir.join(picked_name(name)), dir }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("could not create {}: {error}", dir.display())),
            }
        }
    }
}

impl Drop for PickedStage {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn stage_picked(app: &AppHandle, uri: &str, name: &str) -> Result<PickedStage, String> {
    let root = library_root(app)?;
    let staged = PickedStage::new(&root, name)?;
    stage_picked_at(app, uri, &staged.path)?;
    Ok(staged)
}

fn stage_picked_at(app: &AppHandle, uri: &str, staged: &Path) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.read(true);
    let picked = FilePath::from_str(uri).map_err(|e| format!("invalid file path: {e}"))?;
    let mut source = app
        .fs()
        .open(picked, options)
        .map_err(|e| format!("could not read the selected file: {e}"))?;
    let mut target = fs::OpenOptions::new().write(true).create_new(true).open(staged)
        .map_err(|e| format!("could not write {}: {e}", staged.display()))?;

    std::io::copy(&mut source, &mut target)
        .map_err(|e| format!("could not copy the selected file: {e}"))?;
    Ok(())
}

pub fn import_into_library(
    app: &AppHandle,
    source: &Path,
    create_playlist: bool,
    playlist_name: Option<&str>,
) -> Result<ImportOutcome, String> {
    let store = app.state::<Store>();
    let catalog = app.state::<Catalog>();
    let root = library_root(app)?;

    let artwork_index = match source_subdir(source, SOURCE_ARTWORK_DIR) {
        Some(dir) => SidecarIndex::build(&dir, IMAGE_EXTENSIONS),
        None => SidecarIndex::default(),
    };
    let lyrics_index = match source_subdir(source, SOURCE_LYRICS_DIR) {
        Some(dir) => SidecarIndex::build(&dir, LYRICS_EXTENSIONS),
        None => SidecarIndex::default(),
    };

    let mut playlist_tracks: Vec<String> = Vec::new();
    let mut landed: Vec<String> = Vec::new();
    let mut songs = 0usize;
    let mut images = 0usize;
    let mut lyrics = 0usize;
    let mut duplicates = 0usize;
    let mut similar = 0usize;
    let _ = app.emit(FOLDER_PROGRESS_EVENT, "Reading the selected folder...");
    let Contents { audio, skipped, mut errors } = contents(source)?;
    let total = audio.len();

    for (index, (key, path)) in audio.into_iter().enumerate() {
        let Some(file_name) = path.file_name().map(|name| name.to_string_lossy().into_owned())
        else {
            continue;
        };
        let status = format!("Importing {} of {total}: {file_name}", index + 1);
        let _ = app.emit(FOLDER_PROGRESS_EVENT, &status);
        let mut last_update = Instant::now();

        let outcome = import_one_with_progress(
            &root,
            &catalog,
            &path,
            &file_name,
            (&artwork_index, &lyrics_index),
            false,
            &mut |copied, bytes| {
                if copied == bytes || last_update.elapsed() >= Duration::from_millis(500) {
                    let message = if bytes > 0 && copied < bytes {
                        format!("{status} ({}%)", (copied as u128 * 100) / bytes as u128)
                    } else {
                        format!("Finishing {} of {total}: {file_name}", index + 1)
                    };
                    let _ = app.emit(FOLDER_PROGRESS_EVENT, message);
                    last_update = Instant::now();
                }
            },
        );

        match outcome {
            Ok((Placed::Duplicate, id)) => {
                duplicates += 1;
                playlist_tracks.push(id);
            }
            Ok((
                Placed::Added {
                    similar: near,
                    cover,
                    lyrics: words,
                },
                id,
            )) => {
                songs += 1;
                images += usize::from(cover);
                lyrics += usize::from(words);
                similar += usize::from(near);
                landed.push(id.clone());
                if let Ok(Some(row)) = catalog.track(&id) {
                    let _ = app.emit(LANDED_EVENT, vec![library::to_track(&row, &root)]);
                }
                playlist_tracks.push(id);
            }
            Err(error) => errors.push(format!("{key}: {error}")),
        }
    }

    let playlist = if create_playlist {
        let name = playlist_name
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| source.file_name().map(|name| name.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "Imported".to_string());
        playlists::write(app, &name, &playlist_tracks)?;
        Some(name)
    } else {
        None
    };

    let mut outcome = ImportOutcome {
        songs,
        images,
        lyrics,
        skipped,
        duplicates,
        similar,
        playlist,
        playlist_id: None,
        track_ids: landed,
        errors,
        state: PersistedState::default(),
    };

    outcome.refresh_state(app, &store);
    Ok(outcome)
}

/// The audio a folder holds, and how many of its files were not audio.
struct Contents {
    audio: Vec<(String, PathBuf)>,
    skipped: usize,
    errors: Vec<String>,
}

fn contents(folder: &Path) -> Result<Contents, String> {
    let mut found = Contents {
        audio: Vec::new(),
        skipped: 0,
        errors: Vec::new(),
    };
    let mut seen = HashSet::new();
    walk(folder, folder, &mut seen, &mut found)?;
    Ok(found)
}

fn walk(
    dir: &Path,
    folder: &Path,
    seen: &mut HashSet<PathBuf>,
    found: &mut Contents,
) -> Result<(), String> {
    let real = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    if !seen.insert(real) {
        return Ok(());
    }

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if dir == folder => return Err(format!("could not read {}: {error}", dir.display())),
        Err(error) => {
            found.errors.push(format!("could not read {}: {error}", dir.display()));
            return Ok(());
        }
    };
    let mut paths = Vec::new();
    for entry in entries {
        match entry {
            Ok(entry) => paths.push(entry.path()),
            Err(error) => found.errors.push(format!("could not read {}: {error}", dir.display())),
        }
    }
    // Sorted, so the same folder always imports its songs in the same order.
    paths.sort();

    for path in paths {
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                found.errors.push(format!("could not read {}: {error}", path.display()));
                continue;
            }
        };
        if metadata.is_dir() {
            walk(&path, folder, seen, found)?;
            continue;
        }
        if !metadata.is_file() || !has_extension(&path, AUDIO_EXTENSIONS) {
            found.skipped += 1;
            continue;
        }
        if let Some(key) = library::relative(folder, &path) {
            found.audio.push((key, path));
        }
    }

    Ok(())
}

fn import_one(
    root: &Path,
    catalog: &Catalog,
    source: &Path,
    file_name: &str,
    artwork_index: &SidecarIndex,
    lyrics_index: &SidecarIndex,
    generic_sidecars: bool,
) -> Result<(Placed, String), String> {
    import_one_with_progress(
        root, catalog, source, file_name, (artwork_index, lyrics_index), generic_sidecars, &mut |_, _| {},
    )
}

fn import_one_with_progress(
    root: &Path,
    catalog: &Catalog,
    source: &Path,
    file_name: &str,
    sidecars: (&SidecarIndex, &SidecarIndex),
    generic_sidecars: bool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(Placed, String), String> {
    let (artwork_index, lyrics_index) = sidecars;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .ok_or_else(|| "that file has no extension".to_string())?;

    let staged_path = staging_path(root, &extension)?;
    let hash = copy_and_hash_with_progress(source, &staged_path, progress)?;
    let staged = StagedFile(staged_path);
    let detected = if extension == "ogg" {
        lofty::probe::Probe::open(&staged.0)
            .and_then(|probe| probe.guess_file_type().map_err(Into::into))
            .ok()
            .and_then(|probe| probe.file_type())
    } else {
        None
    };
    let extension = if detected == Some(lofty::file::FileType::Opus) {
        "opus"
    } else {
        &extension
    };
    let _operation = catalog.library_operation();

    // The same audio is the same song. A row whose file is gone is adopted
    // instead, so a song deleted outside Wave comes back to its likes.
    let known = catalog.find_by_hash(&hash)?;
    if let Some(row) = &known {
        if !row.missing {
            return Ok((Placed::Duplicate, row.id.clone()));
        }
    }
    let (id, dir) = reserve_track_dir(root, catalog, known.as_ref(), &hash)?;
    let mut created = PlacedFiles { dir: dir.clone(), paths: Vec::new(), committed: false };

    let target = audio_path(root, &id, extension);
    place_staged(&staged.0, &target)?;
    created.paths.push(target.clone());

    // Covers and lyrics are matched by name here and only here: this is a folder
    // Wave has never seen, and its file names are all there is to go on.
    let stem = library::file_stem_lower(source);
    let wave_folder = stem == library::AUDIO_STEM;
    let cover = match artwork_index.resolve(&stem, file_name).or_else(|| {
        (wave_folder || generic_sidecars).then(|| source.parent().and_then(library::cover_in)).flatten()
    }) {
        Some(image) if library::cover_in(&dir).is_none() => {
            let extension = image
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("jpg")
                .to_lowercase();
            let target = cover_path(root, &id, &extension);
            copy_new(&image, &target)?;
            created.paths.push(target);
            true
        }
        _ => false,
    };

    let lyrics = match lyrics_index
        .resolve(&stem, file_name)
        .or_else(|| sidecar_beside(source))
        .or_else(|| (wave_folder || generic_sidecars).then(|| source.parent().and_then(library::lyrics_in)).flatten())
    {
        Some(text) if library::lyrics_in(&dir).is_none() => {
            let target = lyrics_path(root, &id);
            copy_new(&text, &target)?;
            created.paths.push(target);
            true
        }
        _ => false,
    };

    let row = library::describe(root, &id, &target, file_name, Some(&hash))?;
    catalog.upsert_track(&row)?;
    created.committed = true;

    // Another recording of the same song is not a duplicate, but it is worth
    // saying so rather than letting it look like one.
    let near = catalog
        .find_by_tags(
            &row.title,
            row.artist.as_deref().unwrap_or_default(),
            row.album.as_deref().unwrap_or_default(),
        )?
        .iter()
        .any(|other| other.id != row.id);

    Ok((
        Placed::Added {
            similar: near,
            cover,
            lyrics,
        },
        id,
    ))
}

/// Copies a file while hashing it, so the same bytes are never read twice.
fn copy_and_hash_with_progress(
    from: &Path,
    to: &Path,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<String, String> {
    let mut source =
        fs::File::open(from).map_err(|e| format!("could not read {}: {e}", from.display()))?;
    let bytes = source.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    let mut target = fs::OpenOptions::new().write(true).create_new(true).open(to)
        .map_err(|e| format!("could not write {}: {e}", to.display()))?;
    let mut hasher = identity::Hasher::new();
    let mut buffer = vec![0u8; COPY_BUFFER];
    let mut copied_bytes = 0u64;

    let copied = (|| {
        loop {
            let read = source
                .read(&mut buffer)
                .map_err(|e| format!("could not read {}: {e}", from.display()))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            target
                .write_all(&buffer[..read])
                .map_err(|e| format!("could not write {}: {e}", to.display()))?;
            copied_bytes += read as u64;
            progress(copied_bytes, bytes);
        }
        target
            .flush()
            .map_err(|e| format!("could not write {}: {e}", to.display()))
    })();
    drop(target);
    if let Err(error) = copied {
        let _ = fs::remove_file(to);
        return Err(error);
    }
    Ok(hasher.finish())
}

fn place_staged(from: &Path, to: &Path) -> Result<(), String> {
    if fs::hard_link(from, to).is_ok() {
        Ok(())
    } else {
        copy_new(from, to)
    }
}

fn copy_new(from: &Path, to: &Path) -> Result<(), String> {
    let mut source = fs::File::open(from)
        .map_err(|e| format!("could not read {}: {e}", from.display()))?;
    let mut target = fs::OpenOptions::new().write(true).create_new(true).open(to)
        .map_err(|e| format!("could not create {}: {e}", to.display()))?;
    if let Err(error) = std::io::copy(&mut source, &mut target) {
        drop(target);
        let _ = fs::remove_file(to);
        return Err(format!("could not write {}: {error}", to.display()));
    }
    Ok(())
}

fn reserve_track_dir(
    root: &Path,
    catalog: &Catalog,
    missing: Option<&crate::catalog::TrackRow>,
    hash: &str,
) -> Result<(String, PathBuf), String> {
    let songs = root.join(library::SONGS_DIR);
    fs::create_dir_all(&songs).map_err(|e| format!("could not create {}: {e}", songs.display()))?;

    if let Some(row) = missing {
        let dir = library::track_dir(root, &row.id);
        let recorded_exists = root.join(&row.rel_path).try_exists()
            .map_err(|e| format!("could not check {}: {e}", row.rel_path))?;
        if !recorded_exists && recovery_dir_available(&dir)? {
            match fs::create_dir(&dir) {
                Ok(()) => return Ok((row.id.clone(), dir)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if recovery_dir_available(&dir)? {
                        return Ok((row.id.clone(), dir));
                    }
                }
                Err(error) => return Err(format!("could not create {}: {error}", dir.display())),
            }
        }
    }

    let mut id = identity::id_for_hash(hash);
    loop {
        let dir = library::track_dir(root, &id);
        if catalog.track(&id)?.is_none() {
            match fs::create_dir(&dir) {
                Ok(()) => return Ok((id, dir)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(format!("could not create {}: {error}", dir.display())),
            }
        }
        id = identity::new_id();
    }
}

fn recovery_dir_available(dir: &Path) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(format!("could not check {}: {error}", dir.display())),
    };
    if !metadata.is_dir() {
        return Ok(false);
    }
    let entries = fs::read_dir(dir).map_err(|e| format!("could not read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("could not read {}: {e}", dir.display()))?;
        if has_extension(&entry.path(), AUDIO_EXTENSIONS) {
            return Ok(false);
        }
    }
    Ok(true)
}

struct StagedFile(PathBuf);

impl Drop for StagedFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn staging_path(root: &Path, extension: &str) -> Result<PathBuf, String> {
    let dir = root.join(CONFIG_DIR).join(STAGING_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir.join(format!("{}.{extension}", identity::new_id())))
}

pub fn remember_import(app: &AppHandle, source: &str, name: &str, outcome: &ImportOutcome) {
    if outcome.songs == 0 && outcome.duplicates == 0 {
        return;
    }

    let mut parts = vec![format!(
        "{} song{}",
        outcome.songs,
        if outcome.songs == 1 { "" } else { "s" }
    )];
    if outcome.duplicates > 0 {
        parts.push(format!("{} already here", outcome.duplicates));
    }
    if outcome.lyrics > 0 {
        parts.push(format!("{} lyrics", outcome.lyrics));
    }
    if !outcome.errors.is_empty() {
        parts.push(format!("{} failed", outcome.errors.len()));
    }

    crate::state::remember_import(
        app,
        crate::state::ImportRecord {
            source: source.to_string(),
            name: name.to_string(),
            detail: parts.join(", "),
        },
    );
}

fn sidecar_beside(song: &Path) -> Option<PathBuf> {
    let candidate = song.with_extension("lrc");
    candidate.is_file().then_some(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wave-import-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn matched(index: &SidecarIndex, title: &str, file_name: &str) -> Option<String> {
        index
            .resolve(title, file_name)
            .as_deref()
            .and_then(|path| path.file_name().map(|name| name.to_string_lossy().into_owned()))
    }

    fn write_test_wave(path: &Path) {
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
        fs::write(path, wav).unwrap();
    }

    #[test]
    fn matches_lyrics_by_song_name() {
        let dir = scratch("lyrics-name");
        for name in [
            "15 Step.lrc",
            "A Tout Le Monde - Remastered 2004.lrc",
            "notes.txt",
        ] {
            fs::write(dir.join(name), "[00:01.00]x").unwrap();
        }

        let index = SidecarIndex::build(&dir, LYRICS_EXTENSIONS);

        assert_eq!(
            matched(&index, "15 step", "15 Step.mp3"),
            Some("15 Step.lrc".to_string())
        );
        assert_eq!(
            matched(
                &index,
                "a tout le monde - remastered 2004",
                "A Tout Le Monde - Remastered 2004.mp3"
            ),
            Some("A Tout Le Monde - Remastered 2004.lrc".to_string())
        );
        assert_eq!(matched(&index, "notes", "notes.txt"), None);
        assert_eq!(matched(&index, "missing", "Missing.mp3"), None);
    }

    #[test]
    fn finds_a_sidecar_beside_the_song() {
        let dir = scratch("lyrics-beside");
        let song = dir.join("Agony.mp3");
        fs::write(&song, b"").unwrap();
        fs::write(dir.join("Agony.lrc"), "[00:01.00]x").unwrap();

        assert_eq!(
            sidecar_beside(&song).as_deref().and_then(|path| path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())),
            Some("Agony.lrc".to_string())
        );
        assert_eq!(sidecar_beside(&dir.join("Other.mp3")), None);
    }

    #[test]
    fn hashes_the_bytes_it_copies() {
        let dir = scratch("copy");
        let from = dir.join("from.bin");
        let to = dir.join("to.bin");
        fs::write(&from, b"0123456789").unwrap();

        let hash = copy_and_hash_with_progress(&from, &to, &mut |_, _| {}).unwrap();

        assert_eq!(fs::read(&to).unwrap(), b"0123456789");
        assert_eq!(hash, identity::content_hash(&from).unwrap());
    }

    #[test]
    fn reports_bytes_copied_while_hashing() {
        let dir = scratch("copy-progress");
        let from = dir.join("from.bin");
        let to = dir.join("to.bin");
        let data = vec![42; COPY_BUFFER * 2 + 17];
        fs::write(&from, &data).unwrap();
        let mut updates = Vec::new();

        let hash = copy_and_hash_with_progress(&from, &to, &mut |copied, total| {
            updates.push((copied, total));
        }).unwrap();

        assert!(updates.len() >= 3);
        assert!(updates.windows(2).all(|pair| pair[0].0 < pair[1].0));
        assert!(updates.iter().all(|(_, total)| *total == data.len() as u64));
        assert_eq!(updates.last(), Some(&(data.len() as u64, data.len() as u64)));
        assert_eq!(fs::read(to).unwrap(), data);
        assert_eq!(hash, identity::content_hash(&from).unwrap());
    }

    #[test]
    fn staged_placement_keeps_existing_files_and_survives_cleanup() {
        let dir = scratch("place-staged");
        let source = dir.join("staged");
        let target = dir.join("audio");
        fs::write(&source, b"new audio").unwrap();
        fs::write(&target, b"existing audio").unwrap();

        assert!(place_staged(&source, &target).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"existing audio");
        fs::remove_file(&target).unwrap();
        place_staged(&source, &target).unwrap();
        drop(StagedFile(source.clone()));
        assert!(!source.exists());
        assert_eq!(fs::read(target).unwrap(), b"new audio");
    }

    #[test]
    fn picked_staging_is_private_and_only_cleans_its_own_files() {
        let root = scratch("picked-staging");
        let first = PickedStage::new(&root, "Song.mp3").unwrap();
        let second = PickedStage::new(&root, "Song.mp3").unwrap();
        fs::write(&first.path, b"first").unwrap();
        fs::write(&second.path, b"second").unwrap();
        assert_ne!(first.path, second.path);
        drop(first);
        assert_eq!(fs::read(&second.path).unwrap(), b"second");
        assert!(second.dir.is_dir());
        let dir = second.dir.clone();
        drop(second);
        assert!(!dir.exists());
    }

    #[test]
    fn names_a_song_by_where_it_sits_under_the_folder() {
        let dir = scratch("nested");
        for folder in ["0", "1"] {
            fs::create_dir_all(dir.join(folder)).unwrap();
            fs::write(dir.join(folder).join("audio.mp3"), b"a song").unwrap();
        }
        fs::write(dir.join("notes.txt"), b"x").unwrap();

        let found = contents(&dir).unwrap();

        let keys: Vec<&str> = found.audio.iter().map(|(key, _)| key.as_str()).collect();
        assert_eq!(keys, vec!["0/audio.mp3", "1/audio.mp3"]);
        assert_eq!(found.skipped, 1);
    }

    #[test]
    fn finds_the_songs_in_album_subfolders() {
        let dir = scratch("albums");
        fs::create_dir_all(dir.join("Album")).unwrap();
        fs::write(dir.join("Album").join("Song.mp3"), b"a song").unwrap();

        let found = contents(&dir).unwrap();

        assert_eq!(found.audio.len(), 1);
        assert_eq!(found.audio[0].0, "Album/Song.mp3");
    }

    #[test]
    fn interrupted_large_folder_import_can_resume_without_losing_songs() {
        let root = scratch("resume-folder");
        let source = root.join("source");
        let catalog = Catalog::in_memory().unwrap();
        for index in 0..50u16 {
            let dir = source.join(format!("album-{}", index / 10));
            fs::create_dir_all(&dir).unwrap();
            let path = dir.join(format!("book-{index:02}.wav"));
            write_test_wave(&path);
            let mut bytes = fs::read(&path).unwrap();
            let end = bytes.len();
            bytes[end - 2..].copy_from_slice(&index.to_le_bytes());
            fs::write(&path, bytes).unwrap();
        }
        fs::write(source.join("invalid.wav"), b"not audio").unwrap();
        let found = contents(&source).unwrap();
        assert_eq!(found.audio.len(), 51);
        let images = SidecarIndex::default();
        let lyrics = SidecarIndex::default();
        let import = |path: &Path| {
            import_one(&root, &catalog, path, &path.file_name().unwrap().to_string_lossy(), &images, &lyrics, false)
        };
        for (_, path) in found.audio.iter().take(5) {
            assert!(matches!(import(path).unwrap().0, Placed::Added { .. }));
        }

        let mut added = 0;
        let mut duplicates = 0;
        let mut errors = 0;
        for (_, path) in &found.audio {
            match import(path) {
                Ok((Placed::Added { .. }, _)) => added += 1,
                Ok((Placed::Duplicate, _)) => duplicates += 1,
                Err(_) => errors += 1,
            }
        }
        assert_eq!((added, duplicates, errors), (45, 5, 1));
        assert_eq!(catalog.present_count().unwrap(), 50);
        assert_eq!(fs::read_dir(root.join(CONFIG_DIR).join(STAGING_DIR)).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn reports_unreadable_entries_and_imports_other_files() {
        use std::os::unix::fs::symlink;

        let dir = scratch("unreadable-entry");
        fs::write(dir.join("Song.mp3"), b"a song").unwrap();
        symlink(dir.join("missing"), dir.join("Broken.mp3")).unwrap();

        let found = contents(&dir).unwrap();

        assert_eq!(found.audio.len(), 1);
        assert_eq!(found.audio[0].0, "Song.mp3");
        assert_eq!(found.errors.len(), 1);
        assert!(found.errors[0].contains("Broken.mp3"));
    }

    #[cfg(unix)]
    #[test]
    fn reports_unreadable_subfolders_and_imports_other_files() {
        use std::os::unix::fs::PermissionsExt;

        let dir = scratch("unreadable-subfolder");
        let blocked = dir.join("Blocked");
        fs::create_dir(&blocked).unwrap();
        fs::write(dir.join("Song.mp3"), b"a song").unwrap();
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read_dir(&blocked).is_ok() {
            fs::set_permissions(&blocked, fs::Permissions::from_mode(0o700)).unwrap();
            return;
        }

        let result = contents(&dir);
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o700)).unwrap();
        let found = result.unwrap();
        assert_eq!(found.audio.len(), 1);
        assert_eq!(found.audio[0].0, "Song.mp3");
        assert_eq!(found.errors.len(), 1);
        assert!(found.errors[0].contains("Blocked"));
    }

    #[test]
    fn imports_vorbis_and_opus_with_the_same_ogg_extension() {
        let root = scratch("mixed-ogg");
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("Vorbis.ogg"), include_bytes!("../../tests/fixtures/import-vorbis.ogg")).unwrap();
        fs::write(source.join("Opus.ogg"), include_bytes!("../../tests/fixtures/import-opus.ogg")).unwrap();
        let catalog = Catalog::in_memory().unwrap();
        let unfiled = library::describe(&root, "unfiled", &source.join("Opus.ogg"), "Opus.ogg", None).unwrap();
        assert_eq!(unfiled.codec, "Opus");

        let found = contents(&source).unwrap();
        assert_eq!(found.audio.len(), 2);
        for (name, path) in found.audio {
            let (placed, id) = import_one(
                &root, &catalog, &path, &name, &SidecarIndex::default(), &SidecarIndex::default(), false,
            ).unwrap();
            assert!(matches!(placed, Placed::Added { .. }));
            let row = catalog.track(&id).unwrap().unwrap();
            assert_eq!(row.codec, if name == "Opus.ogg" { "Opus" } else { "Vorbis" });
            assert_eq!(row.original_name, name);
            let audio = root.join(&row.rel_path);
            assert_eq!(audio.extension().unwrap(), if name == "Opus.ogg" { "opus" } else { "ogg" });
            assert_eq!(library::describe(&root, &id, &audio, &name, None).unwrap().codec, row.codec);
            assert!(matches!(import_one(
                &root, &catalog, &path, &name, &SidecarIndex::default(), &SidecarIndex::default(), false,
            ).unwrap().0, Placed::Duplicate));
            crate::genre_fetch::write_genre(&audio.to_string_lossy(), "Test").unwrap();
            assert_eq!(library::describe(&root, &id, &audio, &name, None).unwrap().genre.as_deref(), Some("Test"));
        }
        assert_eq!(catalog.present_count().unwrap(), 2);
    }

    #[test]
    fn stages_a_file_beside_the_catalog() {
        let root = scratch("stage-path");
        let path = staging_path(&root, "mp3").unwrap();

        assert_eq!(path.extension().unwrap(), "mp3");
        assert!(path.parent().unwrap().is_dir());
    }

    #[test]
    fn imports_wave_song_folder_with_its_cover_and_lyrics() {
        let root = scratch("wave-folder");
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        let audio = source.join("audio.wav");
        write_test_wave(&audio);
        fs::write(source.join("cover.jpg"), b"cover").unwrap();
        fs::write(source.join("lyrics.lrc"), "[00:01.00]words").unwrap();

        let catalog = Catalog::in_memory().unwrap();
        let (placed, id) = import_one(
            &root, &catalog, &audio, "audio.wav", &SidecarIndex::default(), &SidecarIndex::default(),
            false,
        ).unwrap();
        assert!(matches!(placed, Placed::Added { cover: true, lyrics: true, .. }));
        assert_eq!(fs::read(cover_path(&root, &id, "jpg")).unwrap(), b"cover");
        assert_eq!(fs::read_to_string(lyrics_path(&root, &id)).unwrap(), "[00:01.00]words");
        assert!(audio.is_file());
    }

    #[test]
    fn imports_wave_song_folder_with_a_replaced_cover() {
        let root = scratch("wave-folder-replaced-cover");
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        let audio = source.join("audio.wav");
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
        let cover = source.join(format!("cover-{:020}-{}.png", 1, identity::new_id()));
        fs::write(&cover, b"replaced cover").unwrap();

        let catalog = Catalog::in_memory().unwrap();
        let (placed, id) = import_one(
            &root, &catalog, &audio, "audio.wav", &SidecarIndex::default(), &SidecarIndex::default(),
            false,
        ).unwrap();
        assert!(matches!(placed, Placed::Added { cover: true, .. }));
        assert_eq!(fs::read(cover_path(&root, &id, "png")).unwrap(), b"replaced cover");
    }

    fn import_test_song(root: &Path, catalog: &Catalog, source: &Path, generic: bool) -> (Placed, String) {
        let index = SidecarIndex::build(source.parent().unwrap(), IMAGE_EXTENSIONS);
        let lyrics = SidecarIndex::build(source.parent().unwrap(), LYRICS_EXTENSIONS);
        import_one(root, catalog, source, "Song.wav", &index, &lyrics, generic).unwrap()
    }

    #[test]
    fn reimport_after_edit_does_not_replace_the_edited_record_or_file() {
        use lofty::config::WriteOptions;
        use lofty::file::FileType;
        use lofty::prelude::{Accessor, TagExt};
        use lofty::tag::Tag;

        let root = scratch("edited-collision");
        let source = root.join("Song.wav");
        write_test_wave(&source);
        let catalog = Catalog::in_memory().unwrap();
        let (_, original_id) = import_test_song(&root, &catalog, &source, false);
        let path = audio_path(&root, &original_id, "wav");
        let old = catalog.track(&original_id).unwrap().unwrap();
        let mut tag = Tag::new(FileType::Wav.primary_tag_type());
        tag.set_title("Edited title".to_string());
        tag.save_to_path(&path, WriteOptions::default()).unwrap();
        let mut edited = library::describe(&root, &original_id, &path, "Song.wav", None).unwrap();
        edited.added_at = old.added_at;
        catalog.upsert_edited_track(&edited, old.bytes).unwrap();
        let edited_bytes = fs::read(&path).unwrap();

        let (placed, new_id) = import_test_song(&root, &catalog, &source, false);
        assert!(matches!(placed, Placed::Added { .. }));
        assert_ne!(new_id, original_id);
        assert_eq!(fs::read(&path).unwrap(), edited_bytes);
        assert_eq!(catalog.track(&original_id).unwrap().unwrap().title, "Edited title");
        assert_eq!(fs::read(audio_path(&root, &new_id, "wav")).unwrap(), fs::read(&source).unwrap());
        assert!(matches!(import_test_song(&root, &catalog, &source, false).0, Placed::Duplicate));
    }

    #[test]
    fn concurrent_imports_choose_one_new_track_after_an_id_collision() {
        use std::sync::{Arc, Barrier};
        let root = scratch("concurrent-collision");
        let source = root.join("Song.wav");
        write_test_wave(&source);
        let hash = identity::content_hash(&source).unwrap();
        let old_id = identity::id_for_hash(&hash);
        let occupied = library::track_dir(&root, &old_id);
        fs::create_dir_all(&occupied).unwrap();
        fs::write(occupied.join("audio.mp3"), b"existing audio").unwrap();
        let catalog = Arc::new(Catalog::in_memory().unwrap());
        let barrier = Arc::new(Barrier::new(8));
        let threads: Vec<_> = (0..8).map(|_| {
            let (root, source, catalog, barrier) = (root.clone(), source.clone(), catalog.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                import_test_song(&root, &catalog, &source, false)
            })
        }).collect();
        let results: Vec<_> = threads.into_iter().map(|thread| thread.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|(placed, _)| matches!(placed, Placed::Added { .. })).count(), 1);
        assert_eq!(results.iter().filter(|(placed, _)| matches!(placed, Placed::Duplicate)).count(), 7);
        assert!(results.iter().all(|(_, id)| id == &results[0].1));
        assert_ne!(results[0].1, old_id);
        assert_eq!(fs::read(occupied.join("audio.mp3")).unwrap(), b"existing audio");
        assert_eq!(catalog.tracks().unwrap().len(), 1);
        assert_eq!(fs::read_dir(root.join(CONFIG_DIR).join(STAGING_DIR)).unwrap().count(), 0);
    }

    #[test]
    fn a_catalog_id_collision_without_a_directory_is_not_overwritten() {
        let root = scratch("catalog-collision");
        let source = root.join("Song.wav");
        write_test_wave(&source);
        let id = identity::id_for_hash(&identity::content_hash(&source).unwrap());
        let catalog = Catalog::in_memory().unwrap();
        let old = crate::catalog::TrackRow {
            id: id.clone(),
            rel_path: format!("songs/{id}/audio.mp3"),
            content_hash: Some("different".into()),
            title: "Existing".into(),
            ..Default::default()
        };
        catalog.upsert_track(&old).unwrap();
        let (_, new_id) = import_test_song(&root, &catalog, &source, false);
        assert_ne!(id, new_id);
        assert_eq!(catalog.track(&id).unwrap().unwrap().title, "Existing");
    }

    #[test]
    fn missing_track_recovery_preserves_existing_sidecars_and_other_audio() {
        let root = scratch("missing-recovery");
        let source = root.join("Song.wav");
        write_test_wave(&source);
        let catalog = Catalog::in_memory().unwrap();
        let (_, id) = import_test_song(&root, &catalog, &source, false);
        let dir = library::track_dir(&root, &id);
        fs::remove_file(audio_path(&root, &id, "wav")).unwrap();
        fs::write(dir.join("cover.jpg"), b"kept cover").unwrap();
        fs::write(dir.join("lyrics.lrc"), b"kept lyrics").unwrap();
        fs::write(root.join("Song.jpg"), b"new cover").unwrap();
        fs::write(root.join("Song.lrc"), b"new lyrics").unwrap();
        catalog.sync_scan(&[], &[], std::slice::from_ref(&id)).unwrap();
        let (_, restored) = import_test_song(&root, &catalog, &source, false);
        assert_eq!(restored, id);
        assert_eq!(fs::read(dir.join("cover.jpg")).unwrap(), b"kept cover");
        assert_eq!(fs::read(dir.join("lyrics.lrc")).unwrap(), b"kept lyrics");

        fs::remove_file(audio_path(&root, &id, "wav")).unwrap();
        fs::write(dir.join("renamed.mp3"), b"other audio").unwrap();
        catalog.sync_scan(&[], &[], std::slice::from_ref(&id)).unwrap();
        let (_, new_id) = import_test_song(&root, &catalog, &source, false);
        assert_ne!(new_id, id);
        assert_eq!(fs::read(dir.join("renamed.mp3")).unwrap(), b"other audio");
    }

    #[test]
    fn generic_sidecars_belong_only_to_a_single_song_folder() {
        let root = scratch("generic-sidecars");
        let source_dir = root.join("source");
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("Song.wav");
        write_test_wave(&source);
        fs::write(source_dir.join("cover.jpg"), b"generic cover").unwrap();
        fs::write(source_dir.join("lyrics.lrc"), b"generic lyrics").unwrap();
        let catalog = Catalog::in_memory().unwrap();

        let (placed, id) = import_test_song(&root, &catalog, &source, true);
        assert!(matches!(placed, Placed::Added { cover: true, lyrics: true, .. }));
        assert_eq!(fs::read(cover_path(&root, &id, "jpg")).unwrap(), b"generic cover");
        assert_eq!(fs::read(lyrics_path(&root, &id)).unwrap(), b"generic lyrics");

        let other_root = scratch("generic-sidecars-multiple");
        let other_catalog = Catalog::in_memory().unwrap();
        let (placed, _) = import_test_song(&other_root, &other_catalog, &source, false);
        assert!(matches!(placed, Placed::Added { cover: false, lyrics: false, .. }));
        fs::write(source_dir.join("Song.jpg"), b"song cover").unwrap();
        fs::write(source_dir.join("Song.lrc"), b"song lyrics").unwrap();
        let named_root = scratch("named-sidecars");
        let named_catalog = Catalog::in_memory().unwrap();
        let (placed, id) = import_test_song(&named_root, &named_catalog, &source, true);
        assert!(matches!(placed, Placed::Added { cover: true, lyrics: true, .. }));
        assert_eq!(fs::read(cover_path(&named_root, &id, "jpg")).unwrap(), b"song cover");
        assert_eq!(fs::read(lyrics_path(&named_root, &id)).unwrap(), b"song lyrics");
    }

    #[test]
    fn phone_folder_shares_covers_but_not_ambiguous_generic_lyrics() {
        let versioned = format!("cover-{:020}-{}.png", 1, identity::new_id());
        assert!(phone_generic_sidecar("COVER.JPG", false));
        assert!(phone_generic_sidecar(&versioned, false));
        assert!(!phone_generic_sidecar("cover-other.jpg", false));
        assert!(!phone_generic_sidecar("lyrics.lrc", false));
        assert!(phone_generic_sidecar("LYRICS.LRC", true));
        assert!(!phone_generic_sidecar("lyrics.txt", true));
    }

    #[test]
    fn phone_folder_import_prefers_named_art_and_shares_versioned_art() {
        let source = scratch("phone-album-source");
        let versioned = format!("cover-{:020}-{}.png", 1, identity::new_id());
        for (name, data) in [
            ("cover.jpg", b"album cover".as_slice()),
            (versioned.as_str(), b"new album cover".as_slice()),
            ("First.jpg", b"song cover".as_slice()),
            ("First.lrc", b"song lyrics".as_slice()),
            ("lyrics.lrc", b"ambiguous lyrics".as_slice()),
        ] {
            fs::write(source.join(name), data).unwrap();
        }
        for (name, cover_extension, cover, has_lyrics) in [
            ("First.wav", "jpg", b"song cover".as_slice(), true),
            ("Second.wav", "png", b"new album cover".as_slice(), false),
        ] {
            let root = scratch(&format!("phone-album-{name}"));
            let stage = root.join("source");
            fs::create_dir_all(&stage).unwrap();
            let audio = stage.join(name);
            write_test_wave(&audio);
            let stem = library::file_stem_lower(&audio);
            for entry in fs::read_dir(&source).unwrap() {
                let entry = entry.unwrap();
                let sidecar = entry.file_name().to_string_lossy().into_owned();
                if library::file_stem_lower(Path::new(&sidecar)) == stem
                    || phone_generic_sidecar(&sidecar, false)
                {
                    fs::copy(entry.path(), stage.join(sidecar)).unwrap();
                }
            }
            let catalog = Catalog::in_memory().unwrap();
            let images = SidecarIndex::build(&stage, IMAGE_EXTENSIONS);
            let lyrics = SidecarIndex::build(&stage, LYRICS_EXTENSIONS);
            let (placed, id) = import_one(&root, &catalog, &audio, name, &images, &lyrics, true).unwrap();
            assert!(matches!(placed, Placed::Added { cover: true, .. }));
            assert_eq!(fs::read(cover_path(&root, &id, cover_extension)).unwrap(), cover);
            assert_eq!(lyrics_path(&root, &id).exists(), has_lyrics);
            if has_lyrics {
                assert_eq!(fs::read(lyrics_path(&root, &id)).unwrap(), b"song lyrics");
            }
        }
    }

    #[test]
    fn indexed_audio_uses_names_or_known_mime_types() {
        assert_eq!(indexed_audio_name("Song.MP3", None).as_deref(), Some("Song.MP3"));
        assert_eq!(indexed_audio_name("Song", Some("audio/flac")).as_deref(), Some("Song.flac"));
        assert_eq!(indexed_audio_name("nested/Song", Some("audio/mpeg")).as_deref(), Some("Song.mp3"));
        assert_eq!(indexed_audio_name("Movie.mp4", Some("video/mp4")), None);
        assert_eq!(indexed_audio_name("unknown", None), None);
    }

    #[test]
    fn picked_files_accept_supported_extensions_and_reject_other_files() {
        for extension in AUDIO_EXTENSIONS {
            assert!(validate_picked_audio(&format!("Song.{}", extension.to_uppercase())).is_ok());
        }
        for name in ["cover.jpg", "notes.txt", "movie.mp4", "no-extension"] {
            assert_eq!(validate_picked_audio(name), Err(format!("{name}: unsupported audio format")));
        }
    }

    #[test]
    fn fetched_writes_reject_stale_rows_and_refresh_the_audio_hash() {
        use lofty::config::WriteOptions;
        use lofty::file::FileType;
        use lofty::prelude::{Accessor, TagExt};
        use lofty::tag::Tag;

        let root = scratch("fetched-refresh");
        let source = root.join("Song.wav");
        write_test_wave(&source);
        let catalog = Catalog::in_memory().unwrap();
        let (_, id) = import_test_song(&root, &catalog, &source, false);
        let before = catalog.track(&id).unwrap().unwrap();
        let snapshot = library::to_track(&before, &root);
        assert!(fetched_track(&root, &catalog, &snapshot).is_ok());
        let mut tag = Tag::new(FileType::Wav.primary_tag_type());
        tag.set_title("Updated".to_string());
        tag.save_to_path(&snapshot.path, WriteOptions::default()).unwrap();
        assert!(fetched_track(&root, &catalog, &snapshot).is_err());

        let after = refresh_after_tags(&root, &catalog, &before).unwrap();
        assert_eq!(after.title, "Updated");
        assert_ne!(before.content_hash, after.content_hash);
        assert_eq!(catalog.track(&id).unwrap().unwrap().content_hash, after.content_hash);
        assert!(fetched_track(&root, &catalog, &snapshot).is_err());
        catalog.delete_tracks(&[id]).unwrap();
        assert!(fetched_track(&root, &catalog, &snapshot).is_err());
    }
}
