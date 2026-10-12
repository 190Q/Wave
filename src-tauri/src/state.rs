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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Playback {
    pub source_id: Option<String>,
    pub source_name: String,
    pub source_order: Vec<String>,
    pub order: Vec<String>,
    pub cursor: usize,
    pub position_ms: u64,
    pub shuffle: bool,
    pub repeat: String,
    pub muted: bool,
}

impl Default for Playback {
    fn default() -> Self {
        Self {
            source_id: None,
            source_name: String::new(),
            source_order: Vec::new(),
            order: Vec::new(),
            cursor: 0,
            position_ms: 0,
            shuffle: false,
            repeat: "off".to_string(),
            muted: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub playback: Playback,
    pub recents: Vec<String>,
    pub filter: String,
    pub sort: String,
    pub queue_open: bool,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            playback: Playback::default(),
            recents: Vec::new(),
            filter: "all".to_string(),
            sort: "name".to_string(),
            queue_open: false,
        }
    }
}

/// Where the window sat when it was last closed: its outer size in logical
/// units, its position in physical pixels, the monitor it was on, and whether
/// it was maximised.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowGeometry {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub monitor: Option<String>,
    pub maximized: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PersistedState {
    pub settings: Settings,
    pub playlists: Vec<Playlist>,
    pub likes: Vec<String>,
    pub artwork_colours: HashMap<String, String>,
    pub session: Session,
    pub window: Option<WindowGeometry>,
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

/// Applies the remembered geometry to the main window, before it is shown.
pub fn restore_window_geometry<R: Runtime>(app: &AppHandle<R>, store: &Store) {
    let Some(geometry) = store.snapshot().window else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let scale = window.scale_factor().unwrap_or(1.0);
    let wanted = tauri::PhysicalSize::new(
        (f64::from(geometry.width) * scale).round() as u32,
        (f64::from(geometry.height) * scale).round() as u32,
    );

    let frame = match (window.outer_size(), window.inner_size()) {
        (Ok(outer), Ok(inner)) => tauri::PhysicalSize::new(
            outer.width.saturating_sub(inner.width),
            outer.height.saturating_sub(inner.height),
        ),
        _ => tauri::PhysicalSize::new(0, 0),
    };

    let _ = window.set_size(tauri::PhysicalSize::new(
        wanted.width.saturating_sub(frame.width),
        wanted.height.saturating_sub(frame.height),
    ));

    // Only restore the position while the monitor it lived on is still around.
    let monitor_present = match &geometry.monitor {
        Some(name) => app
            .available_monitors()
            .map(|monitors| monitors.iter().any(|m| m.name().map(|n| n == name).unwrap_or(false)))
            .unwrap_or(false),
        None => true,
    };
    if monitor_present {
        let _ = window.set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y));
    }

    if geometry.maximized {
        let _ = window.maximize();
    }
}

#[tauri::command]
pub fn save_window_geometry(app: AppHandle, store: State<'_, Store>) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    let maximized = window.is_maximized().unwrap_or(false);
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window
        .outer_size()
        .map_err(|e| e.to_string())?
        .to_logical::<u32>(scale);
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .and_then(|m| m.name().map(|n| n.to_string()));

    let next = store.update(|state| {
        if maximized {
            // Keep the windowed geometry, so unmaximising stays sensible.
            let mut geometry = state.window.clone().unwrap_or_default();
            geometry.maximized = true;
            state.window = Some(geometry);
        } else {
            state.window = Some(WindowGeometry {
                width: size.width,
                height: size.height,
                x: position.x,
                y: position.y,
                monitor,
                maximized: false,
            });
        }
    });
    save(&app, &next)
}

/// Forgets the remembered geometry, so the next launch uses the defaults.
#[tauri::command]
pub fn reset_window_geometry(app: AppHandle, store: State<'_, Store>) -> Result<(), String> {
    let next = store.update(|state| state.window = None);
    save(&app, &next)
}

#[tauri::command]
pub fn set_session(
    app: AppHandle,
    store: State<'_, Store>,
    session: Session,
) -> Result<PersistedState, String> {
    let next = store.update(|state| state.session = session);
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
