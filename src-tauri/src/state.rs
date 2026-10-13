use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalSize, Runtime, State, WebviewWindow};

use crate::library::TrackPaths;
use crate::playlists;
use crate::spotify::SpotifyStatus;

const STATE_FILE: &str = "state.json";

/// How many `Ctrl+Shift+1..9` action slots the UI offers.
pub const SLOT_COUNT: usize = 9;
const MIN_WIDTH: u32 = 485;
const MIN_HEIGHT: u32 = 240;
const MINI_WIDTH: f64 = MIN_WIDTH as f64;
const MINI_HEIGHT: f64 = MIN_HEIGHT as f64;
const MINI_CORNER_COUNT: u8 = 4;
const DEFAULT_MINI_CORNER: u8 = 4;
const APPLY_QUIET_MS: u64 = 400;
pub const SETTINGS_EVENT: &str = "settings-changed";
static APPLYING_SINCE: Mutex<Option<Instant>> = Mutex::new(None);

static MINI_INNER: Mutex<Option<PhysicalSize<u32>>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: String,
    pub volume: u8,
    pub normalize_volume: bool,
    pub recent_colours: Vec<String>,
    pub resume_on_launch: bool,
    pub reduce_motion: String,
    pub remember_window: bool,
    pub always_on_top: bool,
    pub mini_player: bool,
    pub mini_corner: u8,
    pub search_algorithm: String,
    pub shortcut_slots: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "adaptive".to_string(),
            volume: 70,
            normalize_volume: true,
            recent_colours: Vec::new(),
            resume_on_launch: true,
            reduce_motion: "system".to_string(),
            remember_window: true,
            always_on_top: false,
            mini_player: false,
            mini_corner: DEFAULT_MINI_CORNER,
            search_algorithm: "substring".to_string(),
            shortcut_slots: Vec::new(),
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

/// How much of a saved frame a slot snap puts back: all of it, or one half.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SnapPart {
    Frame,
    Size,
    Position,
}

/// One entry in the import history, newest first.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRecord {
    /// Where it came from: `spotify` or `folder`.
    pub source: String,
    /// The playlist or folder it brought in.
    pub name: String,
    /// A short summary, such as `12 songs`.
    pub detail: String,
}

/// How many imports the history keeps.
pub const RECENT_IMPORT_LIMIT: usize = 3;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PersistedState {
    pub settings: Settings,
    pub playlists: Vec<Playlist>,
    pub likes: Vec<String>,
    pub artwork_colours: HashMap<String, String>,
    pub session: Session,
    pub window: Option<WindowGeometry>,
    /// One saved frame per `Ctrl+Shift+1..9` slot, for the snap action.
    pub window_slots: Vec<Option<WindowGeometry>>,
    /// The last few imports, newest first.
    pub recent_imports: Vec<ImportRecord>,
    /// The last Spotify setup answer, so a restart does not start from nothing.
    pub spotify: Option<SpotifyStatus>,
}

/// In-memory copy of [`PersistedState`], guarded for the command handlers.
pub struct Store {
    inner: Mutex<PersistedState>,
}

impl Store {
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Self {
        let mut state = read_state(app).unwrap_or_default();
        sanitise_geometries(&mut state);
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

/// Pushes an import onto the history and writes it, newest first.
pub fn remember_import<R: Runtime>(app: &AppHandle<R>, record: ImportRecord) {
    let store = app.state::<Store>();
    let next = store.update(|state| {
        state.recent_imports.insert(0, record);
        state.recent_imports.truncate(RECENT_IMPORT_LIMIT);
    });
    // The history is a nicety; a failed write must not fail the import.
    let _ = write_state(app, &next);
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
    let before = store.snapshot().settings;
    let next = store.update(|state| state.settings = settings);
    let committed = commit(&app, next)?;

    if before.mini_player != committed.settings.mini_player
        || before.mini_corner != committed.settings.mini_corner
    {
        apply_window_settings(&app, &store, before.mini_player);
    } else if before.always_on_top != committed.settings.always_on_top {
        // Only the stacking changed, so the window is left where it stands.
        if let Some(window) = app.get_webview_window("main") {
            let _ = window
                .set_always_on_top(committed.settings.mini_player || committed.settings.always_on_top);
        }
    }
    Ok(committed)
}

/// Puts the mini player in a corner, for the `m + 1..4` shortcuts.
#[tauri::command]
pub fn place_mini_player(
    app: AppHandle,
    store: State<'_, Store>,
    corner: u8,
) -> Result<PersistedState, String> {
    let corner = corner.clamp(1, MINI_CORNER_COUNT);
    let next = store.update(|state| state.settings.mini_corner = corner);
    let committed = commit(&app, next)?;

    apply_window_settings(&app, &store, committed.settings.mini_player);
    Ok(committed)
}


fn clamp_geometry(geometry: &mut WindowGeometry) {
    geometry.width = geometry.width.max(MIN_WIDTH);
    geometry.height = geometry.height.max(MIN_HEIGHT);
}

fn sanitise_geometries(state: &mut PersistedState) {
    if let Some(window) = state.window.as_mut() {
        clamp_geometry(window);
    }
    for slot in state.window_slots.iter_mut().flatten() {
        clamp_geometry(slot);
    }
}

fn read_window_geometry<R: Runtime>(window: &WebviewWindow<R>) -> Result<WindowGeometry, String> {
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

    let mut geometry = WindowGeometry {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
        monitor,
        maximized,
    };
    clamp_geometry(&mut geometry);
    Ok(geometry)
}

fn apply_geometry<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    geometry: &WindowGeometry,
    part: SnapPart,
) {
    note_programmatic_change();

    if window.is_maximized().unwrap_or(false) && !(part == SnapPart::Frame && geometry.maximized) {
        let _ = window.unmaximize();
    }

    if matches!(part, SnapPart::Frame | SnapPart::Size) {
        resize_to(window, geometry);
    }

    if matches!(part, SnapPart::Frame | SnapPart::Position) {
        move_to(app, window, geometry);
    }

    if part == SnapPart::Frame && geometry.maximized {
        let _ = window.maximize();
    }
}

/// Resizes the window to the saved outer size, which is kept in logical units.
fn resize_to<R: Runtime>(window: &WebviewWindow<R>, geometry: &WindowGeometry) {
    let mut geometry = geometry.clone();
    clamp_geometry(&mut geometry);
    resize_outer(
        window,
        tauri::LogicalSize::new(f64::from(geometry.width), f64::from(geometry.height)),
    );
}

fn resize_outer<R: Runtime>(
    window: &WebviewWindow<R>,
    wanted: tauri::LogicalSize<f64>,
) -> PhysicalSize<u32> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let rect = tauri::PhysicalSize::new(
        (wanted.width * scale).round() as u32,
        (wanted.height * scale).round() as u32,
    );

    let border = match (window.outer_size(), window.inner_size()) {
        (Ok(outer), Ok(inner)) => tauri::PhysicalSize::new(
            outer.width.saturating_sub(inner.width),
            outer.height.saturating_sub(inner.height),
        ),
        _ => tauri::PhysicalSize::new(0, 0),
    };

    let client = tauri::PhysicalSize::new(
        rect.width.saturating_sub(border.width),
        rect.height.saturating_sub(border.height),
    );
    let _ = window.set_size(client);
    client
}

/// Puts the window back where it sat, while the monitor it lived on is around.
fn move_to<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, geometry: &WindowGeometry) {
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
}

pub fn apply_window_settings<R: Runtime>(app: &AppHandle<R>, store: &Store, was_mini: bool) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let current = store.snapshot();
    let mini = current.settings.mini_player;
    let _ = window.set_always_on_top(mini || current.settings.always_on_top);

    if mini {
        if !was_mini && current.settings.remember_window {
            // Remember the frame, so leaving mini mode puts it back.
            if let Ok(geometry) = read_window_geometry(&window) {
                store.update(|state| state.window = Some(geometry));
            }
        }
        let monitor = window.current_monitor().ok().flatten();
        note_programmatic_change();
        let _ = window.unmaximize();
        let inner = resize_outer(&window, tauri::LogicalSize::new(MINI_WIDTH, MINI_HEIGHT));
        remember_mini_size(inner);
        if let Some(monitor) = monitor {
            place_in_corner(&window, &monitor, current.settings.mini_corner);
        }
        return;
    }

    if was_mini {
        if let Some(geometry) = current.window {
            apply_geometry(app, &window, &geometry, SnapPart::Frame);
        }
    }
}

fn place_in_corner<R: Runtime>(window: &WebviewWindow<R>, monitor: &Monitor, corner: u8) {
    let area = monitor.work_area();
    let size = window.outer_size().unwrap_or_default();

    let left = area.position.x;
    let top = area.position.y;
    let right = area.position.x + area.size.width as i32 - size.width as i32;
    let bottom = area.position.y + area.size.height as i32 - size.height as i32;

    let (x, y) = match corner {
        1 => (left, top),
        2 => (right, top),
        3 => (left, bottom),
        _ => (right, bottom),
    };

    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

/// Watches the main window, so a resize the user drags it to ends mini mode.
pub fn watch_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let handle = app.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Resized(size) => note_resized(&handle, *size),
        tauri::WindowEvent::ScaleFactorChanged { .. } => note_programmatic_change(),
        _ => {}
    });
}

fn note_programmatic_change() {
    let mut since = APPLYING_SINCE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *since = Some(Instant::now());
}

/// True while the app is still settling a move it made itself.
fn applying() -> bool {
    let since = APPLYING_SINCE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    since
        .map(|at| at.elapsed() < Duration::from_millis(APPLY_QUIET_MS))
        .unwrap_or(false)
}

fn note_resized<R: Runtime>(app: &AppHandle<R>, size: PhysicalSize<u32>) {
    if applying() || is_mini_size(size) {
        return;
    }

    let Some(store) = app.try_state::<Store>() else {
        return;
    };
    if !store.snapshot().settings.mini_player {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let next = store.update(|state| state.settings.mini_player = false);
    if save(app, &next).is_ok() {
        let _ = app.emit(SETTINGS_EVENT, next.settings.clone());
    }
    let _ = window.set_always_on_top(next.settings.always_on_top);
}

fn remember_mini_size(size: PhysicalSize<u32>) {
    let mut recorded = MINI_INNER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *recorded = Some(size);
}

fn is_mini_size(size: PhysicalSize<u32>) -> bool {
    let recorded = MINI_INNER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(recorded) = *recorded else {
        return false;
    };
    size.width.abs_diff(recorded.width) < 3 && size.height.abs_diff(recorded.height) < 3
}

/// Applies the remembered geometry to the main window, before it is shown.
pub fn restore_window_geometry<R: Runtime>(app: &AppHandle<R>, store: &Store) {
    let state = store.snapshot();
    if !state.settings.remember_window {
        return;
    }
    let Some(geometry) = state.window else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    apply_geometry(app, &window, &geometry, SnapPart::Frame);
}

#[tauri::command]
pub fn save_window_geometry(app: AppHandle, store: State<'_, Store>) -> Result<(), String> {
    let current = store.snapshot();
    if !current.settings.remember_window {
        return Ok(());
    }
    if current.settings.mini_player {
        return Ok(());
    }

    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    let geometry = read_window_geometry(&window)?;
    let next = store.update(|state| state.window = Some(geometry));
    save(&app, &next)
}

/// Forgets the remembered geometry, so the next launch uses the defaults.
#[tauri::command]
pub fn reset_window_geometry(app: AppHandle, store: State<'_, Store>) -> Result<(), String> {
    let next = store.update(|state| state.window = None);
    save(&app, &next)
}

/// Remembers the window's current frame against a `Ctrl+Shift+1..9` slot.
#[tauri::command]
pub fn save_window_slot(
    app: AppHandle,
    store: State<'_, Store>,
    slot: usize,
) -> Result<PersistedState, String> {
    if slot >= SLOT_COUNT {
        return Err(format!("slot {slot} is out of range"));
    }

    let Some(window) = app.get_webview_window("main") else {
        return Ok(store.snapshot());
    };

    let geometry = read_window_geometry(&window)?;

    let next = store.update(|state| {
        while state.window_slots.len() < SLOT_COUNT {
            state.window_slots.push(None);
        }
        state.window_slots[slot] = Some(geometry);
    });
    commit(&app, next)
}

/// Snaps the window back to the frame saved against a slot.
#[tauri::command]
pub fn apply_window_slot(
    app: AppHandle,
    store: State<'_, Store>,
    slot: usize,
    part: SnapPart,
) -> Result<(), String> {
    let state = store.snapshot();
    let Some(Some(geometry)) = state.window_slots.get(slot) else {
        return Err("no window frame is saved for that slot".to_string());
    };
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    apply_geometry(&app, &window, geometry, part);
    Ok(())
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
