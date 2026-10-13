use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use tauri::{AppHandle, Runtime, State};

use crate::library::{library_root, TrackPaths, PLAYLISTS_DIR};
use crate::state::{PersistedState, Playlist, Store};

pub fn load<R: Runtime>(app: &AppHandle<R>, id_to_file: &HashMap<String, String>) -> Vec<Playlist> {
    let Ok(root) = library_root(app) else {
        return Vec::new();
    };

    let file_to_id: HashMap<&str, &str> = id_to_file
        .iter()
        .map(|(id, file)| (file.as_str(), id.as_str()))
        .collect();

    let Ok(entries) = fs::read_dir(root.join(PLAYLISTS_DIR)) else {
        return Vec::new();
    };

    let mut playlists = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let name = path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }

        let files: Vec<String> = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();

        let track_ids = files
            .iter()
            .filter_map(|file| file_to_id.get(file.as_str()).map(|id| (*id).to_string()))
            .collect();

        let created_at = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0);

        playlists.push(Playlist {
            id: name.clone(),
            name,
            track_ids,
            created_at,
        });
    }

    playlists.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    playlists
}

/// Re-reads every playlist file into the cached state and returns the state.
pub fn refresh<R: Runtime>(app: &AppHandle<R>, store: &Store, paths: &TrackPaths) -> PersistedState {
    let files = paths.ids_to_file_map();
    let playlists = load(app, &files);
    store.update(|state| state.playlists = playlists)
}

/// Strips the characters Windows refuses in a file name.
pub fn safe_name(name: &str) -> String {
    name.chars()
        .map(|character| if r#"\/:*?"<>|"#.contains(character) { '_' } else { character })
        .collect::<String>()
        .trim()
        .to_string()
}

fn file_for<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<PathBuf, String> {
    let root = library_root(app)?;
    Ok(root.join(PLAYLISTS_DIR).join(format!("{}.json", safe_name(name))))
}

pub fn write<R: Runtime>(app: &AppHandle<R>, name: &str, files: &[String]) -> Result<(), String> {
    let path = file_for(app, name)?;
    let json = serde_json::to_string_pretty(files).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("could not write {}: {e}", path.display()))
}

pub fn read_files<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<Vec<String>, String> {
    let path = file_for(app, name)?;
    if !path.exists() {
        return Err(format!("there is no playlist called {name}"));
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("{} is not a playlist: {e}", path.display()))
}

pub fn delete<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<(), String> {
    let path = file_for(app, name)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("could not delete {}: {e}", path.display()))?;
    }
    Ok(())
}

pub fn remove_file_from_all<R: Runtime>(app: &AppHandle<R>, file: &str) -> Result<(), String> {
    let Ok(root) = library_root(app) else {
        return Ok(());
    };
    let Ok(entries) = fs::read_dir(root.join(PLAYLISTS_DIR)) else {
        return Ok(());
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(files) = serde_json::from_str::<Vec<String>>(&raw) else {
            continue;
        };
        if !files.iter().any(|saved| saved == file) {
            continue;
        }

        let kept: Vec<&String> = files.iter().filter(|saved| *saved != file).collect();
        let json = serde_json::to_string_pretty(&kept).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    }

    Ok(())
}

#[tauri::command]
pub fn create_playlist(
    app: AppHandle,
    store: State<'_, Store>,
    paths: State<'_, TrackPaths>,
    name: String,
) -> Result<PersistedState, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("a playlist needs a name".to_string());
    }
    if file_for(&app, &name)?.exists() {
        return Err(format!("a playlist called {name} already exists"));
    }
    write(&app, &name, &[])?;
    Ok(refresh(&app, &store, &paths))
}

#[tauri::command]
pub fn rename_playlist(
    app: AppHandle,
    store: State<'_, Store>,
    paths: State<'_, TrackPaths>,
    id: String,
    name: String,
) -> Result<PersistedState, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("a playlist needs a name".to_string());
    }

    let files = read_files(&app, &id)?;
    write(&app, &name, &files)?;
    if safe_name(&id) != safe_name(&name) {
        delete(&app, &id)?;
    }

    Ok(refresh(&app, &store, &paths))
}

#[tauri::command]
pub fn delete_playlist(
    app: AppHandle,
    store: State<'_, Store>,
    paths: State<'_, TrackPaths>,
    id: String,
) -> Result<PersistedState, String> {
    delete(&app, &id)?;
    Ok(refresh(&app, &store, &paths))
}

#[tauri::command]
pub fn add_to_playlist(
    app: AppHandle,
    store: State<'_, Store>,
    paths: State<'_, TrackPaths>,
    id: String,
    track_ids: Vec<String>,
) -> Result<PersistedState, String> {
    let mut files = read_files(&app, &id)?;
    for file in paths.ids_to_files(&track_ids) {
        if !files.contains(&file) {
            files.push(file);
        }
    }
    write(&app, &id, &files)?;
    Ok(refresh(&app, &store, &paths))
}

#[tauri::command]
pub fn remove_from_playlist(
    app: AppHandle,
    store: State<'_, Store>,
    paths: State<'_, TrackPaths>,
    id: String,
    track_ids: Vec<String>,
) -> Result<PersistedState, String> {
    let removed = paths.ids_to_files(&track_ids);
    let files: Vec<String> = read_files(&app, &id)?
        .into_iter()
        .filter(|file| !removed.contains(file))
        .collect();
    write(&app, &id, &files)?;
    Ok(refresh(&app, &store, &paths))
}

#[tauri::command]
pub fn reorder_playlist(
    app: AppHandle,
    store: State<'_, Store>,
    paths: State<'_, TrackPaths>,
    id: String,
    track_ids: Vec<String>,
) -> Result<PersistedState, String> {
    let files = paths.ids_to_files(&track_ids);
    write(&app, &id, &files)?;
    Ok(refresh(&app, &store, &paths))
}
