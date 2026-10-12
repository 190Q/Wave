use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::library::{
    file_stem_lower, has_extension, library_root, read_index, source_subdir, write_index,
    SidecarIndex, TrackPaths, AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, IMAGES_DIR, LYRICS_DIR,
    LYRICS_EXTENSIONS, SONGS_DIR, SOURCE_ARTWORK_DIR, SOURCE_LYRICS_DIR,
};
use crate::playlists;
use crate::state::{PersistedState, Store};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub songs: usize,
    pub images: usize,
    pub lyrics: usize,
    /// Files in the folder that were not audio.
    pub skipped: usize,
    pub playlist: Option<String>,
    pub errors: Vec<String>,
    pub state: PersistedState,
}

#[tauri::command]
pub fn import_folder(
    app: AppHandle,
    store: State<'_, Store>,
    paths: State<'_, TrackPaths>,
    folder: String,
    create_playlist: bool,
    playlist_name: Option<String>,
) -> Result<ImportOutcome, String> {
    let root = library_root(&app)?;
    let source = PathBuf::from(&folder);
    if !source.is_dir() {
        return Err(format!("{folder} is not a folder"));
    }

    let artwork_index = match source_subdir(&source, SOURCE_ARTWORK_DIR) {
        Some(dir) => SidecarIndex::build(&dir, IMAGE_EXTENSIONS),
        None => SidecarIndex::default(),
    };
    let lyrics_index = match source_subdir(&source, SOURCE_LYRICS_DIR) {
        Some(dir) => SidecarIndex::build(&dir, LYRICS_EXTENSIONS),
        None => SidecarIndex::default(),
    };

    let songs_dir = root.join(SONGS_DIR);
    let images_dir = root.join(IMAGES_DIR);
    let lyrics_dir = root.join(LYRICS_DIR);
    let mut library_index = read_index(&root);

    let mut imported: Vec<String> = Vec::new();
    let mut songs = 0usize;
    let mut images = 0usize;
    let mut lyrics = 0usize;
    let mut skipped = 0usize;
    let mut errors = Vec::new();

    let entries = fs::read_dir(&source).map_err(|e| format!("could not read {folder}: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if !has_extension(&path, AUDIO_EXTENSIONS) {
            skipped += 1;
            continue;
        }

        let Some(file_name) = path.file_name().map(|name| name.to_string_lossy().into_owned()) else {
            continue;
        };
        let song_relative = format!("{SONGS_DIR}/{file_name}");

        let song_destination = songs_dir.join(&file_name);
        if !song_destination.exists() {
            if let Err(error) = fs::copy(&path, &song_destination) {
                errors.push(format!("could not copy {file_name}: {error}"));
                continue;
            }
        }
        songs += 1;
        imported.push(song_relative.clone());

        // Covers and lyrics are matched exactly the way the scanner matches them.
        let title = file_stem_lower(&path);

        if let Some(image) = artwork_index.resolve(&title, &file_name) {
            if let Some(image_name) = file_name_of(&image) {
                let image_relative = format!("{IMAGES_DIR}/{image_name}");
                let image_destination = images_dir.join(&image_name);
                if !image_destination.exists() {
                    match fs::copy(&image, &image_destination) {
                        Ok(_) => images += 1,
                        Err(error) => errors.push(format!("could not copy {image_name}: {error}")),
                    }
                }
                library_index.songs.insert(song_relative.clone(), image_relative);
            }
        }

        // Lyrics come from the folder, or from a sidecar sitting beside the song.
        let lyrics_source = lyrics_index
            .resolve(&title, &file_name)
            .or_else(|| sidecar_beside(&path));
        if let Some(lyrics_source) = lyrics_source {
            if let Some(lyrics_name) = file_name_of(&lyrics_source) {
                let lyrics_relative = format!("{LYRICS_DIR}/{lyrics_name}");
                let lyrics_destination = lyrics_dir.join(&lyrics_name);
                if !lyrics_destination.exists() {
                    match fs::copy(&lyrics_source, &lyrics_destination) {
                        Ok(_) => lyrics += 1,
                        Err(error) => errors.push(format!("could not copy {lyrics_name}: {error}")),
                    }
                }
                library_index.lyrics.insert(song_relative, lyrics_relative);
            }
        }
    }

    write_index(&root, &library_index)?;

    let playlist = if create_playlist {
        let name = playlist_name
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| source.file_name().map(|name| name.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "Imported".to_string());
        playlists::write(&app, &name, &imported)?;
        Some(name)
    } else {
        None
    };

    let state = playlists::refresh(&app, &store, &paths);

    Ok(ImportOutcome {
        songs,
        images,
        lyrics,
        skipped,
        playlist,
        errors,
        state,
    })
}

/// The `.lrc` sitting next to a song, matching how the scanner looks for lyrics.
fn sidecar_beside(song: &Path) -> Option<PathBuf> {
    let candidate = song.with_extension("lrc");
    candidate.is_file().then_some(candidate)
}

fn file_name_of(path: &Path) -> Option<String> {
    path.file_name().map(|name| name.to_string_lossy().into_owned())
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
        index.resolve(title, file_name).as_deref().and_then(file_name_of)
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
        // An `artist - song` name still matches the song alone.
        assert_eq!(
            matched(
                &index,
                "a tout le monde - remastered 2004",
                "A Tout Le Monde - Remastered 2004.mp3"
            ),
            Some("A Tout Le Monde - Remastered 2004.lrc".to_string())
        );
        // Anything that is not a `.lrc` is left alone.
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
            sidecar_beside(&song).as_deref().and_then(file_name_of),
            Some("Agony.lrc".to_string())
        );
        assert_eq!(sidecar_beside(&dir.join("Other.mp3")), None);
    }
}
