use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use tauri::State;

use crate::catalog::{Catalog, TrackRow};
use crate::library;

pub(crate) fn read_track(root: &Path, row: &TrackRow, limit: u64) -> Result<Option<String>, String> {
    let path = row.lyrics_path.as_deref().map(|path| root.join(path))
        .filter(|path| path.is_file())
        .or_else(|| library::lyrics_in(&library::track_dir(root, &row.id)));
    let Some(path) = path else { return Ok(None) };
    let file = fs::File::open(&path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    if bytes.len() as u64 > limit {
        return Err("The playlist lyrics are too large to export.".into());
    }
    let text = String::from_utf8(bytes).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    Ok((!text.trim().is_empty()).then_some(text))
}

pub(crate) fn restore(catalog: &Catalog, id: &str, text: Option<&str>) -> Result<bool, String> {
    let Some(text) = text.filter(|text| !text.trim().is_empty()) else { return Ok(false) };
    let root = catalog.root();
    let _operation = catalog.library_operation();
    let row = catalog.track(id)?.filter(|row| !row.missing)
        .ok_or_else(|| "That song is no longer in the library.".to_string())?;
    let dir = library::track_dir(root, id);
    if row.lyrics_path.as_deref().is_some_and(|path| root.join(path).is_file())
        || library::lyrics_in(&dir).is_some()
    {
        return Ok(false);
    }
    let path = library::lyrics_path(root, id);
    let mut file = match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(error) => return Err(format!("Could not save the lyrics: {error}")),
    };
    if let Err(error) = file.write_all(text.as_bytes()) {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(format!("Could not save the lyrics: {error}"));
    }
    drop(file);
    let relative = library::relative(root, &path).ok_or_else(|| "Could not locate the lyrics.".to_string())?;
    if let Err(error) = catalog.set_lyrics(id, Some(&relative)) {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    Ok(true)
}

#[tauri::command]
pub fn load_lyrics(catalog: State<'_, Catalog>, track_id: String) -> Option<String> {
    let row = catalog.track(&track_id).ok().flatten()?;
    let root = catalog.root();

    let path = row
        .lyrics_path
        .as_deref()
        .map(|relative| root.join(relative))
        .filter(|path| path.is_file())
        // Lyrics dropped in beside the audio by hand.
        .or_else(|| {
            let beside = library::lyrics_path(root, &track_id);
            beside.is_file().then_some(beside)
        })?;

    fs::read_to_string(path)
        .ok()
        .filter(|text| !text.trim().is_empty())
}
