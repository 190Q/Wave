use tauri::{AppHandle, Manager, Runtime, State};

use crate::catalog::Catalog;
use crate::state::{PersistedState, Store};

/// Re-reads every playlist into the cached state and returns the state.
pub fn refresh<R: Runtime>(app: &AppHandle<R>, store: &Store) -> PersistedState {
    let playlists = app
        .try_state::<Catalog>()
        .and_then(|catalog| catalog.playlists().ok())
        .unwrap_or_default();

    store.update(|state| state.playlists = playlists)
}


pub fn write<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    track_ids: &[String],
) -> Result<String, String> {
    let catalog = app.state::<Catalog>();
    let name = name.trim();
    let name = if name.is_empty() { "Imported" } else { name };

    let id = catalog.create_playlist(name)?;
    if !track_ids.is_empty() {
        catalog.set_playlist_entries(&id, track_ids)?;
    }
    Ok(id)
}

#[tauri::command]
pub fn create_playlist(
    app: AppHandle,
    store: State<'_, Store>,
    catalog: State<'_, Catalog>,
    name: String,
) -> Result<PersistedState, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("a playlist needs a name".to_string());
    }
    if catalog.playlist_name_taken(&name, None) {
        return Err(format!("a playlist called {name} already exists"));
    }

    catalog.create_playlist(&name)?;
    Ok(refresh(&app, &store))
}

#[tauri::command]
pub fn rename_playlist(
    app: AppHandle,
    store: State<'_, Store>,
    catalog: State<'_, Catalog>,
    id: String,
    name: String,
) -> Result<PersistedState, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("a playlist needs a name".to_string());
    }
    if catalog.playlist_name_taken(&name, Some(&id)) {
        return Err(format!("a playlist called {name} already exists"));
    }

    catalog.rename_playlist(&id, &name)?;
    Ok(refresh(&app, &store))
}

#[tauri::command]
pub fn delete_playlist(
    app: AppHandle,
    store: State<'_, Store>,
    catalog: State<'_, Catalog>,
    id: String,
) -> Result<PersistedState, String> {
    catalog.delete_playlist(&id)?;
    Ok(refresh(&app, &store))
}

#[tauri::command]
pub fn add_to_playlist(
    app: AppHandle,
    store: State<'_, Store>,
    catalog: State<'_, Catalog>,
    id: String,
    track_ids: Vec<String>,
) -> Result<PersistedState, String> {
    catalog.add_to_playlist(&id, &track_ids)?;
    Ok(refresh(&app, &store))
}

#[tauri::command]
pub fn remove_from_playlist(
    app: AppHandle,
    store: State<'_, Store>,
    catalog: State<'_, Catalog>,
    id: String,
    track_ids: Vec<String>,
) -> Result<PersistedState, String> {
    catalog.remove_from_playlist(&id, &track_ids)?;
    Ok(refresh(&app, &store))
}

#[tauri::command]
pub fn reorder_playlist(
    app: AppHandle,
    store: State<'_, Store>,
    catalog: State<'_, Catalog>,
    id: String,
    track_ids: Vec<String>,
) -> Result<PersistedState, String> {
    catalog.set_playlist_entries(&id, &track_ids)?;
    Ok(refresh(&app, &store))
}
