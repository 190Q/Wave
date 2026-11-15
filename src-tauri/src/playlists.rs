use tauri::{AppHandle, Manager, Runtime, State};

use crate::catalog::Catalog;
use crate::state::{PersistedState, Store};

pub fn refresh<R: Runtime>(app: &AppHandle<R>, store: &Store) -> Result<PersistedState, String> {
    let catalog = app.try_state::<Catalog>()
        .ok_or_else(|| "the library catalog is not available".to_string())?;
    refresh_with(store, || catalog.playlists())
}

pub(crate) fn refresh_with(
    store: &Store,
    read: impl FnOnce() -> Result<Vec<crate::state::Playlist>, String>,
) -> Result<PersistedState, String> {
    store.try_update(|state| {
        state.playlists = read()?;
        Ok(())
    })
}

pub fn refresh_saved<R: Runtime>(app: &AppHandle<R>, store: &Store) -> Result<PersistedState, String> {
    refresh(app, store)
        .map_err(|error| format!("The changes were saved, but the playlists could not be refreshed: {error}"))
}

/// Creates a playlist and fills it, for the imports that already know what
/// belongs in it.
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

#[tauri::command(async)]
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
    refresh_saved(&app, &store)
}

#[tauri::command(async)]
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
    refresh_saved(&app, &store)
}

#[tauri::command(async)]
pub fn delete_playlist(
    app: AppHandle,
    store: State<'_, Store>,
    catalog: State<'_, Catalog>,
    id: String,
) -> Result<PersistedState, String> {
    catalog.delete_playlist(&id)?;
    refresh_saved(&app, &store)
}

#[tauri::command(async)]
pub fn add_to_playlist(
    app: AppHandle,
    store: State<'_, Store>,
    catalog: State<'_, Catalog>,
    id: String,
    track_ids: Vec<String>,
) -> Result<PersistedState, String> {
    catalog.add_to_playlist(&id, &track_ids)?;
    refresh_saved(&app, &store)
}

#[tauri::command(async)]
pub fn remove_from_playlist(
    app: AppHandle,
    store: State<'_, Store>,
    catalog: State<'_, Catalog>,
    id: String,
    track_ids: Vec<String>,
) -> Result<PersistedState, String> {
    catalog.remove_from_playlist(&id, &track_ids)?;
    refresh_saved(&app, &store)
}

#[tauri::command(async)]
pub fn reorder_playlist(
    app: AppHandle,
    store: State<'_, Store>,
    catalog: State<'_, Catalog>,
    id: String,
    track_ids: Vec<String>,
) -> Result<PersistedState, String> {
    catalog.reorder_playlist(&id, &track_ids)?;
    refresh_saved(&app, &store)
}
