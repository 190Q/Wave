use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::library::{
    artwork_dir, file_stem_lower, has_extension, library_root, read_index, write_index,
    ArtworkIndex, TrackPaths, AUDIO_EXTENSIONS, IMAGES_DIR, SONGS_DIR,
};
use crate::playlists;
use crate::state::{PersistedState, Store};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub songs: usize,
    pub images: usize,
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

    let artwork_index = match artwork_dir(&source) {
        Some(dir) => ArtworkIndex::build(&dir),
        None => ArtworkIndex::default(),
    };

    let songs_dir = root.join(SONGS_DIR);
    let images_dir = root.join(IMAGES_DIR);
    let mut library_index = read_index(&root);

    let mut imported: Vec<String> = Vec::new();
    let mut songs = 0usize;
    let mut images = 0usize;
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

        // Artwork is matched exactly the way the scanner matches it.
        let title = file_stem_lower(&path);
        let Some(image) = artwork_index.resolve(&title, &file_name) else {
            continue;
        };
        let Some(image_name) = image.file_name().map(|name| name.to_string_lossy().into_owned()) else {
            continue;
        };

        let image_relative = format!("{IMAGES_DIR}/{image_name}");
        let image_destination = images_dir.join(&image_name);
        if !image_destination.exists() {
            match fs::copy(&image, &image_destination) {
                Ok(_) => images += 1,
                Err(error) => errors.push(format!("could not copy {image_name}: {error}")),
            }
        }
        library_index.songs.insert(song_relative, image_relative);
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
        skipped,
        playlist,
        errors,
        state,
    })
}
