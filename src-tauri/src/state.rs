use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::library::TrackPaths;
use crate::playlists;

const STATE_FILE: &str = "state.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: String,
    pub volume: u8,
    pub recent_colours: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "adaptive".to_string(),
            volume: 70,
            recent_colours: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub track_ids: Vec<String>,
    pub created_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PersistedState {
    pub settings: Settings,
    pub playlists: Vec<Playlist>,
    pub likes: Vec<String>,
    pub artwork_colours: HashMap<String, String>,
}

/// In-memory copy of [`PersistedState`], guarded for the command handlers.
pub struct Store {
    inner: Mutex<PersistedState>,
}

impl Store {
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Self {
        let state = read_state(app).unwrap_or_default();
        Self {
            inner: Mutex::new(state),
        }
    }

    /// A clone of the current state.
    pub fn snapshot(&self) -> PersistedState {
        self.guard().clone()
    }

    fn guard(&self) -> MutexGuard<'_, PersistedState> {
        // A poisoned lock only means another command panicked mid-write.
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Applies `edit` and returns the resulting state.
    pub fn update(&self, edit: impl FnOnce(&mut PersistedState)) -> PersistedState {
        let mut guard = self.guard();
        edit(&mut guard);
        guard.clone()
    }
}

fn state_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve the app config directory: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir.join(STATE_FILE))
}

fn read_state<R: Runtime>(app: &AppHandle<R>) -> Result<PersistedState, String> {
    let path = state_path(app)?;
    if !path.exists() {
        return Ok(PersistedState::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(PersistedState::default());
    }
    serde_json::from_str(&raw).map_err(|e| format!("{} is not valid state: {e}", path.display()))
}

/// Writes via a temp file so a crash mid-write cannot truncate the real one.
fn write_state<R: Runtime>(app: &AppHandle<R>, state: &PersistedState) -> Result<(), String> {
    let path = state_path(app)?;
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, json).map_err(|e| format!("could not write {}: {e}", temp.display()))?;
    // `rename` does not overwrite on Windows, so clear the target first.
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    fs::rename(&temp, &path).map_err(|e| format!("could not replace {}: {e}", path.display()))
}

fn commit<R: Runtime>(app: &AppHandle<R>, state: PersistedState) -> Result<PersistedState, String> {
    write_state(app, &state)?;
    Ok(state)
}

/// Persists a snapshot produced by [`Store::update`].
pub fn save<R: Runtime>(app: &AppHandle<R>, state: &PersistedState) -> Result<(), String> {
    write_state(app, state)
}

#[tauri::command]
pub fn get_state(
    app: AppHandle,
    store: State<'_, Store>,
    paths: State<'_, TrackPaths>,
) -> PersistedState {
    // Playlists live on disk, so the cached copy is refreshed on every read.
    playlists::refresh(&app, &store, &paths)
}

#[tauri::command]
pub fn set_settings(
    app: AppHandle,
    store: State<'_, Store>,
    settings: Settings,
) -> Result<PersistedState, String> {
    let next = store.update(|state| state.settings = settings);
    commit(&app, next)
}

#[tauri::command]
pub fn toggle_like(
    app: AppHandle,
    store: State<'_, Store>,
    track_id: String,
) -> Result<PersistedState, String> {
    let next = store.update(|state| {
        if let Some(index) = state.likes.iter().position(|t| *t == track_id) {
            state.likes.remove(index);
        } else {
            state.likes.push(track_id);
        }
    });
    commit(&app, next)
}
