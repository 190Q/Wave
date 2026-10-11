use std::fs;
use std::path::Path;

/// Returns the raw contents of the `.lrc` sidecar next to `path`, if any.
#[tauri::command]
pub fn load_lyrics(path: String) -> Option<String> {
    let sidecar = Path::new(&path).with_extension("lrc");
    fs::read_to_string(sidecar)
        .ok()
        .filter(|text| !text.trim().is_empty())
}
