use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalSize, Runtime, State, WebviewWindow};

use crate::identity;
use crate::playlists;
use crate::source::TrackMeta;
use crate::spotify::SpotifyStatus;

const STATE_FILE: &str = "state.json";

/// A playlist the user built by hand.
pub const CUSTOM_KIND: &str = "custom";
/// A playlist the generator filled, whose songs may still be waiting.
pub const GENERATED_KIND: &str = "generated";

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
    pub analytics_enabled: bool,
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
            analytics_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub track_ids: Vec<String>,
    pub created_at: u64,
    pub kind: String,
    pub entries: Vec<String>,
    pub pending: Vec<PendingTrack>,
}

impl Default for Playlist {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            track_ids: Vec::new(),
            created_at: 0,
            kind: CUSTOM_KIND.to_string(),
            entries: Vec::new(),
            pending: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PendingTrack {
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub album_artist: String,
    pub genres: Vec<String>,
    pub isrc: String,
    pub cover_url: Option<String>,
    pub cover_path: Option<String>,
    pub release_date: String,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    /// Where it came from. Kept in the catalog rather than sent to the UI.
    #[serde(skip)]
    pub source: String,
    #[serde(skip)]
    pub source_id: String,
}

impl PendingTrack {
    /// A waiting entry for a song a source offered but the library lacks.
    pub fn from_meta(meta: &TrackMeta, source: &str, source_id: &str) -> Self {
        Self {
            id: identity::new_id(),
            title: meta.title.clone(),
            artists: meta.artists.clone(),
            album: meta.album.clone(),
            album_artist: meta.album_artist.clone(),
            genres: meta.genres.clone(),
            isrc: meta.isrc.clone(),
            cover_url: meta.cover_url.clone(),
            cover_path: None,
            release_date: meta.release_date.clone(),
            track_number: meta.track_number,
            disc_number: meta.disc_number,
            source: source.to_string(),
            source_id: source_id.to_string(),
        }
    }

    /// The metadata the downloader needs to fetch it.
    pub fn meta(&self) -> TrackMeta {
        TrackMeta {
            title: self.title.clone(),
            artists: self.artists.clone(),
            album: self.album.clone(),
            album_artist: self.album_artist.clone(),
            release_date: self.release_date.clone(),
            track_number: self.track_number,
            disc_number: self.disc_number,
            genres: self.genres.clone(),
            isrc: self.isrc.clone(),
            cover_url: self.cover_url.clone(),
            ..TrackMeta::default()
        }
    }
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
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
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

pub fn state_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    state_path(app)
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
    // `rename` replaces the target, so the swap is one step and a power cut
    // cannot leave the file missing. Where it is refused, clear the target.
    if fs::rename(&temp, &path).is_err() {
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
        fs::rename(&temp, &path)
            .map_err(|e| format!("could not replace {}: {e}", path.display()))?;
    }
    Ok(())
}

fn commit<R: Runtime>(app: &AppHandle<R>, state: PersistedState) -> Result<PersistedState, String> {
    write_state(app, &state)?;
    Ok(state)
}

/// Persists a snapshot produced by [`Store::update`].
pub fn save<R: Runtime>(app: &AppHandle<R>, state: &PersistedState) -> Result<(), String> {
    write_state(app, state)
}

pub fn remap_ids<R: Runtime>(
    app: &AppHandle<R>,
    store: &Store,
    tracks: &HashMap<String, String>,
    playlists: &HashMap<String, String>,
) -> Result<(), String> {
    if tracks.is_empty() && playlists.is_empty() {
        return Ok(());
    }

    let next = store.update(|state| {
        state.likes = remap(&std::mem::take(&mut state.likes), tracks);

        state.artwork_colours = std::mem::take(&mut state.artwork_colours)
            .into_iter()
            .map(|(id, colour)| (tracks.get(&id).cloned().unwrap_or(id), colour))
            .collect();

        let order = remap(&state.session.playback.order, tracks);
        let source_order = remap(&state.session.playback.source_order, tracks);
        state.session.playback.order = order;
        state.session.playback.source_order = source_order;

        let recents = std::mem::take(&mut state.session.recents);
        state.session.recents = remap(&recents, tracks);

        // A queue that was playing a playlist still knows what it was playing.
        if let Some(source) = state.session.playback.source_id.as_ref() {
            if let Some(id) = playlists.get(source) {
                state.session.playback.source_id = Some(id.clone());
            }
        }
    });

    save(app, &next)
}

fn remap(ids: &[String], map: &HashMap<String, String>) -> Vec<String> {
    ids.iter()
        .map(|id| map.get(id).cloned().unwrap_or_else(|| id.clone()))
        .collect()
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
pub fn get_state(app: AppHandle, store: State<'_, Store>) -> PersistedState {
    // Playlists live in the catalog, so the cached copy is refreshed on read.
    playlists::refresh(&app, &store)
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

fn read_frame<R: Runtime>(window: &WebviewWindow<R>) -> Option<WindowGeometry> {
    if window.is_minimized().unwrap_or(false) {
        return None;
    }
    read_window_geometry(window).ok()
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
    if matches!(part, SnapPart::Frame | SnapPart::Position) && !lands_on_screen(app, window, geometry)
    {
        return;
    }

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

fn lands_on_screen<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    geometry: &WindowGeometry,
) -> bool {
    const VISIBLE: i32 = 120;

    let Ok(monitors) = app.available_monitors() else {
        return true;
    };
    if monitors.is_empty() {
        // Nothing to measure against, so the frame is taken at its word.
        return true;
    }

    // The size is kept in logical units, so it is scaled to match the monitors.
    let scale = window.scale_factor().unwrap_or(1.0);
    let left = geometry.x;
    let top = geometry.y;
    let right = left + (f64::from(geometry.width) * scale).round() as i32;
    let bottom = top + (f64::from(geometry.height) * scale).round() as i32;

    monitors.iter().any(|monitor| {
        let area = monitor.position();
        let size = monitor.size();
        let across = right.min(area.x + size.width as i32) - left.max(area.x);
        let down = bottom.min(area.y + size.height as i32) - top.max(area.y);
        across >= VISIBLE && down >= VISIBLE
    })
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
            if let Some(geometry) = read_frame(&window) {
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

    let Some(geometry) = read_frame(&window) else {
        return Ok(());
    };
    // Called on a timer, so a frame that has not moved is left alone.
    if current.window.as_ref() == Some(&geometry) {
        return Ok(());
    }
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

/// Likes or unlikes several songs at once, for a selection.
#[tauri::command]
pub fn set_likes(
    app: AppHandle,
    store: State<'_, Store>,
    track_ids: Vec<String>,
    liked: bool,
) -> Result<PersistedState, String> {
    let next = store.update(|state| {
        for track_id in track_ids {
            let saved = state.likes.iter().any(|id| *id == track_id);
            if liked && !saved {
                state.likes.push(track_id);
            } else if !liked && saved {
                state.likes.retain(|id| *id != track_id);
            }
        }
    });
    commit(&app, next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_playlist_saved_before_generated_playlists_still_loads() {
        let raw = r#"{ "id": "p", "name": "Old", "trackIds": ["one"], "createdAt": 5 }"#;
        let playlist: Playlist = serde_json::from_str(raw).unwrap();

        assert_eq!(playlist.track_ids, vec!["one"]);
        assert_eq!(playlist.kind, CUSTOM_KIND);
        assert!(playlist.entries.is_empty());
        assert!(playlist.pending.is_empty());
    }

    #[test]
    fn a_pending_song_keeps_the_shape_the_ui_reads() {
        let track = PendingTrack::from_meta(
            &TrackMeta {
                title: "Hey Jude".to_string(),
                artists: vec!["The Beatles".to_string()],
                album: "Past Masters".to_string(),
                cover_url: Some("https://cdn/cover.jpg".to_string()),
                track_number: Some(4),
                ..TrackMeta::default()
            },
            "deezer",
            "116348632",
        );

        let json = serde_json::to_string(&track).unwrap();
        assert!(json.contains("\"coverUrl\""));
        assert!(json.contains("\"trackNumber\":4"));
        // Where it came from stays in the catalog.
        assert!(!json.contains("sourceId"));
        assert!(!json.contains("deezer"));

        let meta = track.meta();
        assert_eq!(meta.title, "Hey Jude");
        assert_eq!(meta.artists, vec!["The Beatles"]);
        assert_eq!(meta.track_number, Some(4));
    }
}
