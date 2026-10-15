use std::fs;

use tauri::State;

use crate::catalog::Catalog;
use crate::library;

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
