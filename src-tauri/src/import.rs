use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::catalog::Catalog;
use crate::identity;
use crate::library::{
    self, audio_path, cover_path, has_extension, library_root, lyrics_path, source_subdir,
    SidecarIndex, AUDIO_EXTENSIONS, CONFIG_DIR, IMAGE_EXTENSIONS, LYRICS_EXTENSIONS,
    SOURCE_ARTWORK_DIR, SOURCE_LYRICS_DIR,
};
use crate::playlists;
use crate::state::{PersistedState, Store};

const COPY_BUFFER: usize = 128 * 1024;

/// Where a song sits while it is being hashed, so nothing lands in the library
/// until it is known what it is.
const STAGING_DIR: &str = "staging";

#[derive(Debug, Serialize)]
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
    pub errors: Vec<String>,
    pub state: PersistedState,
}

/// An import, plus which song each source file became. Only the callers that
/// write their own playlist need the ids.
pub struct Imported {
    pub outcome: ImportOutcome,
    pub by_source: HashMap<String, String>,
}

enum Placed {
    /// The library already held this audio, so nothing was written.
    Duplicate,
    Added {
        similar: bool,
        cover: bool,
        lyrics: bool,
    },
}

#[tauri::command(async)]
pub fn import_folder(
    app: AppHandle,
    folder: String,
    create_playlist: bool,
    playlist_name: Option<String>,
) -> Result<ImportOutcome, String> {
    let source = PathBuf::from(&folder);
    if !source.is_dir() {
        return Err(format!("{folder} is not a folder"));
    }

    let mut imported = import_into_library(&app, &source, create_playlist, playlist_name.as_deref())?;
    let outcome = &mut imported.outcome;

    let name = outcome
        .playlist
        .clone()
        .or_else(|| source.file_name().map(|name| name.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "Imported folder".to_string());
    remember_import(&app, "folder", &name, outcome);

    outcome.state = app.state::<Store>().snapshot();
    Ok(imported.outcome)
}

pub fn import_into_library(
    app: &AppHandle,
    source: &Path,
    create_playlist: bool,
    playlist_name: Option<&str>,
) -> Result<Imported, String> {
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

    clear_staging(&root);

    let mut by_source: HashMap<String, String> = HashMap::new();
    let mut playlist_tracks: Vec<String> = Vec::new();
    let mut songs = 0usize;
    let mut images = 0usize;
    let mut lyrics = 0usize;
    let mut duplicates = 0usize;
    let mut similar = 0usize;
    let mut errors = Vec::new();

    let Contents { audio, skipped } = contents(source)?;

    for (key, path) in audio {
        let Some(file_name) = path.file_name().map(|name| name.to_string_lossy().into_owned())
        else {
            continue;
        };

        let outcome = import_one(
            &root,
            &catalog,
            &path,
            &file_name,
            &artwork_index,
            &lyrics_index,
        );

        match outcome {
            Ok((Placed::Duplicate, id)) => {
                duplicates += 1;
                playlist_tracks.push(id.clone());
                by_source.insert(key, id);
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
                playlist_tracks.push(id.clone());
                by_source.insert(key, id);
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

    let outcome = ImportOutcome {
        songs,
        images,
        lyrics,
        skipped,
        duplicates,
        similar,
        playlist,
        errors,
        state: playlists::refresh(app, &store),
    };

    Ok(Imported { outcome, by_source })
}

/// The audio a folder holds, and how many of its files were not audio.
struct Contents {
    audio: Vec<(String, PathBuf)>,
    skipped: usize,
}

fn contents(folder: &Path) -> Result<Contents, String> {
    let mut found = Contents {
        audio: Vec::new(),
        skipped: 0,
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

    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| format!("could not read {}: {e}", dir.display()))?
        .flatten()
        .map(|entry| entry.path())
        .collect();
    // Sorted, so the same folder always imports its songs in the same order.
    entries.sort();

    for path in entries {
        if path.is_dir() {
            walk(&path, folder, seen, found)?;
            continue;
        }
        if !path.is_file() || !has_extension(&path, AUDIO_EXTENSIONS) {
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
) -> Result<(Placed, String), String> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .ok_or_else(|| "that file has no extension".to_string())?;

    let staged = staging_path(root, &extension)?;
    let hash = copy_and_hash(source, &staged)?;

    // The same audio is the same song. A row whose file is gone is adopted
    // instead, so a song deleted outside Wave comes back to its likes.
    let known = catalog.find_by_hash(&hash)?;
    if let Some(row) = &known {
        if !row.missing {
            let _ = fs::remove_file(&staged);
            return Ok((Placed::Duplicate, row.id.clone()));
        }
    }
    let id = known
        .map(|row| row.id)
        .unwrap_or_else(|| identity::id_for_hash(&hash));

    let dir = library::track_dir(root, &id);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let target = audio_path(root, &id, &extension);
    if target.exists() {
        let _ = fs::remove_file(&target);
    }
    move_file(&staged, &target)?;

    // Covers and lyrics are matched by name here and only here: this is a folder
    // Wave has never seen, and its file names are all there is to go on.
    let stem = library::file_stem_lower(source);
    let cover = match artwork_index.resolve(&stem, file_name) {
        Some(image) => {
            let extension = image
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("jpg")
                .to_lowercase();
            let target = cover_path(root, &id, &extension);
            fs::copy(&image, &target).map_err(|e| format!("could not copy a cover: {e}"))?;
            true
        }
        None => false,
    };

    let lyrics = match lyrics_index
        .resolve(&stem, file_name)
        .or_else(|| sidecar_beside(source))
    {
        Some(text) => {
            let target = lyrics_path(root, &id);
            fs::copy(&text, &target).map_err(|e| format!("could not copy lyrics: {e}"))?;
            true
        }
        None => false,
    };

    let row = library::describe(root, &id, &target, file_name)?;
    catalog.upsert_track(&row)?;

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
fn copy_and_hash(from: &Path, to: &Path) -> Result<String, String> {
    let mut source =
        fs::File::open(from).map_err(|e| format!("could not read {}: {e}", from.display()))?;
    let mut target =
        fs::File::create(to).map_err(|e| format!("could not write {}: {e}", to.display()))?;
    let mut hasher = identity::Hasher::new();
    let mut buffer = vec![0u8; COPY_BUFFER];

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
    }

    target
        .flush()
        .map_err(|e| format!("could not write {}: {e}", to.display()))?;
    Ok(hasher.finish())
}

/// A rename where that works, and a copy where it does not, so a library on
/// another volume is still importable.
fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    fs::copy(from, to).map_err(|e| format!("could not file {}: {e}", to.display()))?;
    let _ = fs::remove_file(from);
    Ok(())
}

fn staging_path(root: &Path, extension: &str) -> Result<PathBuf, String> {
    let dir = root.join(CONFIG_DIR).join(STAGING_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir.join(format!("{}.{extension}", identity::new_id())))
}

/// Drops whatever a previous import left behind.
fn clear_staging(root: &Path) {
    let dir = root.join(CONFIG_DIR).join(STAGING_DIR);
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let _ = fs::remove_file(entry.path());
    }
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

        let hash = copy_and_hash(&from, &to).unwrap();

        assert_eq!(fs::read(&to).unwrap(), b"0123456789");
        assert_eq!(hash, identity::content_hash(&from).unwrap());
    }

    #[test]
    fn a_staging_directory_is_emptied_before_each_import() {
        let root = scratch("staging");
        let dir = root.join(CONFIG_DIR).join(STAGING_DIR);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("leftover.mp3"), b"half a song").unwrap();

        clear_staging(&root);

        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        clear_staging(&scratch("staging-fresh"));
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
    fn stages_a_file_beside_the_catalog() {
        let root = scratch("stage-path");
        let path = staging_path(&root, "mp3").unwrap();

        assert_eq!(path.extension().unwrap(), "mp3");
        assert!(path.parent().unwrap().is_dir());
    }
}
