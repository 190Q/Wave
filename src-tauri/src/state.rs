use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
#[cfg(desktop)]
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
#[cfg(desktop)]
use tauri::{Emitter, Monitor, PhysicalSize, WebviewWindow};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::identity;
use crate::playlists;
use crate::source::TrackMeta;
use crate::spotify::SpotifyStatus;
use crate::update::UpdateInfo;

const STATE_FILE: &str = "state.json";

/// A playlist the user built by hand.
pub const CUSTOM_KIND: &str = "custom";
/// A playlist the generator filled, whose songs may still be waiting.
pub const GENERATED_KIND: &str = "generated";

/// How many `Ctrl+Shift+1..9` action slots the UI offers.
pub const SLOT_COUNT: usize = 9;
const MIN_WIDTH: u32 = 485;
const MIN_HEIGHT: u32 = 240;
const DEFAULT_MINI_CORNER: u8 = 4;

static MIN_FRAME: OnceLock<(u32, u32)> = OnceLock::new();
pub const SETTINGS_EVENT: &str = "settings-changed";
pub const STATE_CHANGED_EVENT: &str = "state-changed";

// A phone has one window, filling the screen, so the frame, the slots and the
// mini player are desktop-only from here down.
#[cfg(desktop)]
const MINI_WIDTH: f64 = MIN_WIDTH as f64;
#[cfg(desktop)]
const MINI_HEIGHT: f64 = MIN_HEIGHT as f64;
#[cfg(desktop)]
const MINI_CORNER_COUNT: u8 = 4;
#[cfg(desktop)]
const APPLY_QUIET_MS: u64 = 400;
#[cfg(desktop)]
static APPLYING_SINCE: Mutex<Option<Instant>> = Mutex::new(None);

#[cfg(desktop)]
static MINI_INNER: Mutex<Option<PhysicalSize<u32>>> = Mutex::new(None);

#[cfg(desktop)]
static NORMAL_FRAME: Mutex<Option<WindowGeometry>> = Mutex::new(None);

#[cfg(desktop)]
static LAST_FRAME: Mutex<Option<WindowGeometry>> = Mutex::new(None);

/// One band of the equaliser.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EqBand {
    pub id: String,
    /// The Web Audio filter name: `peaking`, `lowShelf`, `highShelf`, `lowPass`,
    /// `highPass`, `bandPass` or `notch`.
    pub kind: String,
    pub freq: f64,
    pub gain: f64,
    pub q: f64,
    pub enabled: bool,
}

impl Default for EqBand {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: "peaking".to_string(),
            freq: 1_000.0,
            gain: 0.0,
            q: 1.0,
            enabled: true,
        }
    }
}

/// A saved curve, with the settings that go with it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EqPreset {
    pub id: String,
    pub name: String,
    /// `manual`, or `autoeq` for an imported measurement.
    pub source: String,
    pub bands: Vec<EqBand>,
    pub auto_preamp: bool,
    pub preamp_db: f64,
    pub limiter: bool,
}

impl Default for EqPreset {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            source: "manual".to_string(),
            bands: Vec::new(),
            auto_preamp: true,
            preamp_db: 0.0,
            limiter: true,
        }
    }
}

/// A curve that is picked automatically for one album, artist, playlist or genre.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EqContextRule {
    /// `album`, `artist`, `playlist` or `genre`.
    pub kind: String,
    pub value: String,
    pub preset_id: String,
}

impl Default for EqContextRule {
    fn default() -> Self {
        Self {
            kind: "album".to_string(),
            value: String::new(),
            preset_id: String::new(),
        }
    }
}

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
    pub show_titlebar: Option<bool>,
    pub always_on_top: bool,
    pub mini_player: bool,
    pub mini_corner: u8,
    pub search_algorithm: String,
    pub shortcut_slots: Vec<String>,
    pub analytics_enabled: bool,
    /// Shows the song in the system's own controls: the Windows media flyout
    /// and the media keys, or MPRIS on Linux.
    pub system_media_controls: bool,
    /// Shows the song on the Discord profile. Off until it is asked for.
    #[cfg(desktop)]
    pub discord_presence: bool,
    #[cfg(not(target_os = "android"))]
    pub local_api_enabled: bool,
    /// Looks for a newer release and offers to install it. On by default.
    pub auto_update: bool,
    /// Whether the equaliser is in the signal path at all.
    pub eq_enabled: bool,
    /// The bands being edited. Empty means a flat curve.
    pub eq_bands: Vec<EqBand>,
    /// Levels the curve so a boost cannot push it into clipping.
    pub eq_auto_preamp: bool,
    /// A trim added on top of the automatic preamp, in decibels.
    pub eq_preamp_db: f64,
    /// The safety limiter after the equaliser.
    pub eq_limiter: bool,
    /// Saved curves.
    pub eq_presets: Vec<EqPreset>,
    /// The preset the bands were last taken from.
    pub eq_active_preset_id: Option<String>,
    /// Output device -> preset id.
    pub eq_device_rules: HashMap<String, String>,
    /// Album, artist, playlist or genre -> preset id.
    pub eq_context_rules: Vec<EqContextRule>,
    /// Where playback is sent. Empty means the system default.
    pub eq_output_id: String,
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
            show_titlebar: None,
            always_on_top: false,
            mini_player: false,
            mini_corner: DEFAULT_MINI_CORNER,
            search_algorithm: "substring".to_string(),
            shortcut_slots: Vec::new(),
            analytics_enabled: true,
            system_media_controls: true,
            #[cfg(desktop)]
            discord_presence: false,
            #[cfg(not(target_os = "android"))]
            local_api_enabled: false,
            auto_update: true,
            eq_enabled: false,
            eq_bands: Vec::new(),
            eq_auto_preamp: true,
            eq_preamp_db: 0.0,
            eq_limiter: true,
            eq_presets: Vec::new(),
            eq_active_preset_id: None,
            eq_device_rules: HashMap::new(),
            eq_context_rules: Vec::new(),
            eq_output_id: String::new(),
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
    pub duration_ms: Option<u64>,
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
            duration_ms: meta.duration_ms,
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
            duration_ms: self.duration_ms,
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
    pub saved_at: u64,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            playback: Playback::default(),
            recents: Vec::new(),
            filter: "all".to_string(),
            sort: "name".to_string(),
            queue_open: false,
            saved_at: 0,
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
    /// The newer release last found, offered again without another check.
    pub update: Option<UpdateInfo>,
}

/// In-memory copy of [`PersistedState`], guarded for the command handlers.
pub struct Store {
    inner: Mutex<PersistedState>,
    settings_operation: Mutex<()>,
}

impl Store {
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        note_min_frame(app);
        let mut state = read_state(app)?;
        sanitise_geometries(&mut state);
        Ok(Self {
            inner: Mutex::new(state),
            settings_operation: Mutex::new(()),
        })
    }

    /// A clone of the current state.
    pub fn snapshot(&self) -> PersistedState {
        self.guard().clone()
    }

    fn guard(&self) -> MutexGuard<'_, PersistedState> {
        // A poisoned lock only means another command panicked mid-write.
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn settings_operation(&self) -> MutexGuard<'_, ()> {
        self.settings_operation.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn try_update(
        &self,
        edit: impl FnOnce(&mut PersistedState) -> Result<(), String>,
    ) -> Result<PersistedState, String> {
        let mut guard = self.guard();
        edit(&mut guard)?;
        Ok(guard.clone())
    }

    pub fn edit(&self, edit: impl FnOnce(&mut PersistedState)) {
        let mut guard = self.guard();
        edit(&mut guard);
    }

    pub fn update_saved<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        edit: impl FnOnce(&mut PersistedState),
    ) -> Result<PersistedState, String> {
        self.update_at_path(&state_path(app)?, edit)
    }

    fn update_at_path(
        &self,
        path: &Path,
        edit: impl FnOnce(&mut PersistedState),
    ) -> Result<PersistedState, String> {
        self.try_update_at_path(path, |state| {
            edit(state);
            Ok::<_, String>(())
        }).map(|(_, state)| state)
    }

    fn try_update_at_path<T, E: From<String>>(
        &self,
        path: &Path,
        edit: impl FnOnce(&mut PersistedState) -> Result<T, E>,
    ) -> Result<(T, PersistedState), E> {
        let mut guard = self.guard();
        let previous = guard.clone();
        let result = match edit(&mut guard) {
            Ok(result) => result,
            Err(error) => {
                *guard = previous;
                return Err(error);
            }
        };
        if let Err(error) = write_state(path, &guard) {
            *guard = previous;
            return Err(error.into());
        }
        Ok((result, guard.clone()))
    }

    pub fn save<R: Runtime>(&self, app: &AppHandle<R>) -> Result<(), String> {
        let path = state_path(app)?;
        self.save_at_path(&path)
    }

    fn save_at_path(&self, path: &Path) -> Result<(), String> {
        write_state(path, &self.guard())
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
    read_state_at_path(&state_path(app)?)
}

fn read_state_at_path(path: &Path) -> Result<PersistedState, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PersistedState::default());
        }
        Err(error) => return Err(format!("could not read {}: {error}", path.display())),
    };
    serde_json::from_str(&raw).map_err(|e| format!("{} is not valid state: {e}", path.display()))
}

/// Writes via a temp file so a crash mid-write cannot truncate the real one.
fn write_state(path: &Path, state: &PersistedState) -> Result<(), String> {
    write_state_with(path, state, |temp, path| fs::rename(temp, path))
}

fn write_state_with(
    path: &Path,
    state: &PersistedState,
    replace: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    let temp = path.with_extension(format!("json.{}.tmp", identity::new_id()));
    if let Err(error) = fs::write(&temp, json) {
        let _ = fs::remove_file(&temp);
        return Err(format!("could not write {}: {error}", temp.display()));
    }
    let result = replace(&temp, path)
        .map_err(|e| format!("could not replace {}: {e}", path.display()));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
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

    store.update_saved(app, |state| {
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
    }).map(|_| ())
}

fn remap(ids: &[String], map: &HashMap<String, String>) -> Vec<String> {
    ids.iter()
        .map(|id| map.get(id).cloned().unwrap_or_else(|| id.clone()))
        .collect()
}

/// Pushes an import onto the history and writes it, newest first.
pub fn remember_import<R: Runtime>(app: &AppHandle<R>, record: ImportRecord) {
    let store = app.state::<Store>();
    let _ = store.update_saved(app, |state| {
        state.recent_imports.insert(0, record);
        state.recent_imports.truncate(RECENT_IMPORT_LIMIT);
    });
}

#[tauri::command(async)]
pub fn get_state(app: AppHandle, store: State<'_, Store>) -> Result<PersistedState, String> {
    // Playlists live in the catalog, so the cached copy is refreshed on read.
    playlists::refresh(&app, &store)
}

#[derive(Debug)]
pub(crate) enum SettingsPatchError {
    Invalid(String),
    Failed(String),
}

impl From<String> for SettingsPatchError {
    fn from(error: String) -> Self {
        Self::Failed(error)
    }
}

impl std::fmt::Display for SettingsPatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(error) | Self::Failed(error) => f.write_str(error),
        }
    }
}

fn merge_settings(current: &Settings, patch: Map<String, Value>) -> Result<Settings, SettingsPatchError> {
    let mut merged = serde_json::to_value(current)
        .map_err(|error| SettingsPatchError::Failed(format!("the settings could not be read: {error}")))?;
    let fields = merged.as_object_mut()
        .ok_or_else(|| SettingsPatchError::Failed("the settings could not be read".to_string()))?;
    for (name, value) in patch {
        if fields.contains_key(&name) {
            fields.insert(name, value);
        } else {
            return Err(SettingsPatchError::Invalid(format!("there is no {name} setting")));
        }
    }
    serde_json::from_value(merged)
        .map_err(|error| SettingsPatchError::Invalid(format!("the settings could not be read: {error}")))
}

fn patch_settings_at_path(
    store: &Store,
    path: &Path,
    patch: Map<String, Value>,
) -> Result<(Settings, PersistedState), SettingsPatchError> {
    store.try_update_at_path(path, |state| {
        let before = state.settings.clone();
        state.settings = merge_settings(&before, patch)?;
        Ok(before)
    })
}

pub(crate) fn patch_settings_with(
    app: &AppHandle,
    store: &Store,
    patch: Map<String, Value>,
    notify: impl FnOnce(&PersistedState),
) -> Result<PersistedState, SettingsPatchError> {
    let _operation = store.settings_operation();
    let path = state_path(app)?;
    let before = store.snapshot().settings;
    let after = merge_settings(&before, patch.clone())?;
    let (before, committed) = save_settings_with_api(app, &before, &after, || {
        patch_settings_at_path(store, &path, patch)
    })?;
    apply_settings_changes(app, store, &before, &committed.settings);
    notify(&committed);
    Ok(committed)
}

fn save_settings_with_api(
    app: &AppHandle,
    before: &Settings,
    after: &Settings,
    save: impl FnOnce() -> Result<(Settings, PersistedState), SettingsPatchError>,
) -> Result<(Settings, PersistedState), SettingsPatchError> {
    #[cfg(not(target_os = "android"))]
    let started = !before.local_api_enabled && after.local_api_enabled;
    #[cfg(not(target_os = "android"))]
    if started {
        app.state::<crate::api::Api>()
            .set_enabled(app, true)
            .map_err(SettingsPatchError::Failed)?;
    }
    #[cfg(target_os = "android")]
    let _ = (app, before, after);

    let result = save();
    #[cfg(not(target_os = "android"))]
    if result.is_err() && started {
        app.state::<crate::api::Api>().shutdown();
    }
    result
}

#[tauri::command(async)]
pub fn patch_settings(
    app: AppHandle,
    store: State<'_, Store>,
    patch: Map<String, Value>,
) -> Result<PersistedState, String> {
    patch_settings_with(&app, &store, patch, |_| {}).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn set_settings(
    app: AppHandle,
    store: State<'_, Store>,
    settings: Settings,
) -> Result<PersistedState, String> {
    let _operation = store.settings_operation();
    let path = state_path(&app)?;
    let before = store.snapshot().settings;
    let (before, committed) = save_settings_with_api(&app, &before, &settings, || {
        store.try_update_at_path(&path, |state| {
            let before = state.settings.clone();
            state.settings = settings.clone();
            Ok::<_, SettingsPatchError>(before)
        })
    }).map_err(|error| error.to_string())?;
    apply_settings_changes(&app, &store, &before, &committed.settings);
    Ok(committed)
}

fn apply_settings_changes(app: &AppHandle, store: &Store, before: &Settings, after: &Settings) {
    #[cfg(not(desktop))]
    let _ = store;
    #[cfg(desktop)]
    if before.mini_player != after.mini_player
        || before.mini_corner != after.mini_corner
    {
        apply_window_settings(app, store, before.mini_player);
    } else if before.always_on_top != after.always_on_top {
        // Only the stacking changed, so the window is left where it stands.
        if let Some(window) = app.get_webview_window("main") {
            let _ = window
                .set_always_on_top(after.mini_player || after.always_on_top);
        }
    }

    let presence_changed = before.system_media_controls != after.system_media_controls;
    #[cfg(desktop)]
    let presence_changed = presence_changed || before.discord_presence != after.discord_presence;
    if presence_changed {
        if let Some(presence) = app.try_state::<crate::presence::Presence>() {
            presence.set_enabled(
                after.system_media_controls,
                #[cfg(desktop)]
                after.discord_presence,
            );
        }
    }

    #[cfg(not(target_os = "android"))]
    if before.local_api_enabled && !after.local_api_enabled {
        let _ = app.state::<crate::api::Api>().set_enabled(app, false);
    }
}

/// Puts the mini player in a corner, for the `m + 1..4` shortcuts.
#[cfg(desktop)]
#[tauri::command(async)]
pub fn place_mini_player(
    app: AppHandle,
    store: State<'_, Store>,
    corner: u8,
) -> Result<PersistedState, String> {
    let _operation = store.settings_operation();
    let corner = corner.clamp(1, MINI_CORNER_COUNT);
    let committed = store.update_saved(&app, |state| state.settings.mini_corner = corner)?;

    apply_window_settings(&app, &store, committed.settings.mini_player);
    Ok(committed)
}

/// There is no mini player on a phone, and nothing to put in a corner.
#[cfg(not(desktop))]
#[tauri::command(async)]
pub fn place_mini_player(
    app: AppHandle,
    store: State<'_, Store>,
    corner: u8,
) -> Result<PersistedState, String> {
    let _operation = store.settings_operation();
    let _ = corner;
    store.update_saved(&app, |state| state.settings.mini_corner = DEFAULT_MINI_CORNER)
}

/// The floor a frame is clamped to, which the window config decides.
fn min_frame() -> (u32, u32) {
    *MIN_FRAME.get().unwrap_or(&(MIN_WIDTH, MIN_HEIGHT))
}

/// Records the floor the window config asks for.
fn note_min_frame<R: Runtime>(app: &AppHandle<R>) {
    let windows = &app.config().app.windows;
    let Some(window) = windows
        .iter()
        .find(|window| window.label == "main")
        .or_else(|| windows.first())
    else {
        return;
    };

    let width = window.min_width.unwrap_or(f64::from(MIN_WIDTH));
    let height = window.min_height.unwrap_or(f64::from(MIN_HEIGHT));
    let _ = MIN_FRAME.set((width.max(0.0) as u32, height.max(0.0) as u32));
}

fn clamp_geometry(geometry: &mut WindowGeometry) {
    let (width, height) = min_frame();
    geometry.width = geometry.width.max(width);
    geometry.height = geometry.height.max(height);
}

fn sanitise_geometries(state: &mut PersistedState) {
    if let Some(window) = state.window.as_mut() {
        clamp_geometry(window);
    }
    for slot in state.window_slots.iter_mut().flatten() {
        clamp_geometry(slot);
    }
}

#[cfg(desktop)]
fn read_frame<R: Runtime>(window: &WebviewWindow<R>) -> Option<WindowGeometry> {
    let live = if window.is_minimized().unwrap_or(false) {
        None
    } else {
        Some(read_window_geometry(window).ok()?)
    };
    frame_to_remember(live, last_normal_frame(), last_frame())
}

/// Picks the last usable frame, preserving the normal size when maximised.
#[cfg(desktop)]
fn frame_to_remember(
    live: Option<WindowGeometry>,
    normal: Option<WindowGeometry>,
    last: Option<WindowGeometry>,
) -> Option<WindowGeometry> {
    let Some(live) = live else {
        return last;
    };
    if !live.maximized {
        return Some(live);
    }
    match normal {
        Some(mut normal) => {
            if live.monitor.is_some() && live.monitor != normal.monitor {
                normal.x = live.x;
                normal.y = live.y;
                normal.monitor = live.monitor;
            }
            normal.maximized = true;
            Some(normal)
        }
        // Nothing was seen before it was maximised, so this is all there is.
        None => Some(live),
    }
}

#[cfg(desktop)]
fn read_window_geometry<R: Runtime>(window: &WebviewWindow<R>) -> Result<WindowGeometry, String> {
    let maximized = window_is_maximized(window);

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

#[cfg(desktop)]
fn window_is_maximized<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        return unsafe { windows::Win32::UI::WindowsAndMessaging::IsZoomed(hwnd) }.as_bool();
    }
    window.is_maximized().unwrap_or(false)
}

#[cfg(desktop)]
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

    if window_is_maximized(window) && !(part == SnapPart::Frame && geometry.maximized) {
        let _ = window.unmaximize();
    }

    if matches!(part, SnapPart::Frame | SnapPart::Size) {
        resize_to(window, geometry);
    }

    if matches!(part, SnapPart::Frame | SnapPart::Position) {
        let _ = window.set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y));
    }

    if part == SnapPart::Frame && geometry.maximized {
        let _ = window.maximize();
        // It fills the screen now, so the size just applied is the one to keep.
        let mut frame = geometry.clone();
        clamp_geometry(&mut frame);
        remember_normal_frame(frame.clone());
        remember_last_frame(frame);
    } else if let Ok(frame) = read_window_geometry(window) {
        remember_normal_frame(frame.clone());
        remember_last_frame(frame);
    }
}

/// Resizes the window to the saved outer size, which is kept in logical units.
#[cfg(desktop)]
fn resize_to<R: Runtime>(window: &WebviewWindow<R>, geometry: &WindowGeometry) {
    let mut geometry = geometry.clone();
    clamp_geometry(&mut geometry);
    resize_outer(
        window,
        tauri::LogicalSize::new(f64::from(geometry.width), f64::from(geometry.height)),
    );
}

#[cfg(desktop)]
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

#[cfg(desktop)]
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

#[cfg(desktop)]
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
                store.edit(|state| state.window = Some(geometry));
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

#[cfg(desktop)]
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
#[cfg(desktop)]
pub fn watch_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let handle = app.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Resized(size) => {
            note_resized(&handle, *size);
            note_window_frame(&handle);
        }
        tauri::WindowEvent::Moved(_) => note_window_frame(&handle),
        tauri::WindowEvent::ScaleFactorChanged { .. } => note_programmatic_change(),
        _ => {}
    });
}

#[cfg(desktop)]
fn note_programmatic_change() {
    let mut since = APPLYING_SINCE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *since = Some(Instant::now());
}

/// True while the app is still settling a move it made itself.
#[cfg(desktop)]
fn applying() -> bool {
    let since = APPLYING_SINCE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    since
        .map(|at| at.elapsed() < Duration::from_millis(APPLY_QUIET_MS))
        .unwrap_or(false)
}

#[cfg(desktop)]
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
    if window.is_minimized().unwrap_or(false) {
        return;
    }

    if let Ok(next) = store.update_saved(app, |state| state.settings.mini_player = false) {
        let _ = app.emit(SETTINGS_EVENT, next.settings.clone());
        let _ = window.set_always_on_top(next.settings.always_on_top);
    } else {
        let _ = window.set_always_on_top(store.snapshot().settings.always_on_top);
    }
}

#[cfg(desktop)]
fn note_window_frame<R: Runtime>(app: &AppHandle<R>) {
    let Some(store) = app.try_state::<Store>() else {
        return;
    };
    if store.guard().settings.mini_player {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    if let Some(geometry) = read_frame(&window) {
        if !geometry.maximized {
            remember_normal_frame(geometry.clone());
        }
        remember_last_frame(geometry);
    }
}

#[cfg(desktop)]
fn remember_normal_frame(geometry: WindowGeometry) {
    let mut recorded = NORMAL_FRAME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *recorded = Some(geometry);
}

#[cfg(desktop)]
fn last_normal_frame() -> Option<WindowGeometry> {
    let recorded = NORMAL_FRAME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    recorded.clone()
}

#[cfg(desktop)]
fn remember_last_frame(geometry: WindowGeometry) {
    let mut recorded = LAST_FRAME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *recorded = Some(geometry);
}

#[cfg(desktop)]
fn last_frame() -> Option<WindowGeometry> {
    let recorded = LAST_FRAME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    recorded.clone()
}

#[cfg(desktop)]
fn remember_mini_size(size: PhysicalSize<u32>) {
    let mut recorded = MINI_INNER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *recorded = Some(size);
}

#[cfg(desktop)]
fn is_mini_size(size: PhysicalSize<u32>) -> bool {
    let recorded = MINI_INNER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(recorded) = *recorded else {
        return false;
    };
    size.width.abs_diff(recorded.width) < 3 && size.height.abs_diff(recorded.height) < 3
}

/// Applies the remembered geometry to the main window, before it is shown.
#[cfg(desktop)]
pub fn restore_window_geometry<R: Runtime>(app: &AppHandle<R>, store: &Store) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // The frame the window opens at, for a maximise before the first resize.
    if let Ok(geometry) = read_window_geometry(&window) {
        remember_normal_frame(geometry.clone());
        remember_last_frame(geometry);
    }

    let state = store.snapshot();
    if !state.settings.remember_window {
        return;
    }
    let Some(geometry) = state.window else {
        return;
    };
    apply_geometry(app, &window, &geometry, SnapPart::Frame);
}

#[cfg(desktop)]
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
    store.update_saved(&app, |state| state.window = Some(geometry)).map(|_| ())
}

/// Forgets the remembered geometry, so the next launch uses the defaults.
#[cfg(desktop)]
#[tauri::command]
pub fn reset_window_geometry(app: AppHandle, store: State<'_, Store>) -> Result<(), String> {
    store.update_saved(&app, |state| state.window = None).map(|_| ())
}

/// Remembers the window's current frame against a `Ctrl+Shift+1..9` slot.
#[cfg(desktop)]
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

    let Some(geometry) = read_frame(&window) else {
        return Err("the window frame could not be read".to_string());
    };

    store.update_saved(&app, |state| {
        while state.window_slots.len() < SLOT_COUNT {
            state.window_slots.push(None);
        }
        state.window_slots[slot] = Some(geometry);
    })
}

/// Snaps the window back to the frame saved against a slot.
#[cfg(desktop)]
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

/// A phone's window fills the screen, so there is no frame to remember.
#[cfg(not(desktop))]
#[tauri::command]
pub fn save_window_geometry(app: AppHandle, store: State<'_, Store>) -> Result<(), String> {
    let _ = (app, store);
    Err("a phone's window fills the screen, so there is no frame to remember".to_string())
}

/// A phone's window fills the screen, so there is no frame to forget.
#[cfg(not(desktop))]
#[tauri::command]
pub fn reset_window_geometry(app: AppHandle, store: State<'_, Store>) -> Result<(), String> {
    let _ = (app, store);
    Err("a phone's window fills the screen, so there is no frame to forget".to_string())
}

/// A phone's window fills the screen, so there is no frame to save.
#[cfg(not(desktop))]
#[tauri::command]
pub fn save_window_slot(
    app: AppHandle,
    store: State<'_, Store>,
    slot: usize,
) -> Result<PersistedState, String> {
    let _ = (app, slot);
    Ok(store.snapshot())
}

/// A phone's window fills the screen, so there is no frame to snap to.
#[cfg(not(desktop))]
#[tauri::command]
pub fn apply_window_slot(
    app: AppHandle,
    store: State<'_, Store>,
    slot: usize,
    part: SnapPart,
) -> Result<(), String> {
    let _ = (app, store, slot, part);
    Err("a phone's window fills the screen, so there is no frame to snap to".to_string())
}

#[tauri::command(async)]
pub fn set_session(
    app: AppHandle,
    store: State<'_, Store>,
    session: Session,
) -> Result<PersistedState, String> {
    store.update_saved(&app, |state| state.session = session)
}

#[tauri::command(async)]
pub fn toggle_like(
    app: AppHandle,
    store: State<'_, Store>,
    track_id: String,
) -> Result<PersistedState, String> {
    store.update_saved(&app, |state| {
        if let Some(index) = state.likes.iter().position(|t| *t == track_id) {
            state.likes.remove(index);
        } else {
            state.likes.push(track_id);
        }
    })
}

/// Likes or unlikes several songs at once, for a selection.
#[tauri::command(async)]
pub fn set_likes(
    app: AppHandle,
    store: State<'_, Store>,
    track_ids: Vec<String>,
    liked: bool,
) -> Result<PersistedState, String> {
    store.update_saved(&app, |state| {
        let mut held: HashSet<String> = state.likes.iter().cloned().collect();
        if liked {
            for track_id in track_ids {
                if held.insert(track_id.clone()) {
                    state.likes.push(track_id);
                }
            }
        } else {
            for track_id in track_ids {
                held.remove(&track_id);
            }
            state.likes.retain(|id| held.contains(id));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wave-state-{}", identity::new_id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn test_store(state: PersistedState) -> Store {
        Store { inner: Mutex::new(state), settings_operation: Mutex::new(()) }
    }

    fn patch(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn session_timestamps_default_for_old_state_and_round_trip() {
        let old: Session = serde_json::from_str(r#"{"playback":{"positionMs":42000}}"#).unwrap();
        assert_eq!(old.saved_at, 0);
        assert_eq!(old.playback.position_ms, 42_000);

        let current = Session {
            saved_at: 123_456,
            ..old
        };
        let json = serde_json::to_string(&current).unwrap();
        assert!(json.contains(r#""savedAt":123456"#));
        let restored: Session = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.saved_at, 123_456);
        assert_eq!(restored.playback.position_ms, 42_000);
    }

    #[test]
    fn local_api_setting_is_opt_in_and_unavailable_on_android() {
        let legacy: PersistedState = serde_json::from_value(serde_json::json!({
            "settings": { "volume": 42 }
        })).unwrap();
        let settings = serde_json::to_value(&legacy.settings).unwrap();
        assert_eq!(settings.get("localApiEnabled").is_some(), cfg!(not(target_os = "android")));
        #[cfg(not(target_os = "android"))]
        {
            assert!(!legacy.settings.local_api_enabled);
            let enabled = merge_settings(&legacy.settings, patch(serde_json::json!({
                "localApiEnabled": true
            }))).unwrap();
            let saved = serde_json::to_string(&enabled).unwrap();
            let restored: Settings = serde_json::from_str(&saved).unwrap();
            assert!(restored.local_api_enabled);
        }
        #[cfg(target_os = "android")]
        assert!(merge_settings(&legacy.settings, patch(serde_json::json!({
            "localApiEnabled": true
        }))).is_err());
    }

    #[test]
    fn discord_setting_is_desktop_only_and_legacy_state_still_loads() {
        let legacy = serde_json::json!({ "settings": { "discordPresence": true, "volume": 42 } });
        let state: PersistedState = serde_json::from_value(legacy).unwrap();
        assert_eq!(state.settings.volume, 42);
        let settings = serde_json::to_value(&state.settings).unwrap();
        assert_eq!(settings.get("discordPresence").is_some(), cfg!(desktop));
        let result = merge_settings(&state.settings, patch(serde_json::json!({ "discordPresence": false })));
        assert_eq!(result.is_ok(), cfg!(desktop));
    }

    #[test]
    fn concurrent_settings_patches_merge_against_the_committed_state() {
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        let dir = scratch();
        let path = dir.join(STATE_FILE);
        let store = Arc::new(test_store(PersistedState::default()));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (started_tx, started_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();

        let first_store = Arc::clone(&store);
        let first_path = path.clone();
        let first = std::thread::spawn(move || {
            first_store.try_update_at_path(&first_path, |state| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                state.settings = merge_settings(&state.settings, patch(serde_json::json!({
                    "theme": "first"
                })))?;
                Ok::<_, SettingsPatchError>(())
            }).unwrap();
        });
        entered_rx.recv().unwrap();

        let second_store = Arc::clone(&store);
        let second_path = path.clone();
        let second = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            patch_settings_at_path(&second_store, &second_path, patch(serde_json::json!({
                "volume": 42
            }))).unwrap();
            finished_tx.send(()).unwrap();
        });
        started_rx.recv().unwrap();
        assert!(finished_rx.recv_timeout(Duration::from_millis(100)).is_err());
        release_tx.send(()).unwrap();
        first.join().unwrap();
        second.join().unwrap();
        finished_rx.recv().unwrap();

        for settings in [store.snapshot().settings, read_state_at_path(&path).unwrap().settings] {
            assert_eq!(settings.theme, "first");
            assert_eq!(settings.volume, 42);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_settings_patches_do_not_change_memory_or_disk() {
        let dir = scratch();
        let path = dir.join(STATE_FILE);
        let store = test_store(PersistedState::default());
        store.save_at_path(&path).unwrap();
        let original = fs::read(&path).unwrap();

        for value in [
            serde_json::json!({ "theme": "first", "unknownSetting": true }),
            serde_json::json!({ "theme": "first", "volume": "bad" }),
        ] {
            let error = patch_settings_at_path(&store, &path, patch(value)).unwrap_err();
            assert!(matches!(error, SettingsPatchError::Invalid(_)));
            assert_eq!(store.snapshot().settings.theme, "adaptive");
            assert_eq!(store.snapshot().settings.volume, 70);
            assert_eq!(fs::read(&path).unwrap(), original);
        }
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn settings_patch_supports_nullable_and_nested_fields() {
        let dir = scratch();
        let path = dir.join(STATE_FILE);
        let mut initial = PersistedState::default();
        initial.settings.show_titlebar = Some(true);
        let store = test_store(initial);
        let (_, result) = patch_settings_at_path(&store, &path, patch(serde_json::json!({
            "showTitlebar": null,
            "eqDeviceRules": { "device": "preset" }
        }))).unwrap();
        assert_eq!(result.settings.show_titlebar, None);
        assert_eq!(result.settings.eq_device_rules.get("device").map(String::as_str), Some("preset"));
        assert_eq!(result.settings.volume, 70);
        let saved = read_state_at_path(&path).unwrap();
        assert_eq!(saved.settings.show_titlebar, None);
        assert_eq!(saved.settings.eq_device_rules.get("device").map(String::as_str), Some("preset"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn locked_settings_file_preserves_memory_and_disk_on_patch_failure() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = scratch();
        let path = dir.join(STATE_FILE);
        let store = test_store(PersistedState::default());
        store.save_at_path(&path).unwrap();
        let original = fs::read(&path).unwrap();
        let locked = fs::OpenOptions::new().read(true).share_mode(0).open(&path).unwrap();
        let error = patch_settings_at_path(&store, &path, patch(serde_json::json!({
            "volume": 42
        }))).unwrap_err();
        assert!(matches!(error, SettingsPatchError::Failed(_)));
        assert_eq!(store.snapshot().settings.volume, 70);
        drop(locked);
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_settings_patch_restores_memory_and_preserves_disk() {
        let dir = scratch();
        let path = dir.join(STATE_FILE);
        let store = test_store(PersistedState::default());
        store.save_at_path(&path).unwrap();
        let original = fs::read(&path).unwrap();
        let missing = dir.join("missing").join(STATE_FILE);

        let error = patch_settings_at_path(&store, &missing, patch(serde_json::json!({
            "volume": 42, "theme": "changed"
        }))).unwrap_err();
        assert!(matches!(error, SettingsPatchError::Failed(_)));
        assert_eq!(store.snapshot().settings.volume, 70);
        assert_eq!(store.snapshot().settings.theme, "adaptive");
        assert_eq!(fs::read(&path).unwrap(), original);

        let error = store.try_update_at_path(&path, |state| {
            state.settings.volume = 42;
            Err::<(), _>(SettingsPatchError::Invalid("bad patch".into()))
        }).unwrap_err();
        assert!(matches!(error, SettingsPatchError::Invalid(_)));
        assert_eq!(store.snapshot().settings.volume, 70);
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_edits_and_delayed_saves_preserve_the_latest_state() {
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        let dir = scratch();
        let path = dir.join(STATE_FILE);
        let store = Arc::new(test_store(PersistedState::default()));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (second_tx, second_rx) = mpsc::channel();
        let first_store = Arc::clone(&store);
        let first_path = path.clone();
        let first = std::thread::spawn(move || {
            first_store.update_at_path(&first_path, |state| {
                state.likes.push("first".into());
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            }).unwrap();
        });
        entered_rx.recv().unwrap();
        let second_store = Arc::clone(&store);
        let second_path = path.clone();
        let second = std::thread::spawn(move || {
            second_store.update_at_path(&second_path, |state| {
                second_tx.send(()).unwrap();
                state.likes.push("second".into());
            }).unwrap();
        });
        assert!(second_rx.recv_timeout(Duration::from_millis(100)).is_err());
        release_tx.send(()).unwrap();
        first.join().unwrap();
        second.join().unwrap();
        second_rx.recv().unwrap();

        store.edit(|state| state.settings.volume = 42);
        store.save_at_path(&path).unwrap();
        let saved = read_state_at_path(&path).unwrap();
        assert_eq!(saved.likes, vec!["first", "second"]);
        assert_eq!(saved.settings.volume, 42);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn playlist_refresh_reads_and_publishes_in_the_same_order() {
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        let store = Arc::new(test_store(PersistedState::default()));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (second_tx, second_rx) = mpsc::channel();
        let first_store = Arc::clone(&store);
        let first = std::thread::spawn(move || {
            crate::playlists::refresh_with(&first_store, || {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(vec![Playlist { id: "old".into(), ..Playlist::default() }])
            }).unwrap();
        });
        entered_rx.recv().unwrap();
        let second_store = Arc::clone(&store);
        let second = std::thread::spawn(move || {
            crate::playlists::refresh_with(&second_store, || {
                second_tx.send(()).unwrap();
                Ok(vec![Playlist { id: "new".into(), ..Playlist::default() }])
            }).unwrap();
        });
        assert!(second_rx.recv_timeout(Duration::from_millis(100)).is_err());
        release_tx.send(()).unwrap();
        first.join().unwrap();
        second.join().unwrap();
        second_rx.recv().unwrap();
        assert_eq!(store.snapshot().playlists[0].id, "new");
    }

    #[cfg(windows)]
    #[test]
    fn windows_locked_state_is_never_deleted_when_replacement_fails() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = scratch();
        let path = dir.join(STATE_FILE);
        let original = b"{\"settings\":{\"volume\":12}}";
        fs::write(&path, original).unwrap();
        let locked = fs::OpenOptions::new().read(true).share_mode(0).open(&path).unwrap();
        assert!(write_state(&path, &PersistedState::default()).is_err());
        drop(locked);
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_replacement_keeps_the_existing_file_and_cleans_the_temp() {
        let dir = scratch();
        let path = dir.join(STATE_FILE);
        let original = b"{\"settings\":{\"volume\":12}}";
        fs::write(&path, original).unwrap();

        let error = write_state_with(&path, &PersistedState::default(), |temp, target| {
            assert!(temp.is_file());
            assert_eq!(target, path);
            Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "locked"))
        }).unwrap_err();
        assert!(error.contains("could not replace"));
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_save_rolls_back_the_in_memory_edit() {
        let dir = scratch();
        let path = dir.join("missing").join(STATE_FILE);
        let store = test_store(PersistedState::default());
        assert!(store.update_at_path(&path, |state| state.likes.push("unsaved".into())).is_err());
        assert!(store.snapshot().likes.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_playlist_refresh_preserves_the_cached_playlists() {
        let dir = scratch();
        let path = dir.join(STATE_FILE);
        let store = test_store(PersistedState {
            playlists: vec![Playlist { id: "kept".into(), name: "Kept".into(), ..Playlist::default() }],
            ..PersistedState::default()
        });
        let error = crate::playlists::refresh_with(&store, || Err("catalog unavailable".into())).unwrap_err();
        assert_eq!(error, "catalog unavailable");
        assert_eq!(store.snapshot().playlists[0].id, "kept");
        store.save_at_path(&path).unwrap();
        assert_eq!(read_state_at_path(&path).unwrap().playlists[0].id, "kept");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_state_defaults_but_invalid_existing_state_is_preserved() {
        let dir = scratch();
        let path = dir.join(STATE_FILE);
        assert_eq!(read_state_at_path(&path).unwrap().settings.volume, 70);
        for raw in ["", "not json", "{"] {
            fs::write(&path, raw).unwrap();
            assert!(read_state_at_path(&path).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), raw);
        }
        assert!(read_state_at_path(&dir).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn titlebar_setting_defaults_to_automatic_and_round_trips() {
        let old: Settings = serde_json::from_str(r#"{ "volume": 42 }"#).unwrap();
        assert_eq!(old.show_titlebar, None);
        assert_eq!(old.volume, 42);

        for preference in [None, Some(true), Some(false)] {
            let settings = Settings {
                show_titlebar: preference,
                volume: 42,
                ..Settings::default()
            };
            let json = serde_json::to_string(&settings).unwrap();
            let restored: Settings = serde_json::from_str(&json).unwrap();
            assert_eq!(restored.show_titlebar, preference);
            assert_eq!(restored.volume, 42);
        }
    }

    #[cfg(desktop)]
    fn frame(width: u32, height: u32, maximized: bool) -> WindowGeometry {
        WindowGeometry {
            width,
            height,
            x: 40,
            y: 60,
            monitor: None,
            maximized,
        }
    }

    #[cfg(desktop)]
    #[test]
    fn a_maximised_window_remembers_the_size_it_had_before() {
        let kept = frame_to_remember(
            Some(frame(1920, 1080, true)),
            Some(frame(900, 655, false)),
            None,
        ).unwrap();

        assert_eq!(kept.width, 900);
        assert_eq!(kept.height, 655);
        assert_eq!(kept.x, 40);
        assert!(kept.maximized);
    }

    #[cfg(desktop)]
    #[test]
    fn a_maximised_window_with_nothing_remembered_keeps_its_own_frame() {
        let live = frame(1920, 1080, true);

        assert_eq!(frame_to_remember(Some(live.clone()), None, None), Some(live));
    }

    #[cfg(desktop)]
    #[test]
    fn a_window_that_was_not_maximised_keeps_its_own_frame() {
        let live = frame(900, 655, false);

        assert_eq!(
            frame_to_remember(Some(live.clone()), Some(frame(400, 300, false)), None),
            Some(live),
        );
    }

    #[cfg(desktop)]
    #[test]
    fn a_minimised_window_keeps_its_last_frame_after_moving() {
        let old = frame(900, 655, false);
        let mut moved = old.clone();
        moved.x = 2100;
        moved.monitor = Some("second".into());
        let last = frame_to_remember(Some(moved.clone()), Some(old.clone()), None);

        assert_eq!(frame_to_remember(None, Some(old), last), Some(moved));
        assert_eq!(frame_to_remember(None, None, None), None);
    }

    #[cfg(desktop)]
    #[test]
    fn a_maximised_window_moved_to_another_monitor_keeps_that_monitor() {
        let mut normal = frame(900, 655, false);
        normal.monitor = Some("first".into());
        let mut live = frame(1920, 1080, true);
        live.x = 1920;
        live.y = 0;
        live.monitor = Some("second".into());

        let kept = frame_to_remember(Some(live), Some(normal), None).unwrap();
        assert_eq!((kept.width, kept.height), (900, 655));
        assert_eq!((kept.x, kept.y), (1920, 0));
        assert_eq!(kept.monitor.as_deref(), Some("second"));
        assert!(kept.maximized);
        assert_eq!(frame_to_remember(None, None, Some(kept.clone())), Some(kept));
    }

    #[cfg(desktop)]
    #[test]
    fn an_unknown_current_monitor_does_not_discard_the_normal_position() {
        let mut normal = frame(900, 655, false);
        normal.monitor = Some("second".into());
        normal.x = 2100;
        let live = frame(1920, 1080, true);

        let kept = frame_to_remember(Some(live), Some(normal.clone()), None).unwrap();
        assert_eq!((kept.x, kept.y), (normal.x, normal.y));
        assert_eq!(kept.monitor, normal.monitor);
    }

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
