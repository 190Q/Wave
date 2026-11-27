//! Media state and controls for the system and Discord.

#[cfg(desktop)]
use std::path::Path;
#[cfg(desktop)]
use std::sync::mpsc::RecvTimeoutError;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
#[cfg(desktop)]
use std::time::Duration;

#[cfg(desktop)]
use discord_rich_presence::activity::{
    Activity, ActivityType, Assets, StatusDisplayType, Timestamps,
};
#[cfg(desktop)]
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use serde::{Deserialize, Serialize};
#[cfg(desktop)]
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};
#[cfg(desktop)]
use tauri::Emitter;
#[cfg(desktop)]
use tauri::Listener;
use tauri::{AppHandle, Manager, State};

#[cfg(desktop)]
use crate::source::{now_ms, read_env};
use crate::state::Store;

/// Sent to the webview when the system's own controls ask for something.
pub const CONTROL_EVENT: &str = "media-control";

/// The Discord application every build reports to, unless the config `.env`
/// names another one, so nothing has to be set up to use it. The id is public:
/// it is in every presence payload.
///
/// A fork that wants its own name on Discord makes an application at
/// https://discord.com/developers/applications, uploads the logo as a rich
/// presence asset named `wave`, and puts its Application ID here or into
/// DISCORD_CLIENT_ID.
#[cfg(desktop)]
const DEFAULT_DISCORD_CLIENT_ID: &str = "1570105712296595526";

/// The asset Discord draws beside the song.
#[cfg(desktop)]
const DISCORD_ARTWORK: &str = "wave";

/// How long to wait before trying Discord again while it has not answered.
#[cfg(desktop)]
const DISCORD_RETRY: Duration = Duration::from_secs(15);

/// How long a worker waits when there is nothing to do.
#[cfg(desktop)]
const IDLE: Duration = Duration::from_secs(60);

/// How far the position may sit from where the timestamps were taken before
/// they are taken again, which is what a seek looks like.
#[cfg(desktop)]
const DRIFT_MS: u64 = 2000;

/// How far the fast forward and rewind buttons move.
#[cfg(desktop)]
const SEEK_STEP_MS: u64 = 10_000;

/// The song the front end is playing.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: u64,
    pub position_ms: u64,
    pub playing: bool,
    /// Where the cover sits on disk, empty when the song has none.
    pub artwork: String,
    /// The song's `#rrggbb`, which the phone's notification is tinted with.
    pub colour: String,
}

/// One song of the play order, as the surfaces that offer a queue show it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QueueTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub duration_ms: u64,
}

/// Something the system's own controls asked for, on its way to the player.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    /// `play`, `pause`, `toggle`, `next`, `previous`, `stop`, `seekBy`,
    /// `seekTo`, `volume` or `raise`.
    pub action: String,
    /// Milliseconds for a seek, `0` to `100` for the volume, nothing otherwise.
    pub value: Option<f64>,
}

/// What the system worker is told, by the front end or by a button press.
enum SystemMessage {
    /// Shows a song, or clears the controls when there is none.
    Show(Option<NowPlaying>),
    /// The play order, for the phone's card, which is the only surface with one.
    #[cfg(target_os = "android")]
    Queue(Vec<QueueTrack>),
    #[cfg(target_os = "android")]
    Controls(bool),
    /// Takes the controls down and ends the thread.
    Stop,
    /// A button on the controls was pressed.
    #[cfg(desktop)]
    Pressed(MediaControlEvent),
}

/// What the Discord worker is told.
#[cfg(desktop)]
enum DiscordMessage {
    Show(Option<NowPlaying>),
    Stop,
}

/// The handle the app keeps: a way to reach each worker.
pub struct Presence {
    workers: Mutex<Workers>,
    app: AppHandle,
}

#[derive(Default)]
struct Workers {
    system: Option<Sender<SystemMessage>>,
    /// Kept so the app can wait for the controls to be let go of.
    system_thread: Option<JoinHandle<()>>,
    #[cfg(desktop)]
    discord: Option<Sender<DiscordMessage>>,
    /// The application the Discord worker was started with, so a changed id in
    /// the config is noticed.
    #[cfg(desktop)]
    discord_id: Option<String>,
}

impl Presence {
    /// Builds the handle and starts whichever surfaces the settings ask for.
    ///
    /// The system's controls are claimed here rather than in the worker, on
    /// the thread that owns the window, which is where Windows hands them out.
    pub fn start(app: &AppHandle) -> Self {
        let settings = app.state::<Store>().snapshot().settings;
        let presence = Self {
            workers: Mutex::new(Workers::default()),
            app: app.clone(),
        };
        presence.set_enabled(
            settings.system_media_controls,
            #[cfg(desktop)]
            settings.discord_presence,
        );
        presence
    }

    /// Shows a song, or takes everything down when there is none.
    pub fn show(&self, song: Option<NowPlaying>) {
        let workers = self.guard();
        if let Some(system) = workers.system.as_ref() {
            let _ = system.send(SystemMessage::Show(song.clone()));
        }
        #[cfg(desktop)]
        if let Some(discord) = workers.discord.as_ref() {
            let _ = discord.send(DiscordMessage::Show(song));
        }
    }

    /// Hands the play order over, for the surface that shows one.
    pub fn set_queue(&self, tracks: Vec<QueueTrack>) {
        #[cfg(not(target_os = "android"))]
        let _ = tracks;

        #[cfg(target_os = "android")]
        {
            let workers = self.guard();
            if let Some(system) = workers.system.as_ref() {
                let _ = system.send(SystemMessage::Queue(tracks));
            }
        }
    }

    /// Starts or stops each surface, without a restart.
    pub fn set_enabled(&self, system: bool, #[cfg(desktop)] discord: bool) {
        let mut workers = self.guard();

        if system_worker_needed(cfg!(target_os = "android"), system) {
            if workers.system.is_none() {
                if let Some((sender, thread)) = start_system(&self.app) {
                    workers.system = Some(sender);
                    workers.system_thread = Some(thread);
                }
            }
            #[cfg(target_os = "android")]
            if let Some(sender) = workers.system.as_ref() {
                let _ = sender.send(SystemMessage::Controls(system));
            }
        } else if let Some(sender) = workers.system.take() {
            // The worker lets go of the controls on its way out, and waiting for
            // it means the entry is gone by the time the switch is off.
            let _ = sender.send(SystemMessage::Stop);
            if let Some(thread) = workers.system_thread.take() {
                let _ = thread.join();
            }
        }

        #[cfg(desktop)]
        if discord {
            if workers.discord.is_none() {
                let id = discord_client_id(&self.app);
                workers.discord = Some(start_discord(id.clone()));
                workers.discord_id = id;
            }
        } else if let Some(sender) = workers.discord.take() {
            let _ = sender.send(DiscordMessage::Stop);
        }
    }

    /// Starts the Discord worker over when the config names a different
    /// application, so an id pasted into it takes effect as it is saved.
    #[cfg(desktop)]
    fn refresh_discord(&self) {
        let wanted = discord_client_id(&self.app);
        let mut workers = self.guard();

        if !self
            .app
            .state::<Store>()
            .snapshot()
            .settings
            .discord_presence
            || workers.discord_id == wanted
        {
            return;
        }

        if let Some(sender) = workers.discord.take() {
            let _ = sender.send(DiscordMessage::Stop);
        }
        workers.discord = Some(start_discord(wanted.clone()));
        workers.discord_id = wanted;
    }

    /// Takes both surfaces down, and waits for the system's controls to let go
    /// of the session, so nothing is left in the media flyout once the app has
    /// gone. Windows keeps showing the last song until it is told to stop.
    pub fn shutdown(&self) {
        let mut workers = self.guard();

        if let Some(sender) = workers.system.take() {
            let _ = sender.send(SystemMessage::Stop);
        }
        #[cfg(desktop)]
        if let Some(sender) = workers.discord.take() {
            // Discord drops the activity when the connection closes, so the
            // exit does not wait for it.
            let _ = sender.send(DiscordMessage::Stop);
        }
        if let Some(thread) = workers.system_thread.take() {
            let _ = thread.join();
        }
    }

    fn guard(&self) -> MutexGuard<'_, Workers> {
        self.workers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn system_worker_needed(android: bool, controls: bool) -> bool {
    android || controls
}

/// Follows the config `.env`, for the Discord application id in it.
#[cfg(desktop)]
pub fn watch_config(app: &AppHandle) {
    let handle = app.clone();
    app.listen(crate::source::CONFIG_EVENT, move |_| {
        if let Some(presence) = handle.try_state::<Presence>() {
            presence.refresh_discord();
        }
    });
}

/// Shows a song on the system's controls and on Discord, or takes both down.
#[tauri::command]
pub fn set_now_playing(presence: State<'_, Presence>, song: Option<NowPlaying>) {
    presence.show(song);
}

/// Hands the play order over, so the phone's own media card can offer the queue.
#[tauri::command]
pub fn set_queue(presence: State<'_, Presence>, tracks: Vec<QueueTrack>) {
    presence.set_queue(tracks);
}

/// Claims the system's media controls for the main window.
#[cfg(desktop)]
fn claim_controls(_app: &AppHandle) -> Option<MediaControls> {
    #[cfg(windows)]
    let hwnd = _app
        .get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
        .map(|hwnd| hwnd.0);

    #[cfg(not(windows))]
    let hwnd: Option<*mut std::ffi::c_void> = None;

    let config = PlatformConfig {
        dbus_name: "wave",
        display_name: "Wave",
        hwnd,
    };

    match MediaControls::new(config) {
        Ok(controls) => Some(controls),
        Err(error) => {
            eprintln!("the system media controls are not available: {error}");
            None
        }
    }
}

/// Starts the thread that keeps the system's controls up to date.
#[cfg(desktop)]
fn start_system(app: &AppHandle) -> Option<(Sender<SystemMessage>, JoinHandle<()>)> {
    let mut controls = claim_controls(app)?;
    let (sender, receiver) = mpsc::channel();
    let pressed = sender.clone();

    if let Err(error) = controls.attach(move |event| {
        let _ = pressed.send(SystemMessage::Pressed(event));
    }) {
        eprintln!("the system media controls could not be set up: {error}");
        return None;
    }

    let handle = app.clone();
    let thread = thread::spawn(move || run_system(handle, controls, receiver));
    Some((sender, thread))
}

#[cfg(desktop)]
fn run_system(app: AppHandle, mut controls: MediaControls, receiver: Receiver<SystemMessage>) {
    #[cfg(windows)]
    let _apartment = Apartment::join();

    let mut shown: Option<NowPlaying> = None;

    loop {
        let message = match receiver.recv_timeout(IDLE) {
            Ok(message) => message,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => SystemMessage::Stop,
        };

        match message {
            SystemMessage::Stop => {
                let _ = controls.set_playback(MediaPlayback::Stopped);
                let _ = controls.set_metadata(MediaMetadata::default());
                break;
            }
            SystemMessage::Pressed(event) => {
                if matches!(event, MediaControlEvent::Quit) {
                    match app.get_webview_window("main") {
                        Some(window) => {
                            if let Err(error) = window.close() {
                                eprintln!("the window could not close: {error}");
                                app.exit(0);
                            }
                        }
                        None => app.exit(0),
                    }
                    continue;
                }

                // MPRIS expects the player to publish the volume it accepted,
                // and only that backend has a setter for it.
                #[cfg(target_os = "linux")]
                if let MediaControlEvent::SetVolume(level) = &event {
                    let _ = controls.set_volume(*level);
                }

                if let Some(control) = control_of(&event) {
                    #[cfg(target_os = "linux")]
                    if let Some(player) = app.try_state::<crate::linux_playback::NativePlayback>() {
                        if player.active() && control.action != "raise" {
                            let action = if control.action == "seekTo" {
                                "seek"
                            } else {
                                control.action.as_str()
                            };
                            let mut command = crate::api::player::Command::new(action);
                            command.value = control.value;
                            if let Err(error) = player.command(&app, command) {
                                eprintln!(
                                    "the native player could not apply a media control: {error}"
                                );
                            }
                            continue;
                        }
                    }
                    let _ = app.emit(CONTROL_EVENT, control);
                }
            }
            SystemMessage::Show(song) => {
                // The cover is only read when the song actually changed.
                let changed = rewritten(shown.as_ref(), song.as_ref());

                match song.as_ref() {
                    Some(song) => show_playback(&mut controls, song),
                    None => {
                        let _ = controls.set_playback(MediaPlayback::Stopped);
                    }
                }

                if changed {
                    match song.as_ref() {
                        Some(song) => show_metadata(&mut controls, song),
                        None => {
                            let _ = controls.set_metadata(MediaMetadata::default());
                        }
                    }
                    shown = song;
                }
            }
        }
    }
}

#[cfg(target_os = "android")]
fn start_system(app: &AppHandle) -> Option<(Sender<SystemMessage>, JoinHandle<()>)> {
    let session = app
        .try_state::<crate::media_session::Session>()?
        .inner()
        .clone();
    let (sender, receiver) = mpsc::channel();
    let thread = thread::spawn(move || run_session(session, receiver));
    Some((sender, thread))
}

#[cfg(target_os = "android")]
fn run_session(session: crate::media_session::Session, receiver: Receiver<SystemMessage>) {
    loop {
        match receiver.recv() {
            Ok(SystemMessage::Show(song)) => session.show(song),
            Ok(SystemMessage::Queue(tracks)) => session.set_queue(&tracks),
            Ok(SystemMessage::Controls(enabled)) => session.set_controls(enabled),
            Ok(SystemMessage::Stop) | Err(_) => break,
        }
    }
    session.stop();
}

/// True when the controls would have to be given the song again. The position
/// is not part of it: that moves constantly and costs nothing to update.
#[cfg(desktop)]
fn rewritten(shown: Option<&NowPlaying>, next: Option<&NowPlaying>) -> bool {
    match (shown, next) {
        (None, None) => false,
        (Some(shown), Some(next)) => !same_track(shown, next),
        _ => true,
    }
}

/// The tags that make one song different from another, without the position.
#[cfg(desktop)]
fn same_track(left: &NowPlaying, right: &NowPlaying) -> bool {
    left.title == right.title
        && left.artist == right.artist
        && left.album == right.album
        && left.duration_ms == right.duration_ms
        && left.artwork == right.artwork
}

/// Puts the song's tags and cover on the system's controls.
#[cfg(desktop)]
fn show_metadata(controls: &mut MediaControls, song: &NowPlaying) {
    let cover = cover_url(&song.artwork);
    let metadata = MediaMetadata {
        title: Some(song.title.as_str()),
        artist: text(&song.artist),
        album: text(&song.album),
        cover_url: cover.as_deref(),
        duration: (song.duration_ms > 0).then(|| Duration::from_millis(song.duration_ms)),
    };

    if let Err(error) = controls.set_metadata(metadata) {
        eprintln!("the system media controls could not show the song: {error}");
    }
}

/// Tells the controls whether the song is playing, and where it has got to.
#[cfg(desktop)]
fn show_playback(controls: &mut MediaControls, song: &NowPlaying) {
    let progress = Some(MediaPosition(Duration::from_millis(song.position_ms)));
    let playback = if song.playing {
        MediaPlayback::Playing { progress }
    } else {
        MediaPlayback::Paused { progress }
    };

    if let Err(error) = controls.set_playback(playback) {
        eprintln!("the system media controls could not follow the song: {error}");
    }
}

/// A tag with nothing in it is left off rather than shown empty.
#[cfg(desktop)]
fn text(value: &str) -> Option<&str> {
    (!value.is_empty()).then_some(value)
}

/// The cover as a URL both platforms read: souvlaki loads whatever follows the
/// scheme, so a Windows path keeps its backslashes and a Linux path is already
/// the rest of a URI.
///
/// A file that is no longer there is left off rather than passed on: Windows
/// loads it itself and gives up on the whole song when it cannot, which would
/// lose the tags as well as the picture.
#[cfg(desktop)]
fn cover_url(path: &str) -> Option<String> {
    if path.is_empty() || !Path::new(path).is_file() {
        return None;
    }
    Some(format!("file://{}", cover_path(path)))
}

/// Windows takes a path to the media controls with backslashes only. The
/// library records its own relative parts with forward slashes, so a cover
/// joined onto the root arrives as `C:\...\songs\<id>/cover.jpg`, which is
/// refused outright rather than read.
#[cfg(all(desktop, windows))]
fn cover_path(path: &str) -> String {
    path.replace('/', "\\")
}

#[cfg(all(desktop, not(windows)))]
fn cover_path(path: &str) -> String {
    path.to_string()
}

/// The message the player needs for a button press, or nothing when the event
/// is one Wave has no answer for.
#[cfg(desktop)]
fn control_of(event: &MediaControlEvent) -> Option<Control> {
    let (action, value) = match event {
        MediaControlEvent::Play => ("play", None),
        MediaControlEvent::Pause => ("pause", None),
        MediaControlEvent::Toggle => ("toggle", None),
        MediaControlEvent::Next => ("next", None),
        MediaControlEvent::Previous => ("previous", None),
        MediaControlEvent::Stop => ("stop", None),
        MediaControlEvent::Seek(direction) => ("seekBy", Some(step(direction, SEEK_STEP_MS))),
        MediaControlEvent::SeekBy(direction, by) => {
            ("seekBy", Some(step(direction, by.as_millis() as u64)))
        }
        MediaControlEvent::SetPosition(position) => ("seekTo", Some(position.0.as_millis() as f64)),
        MediaControlEvent::SetVolume(level) => ("volume", Some((level * 100.0).clamp(0.0, 100.0))),
        MediaControlEvent::Raise => ("raise", None),
        _ => return None,
    };

    Some(Control {
        action: action.to_string(),
        value,
    })
}

/// How far a seek moves, negative when it goes backwards.
#[cfg(desktop)]
fn step(direction: &SeekDirection, by: u64) -> f64 {
    match direction {
        SeekDirection::Forward => by as f64,
        SeekDirection::Backward => -(by as f64),
    }
}

/// The Discord side: one connection, and the activity it last managed to
/// write, so a song that has not changed is not written again.
#[cfg(desktop)]
struct Discord {
    client_id: String,
    client: Option<DiscordIpcClient>,
    song: Option<NowPlaying>,
    /// The moment the timestamps are counted from, and where the song was then.
    anchor: Option<Anchor>,
    shown: Option<Shown>,
}

/// Where the progress bar Discord draws starts from.
#[cfg(desktop)]
#[derive(Clone, Copy)]
struct Anchor {
    at_ms: u64,
    position_ms: u64,
    playing: bool,
}

/// The activity as Discord last received it.
#[cfg(desktop)]
#[derive(Clone, PartialEq, Eq)]
struct Shown {
    title: String,
    artist: String,
    album: String,
    start: i64,
    end: i64,
}

#[cfg(desktop)]
impl Discord {
    fn new(client_id: String) -> Self {
        Self {
            client_id,
            client: None,
            song: None,
            anchor: None,
            shown: None,
        }
    }

    /// Takes in the song the front end just reported, and moves the anchor
    /// when the song, the transport or the position calls for it.
    fn show(&mut self, song: Option<NowPlaying>) {
        // A song with no title is nothing Discord can show.
        let song = song.filter(|song| !song.title.is_empty());

        let changed = match (self.song.as_ref(), song.as_ref()) {
            (Some(last), Some(next)) => !same_track(last, next) || last.playing != next.playing,
            (None, None) => false,
            _ => true,
        };

        let moved = match (self.anchor, song.as_ref()) {
            (Some(anchor), Some(next)) => changed || jumped(&anchor, next),
            (None, Some(_)) => true,
            _ => false,
        };
        if moved {
            self.anchor = song.as_ref().map(|next| Anchor {
                at_ms: now_ms(),
                position_ms: next.position_ms,
                playing: next.playing,
            });
        }

        self.song = song;
    }

    fn current(&self) -> Option<NowPlaying> {
        self.song.clone().filter(|song| song.playing)
    }

    /// Writes the activity the current state calls for, connecting first if it
    /// has to. A write that fails drops the connection, so the next pass
    /// starts over rather than talking into a pipe that is no longer there.
    fn push(&mut self) {
        let song = self.current();

        if self.client.is_none() {
            // Nothing to say yet, so there is no reason to open the pipe.
            if song.is_none() {
                return;
            }
            self.connect();
        }

        let Some(song) = song else {
            if self.shown.is_none() {
                return;
            }
            if let Some(client) = self.client.as_mut() {
                if client.clear_activity().is_err() {
                    self.client = None;
                }
            }
            self.shown = None;
            return;
        };

        let stamps = stamps(self.anchor.as_ref(), &song);
        let wanted = Shown {
            title: song.title.clone(),
            artist: song.artist.clone(),
            album: song.album.clone(),
            start: stamps.0,
            end: stamps.1,
        };
        if self.shown.as_ref() == Some(&wanted) {
            return;
        }

        let Some(client) = self.client.as_mut() else {
            return;
        };
        if client.set_activity(activity(&song, stamps)).is_ok() {
            self.shown = Some(wanted);
        } else {
            self.client = None;
            self.shown = None;
        }
    }

    /// True while Discord has not been reached and there is something to show.
    fn waiting(&self) -> bool {
        self.client.is_none() && self.current().is_some()
    }

    fn connect(&mut self) {
        let mut client = DiscordIpcClient::new(self.client_id.clone());
        if client.connect().is_ok() {
            self.client = Some(client);
        }
        // Discord is closed, or not listening yet. The next pass tries again.
    }

    /// Takes the activity down and closes the connection.
    fn stop(&mut self) {
        if let Some(mut client) = self.client.take() {
            let _ = client.clear_activity();
            let _ = client.close();
        }
        self.song = None;
        self.shown = None;
    }
}

/// True when the position is not where the anchor says it should be, which is
/// what a seek looks like from here.
#[cfg(desktop)]
fn jumped(anchor: &Anchor, song: &NowPlaying) -> bool {
    let elapsed = if anchor.playing {
        now_ms().saturating_sub(anchor.at_ms)
    } else {
        0
    };
    let expected = anchor.position_ms.saturating_add(elapsed);
    expected.abs_diff(song.position_ms) > DRIFT_MS
}

/// The two timestamps Discord draws its bar from: where the song started, and
/// where it ends. A song that is not playing has neither, so the bar stops
/// with the music.
#[cfg(desktop)]
fn stamps(anchor: Option<&Anchor>, song: &NowPlaying) -> (i64, i64) {
    let Some(anchor) = anchor else {
        return (0, 0);
    };
    if !song.playing || song.duration_ms == 0 {
        return (0, 0);
    }

    let start = anchor.at_ms.saturating_sub(anchor.position_ms) as i64;
    (start, start + song.duration_ms as i64)
}

/// The card Discord shows: the song, the artist, and the progress bar.
#[cfg(desktop)]
fn activity(song: &NowPlaying, stamps: (i64, i64)) -> Activity<'_> {
    let mut assets = Assets::new().large_image(DISCORD_ARTWORK);
    if let Some(album) = text(&song.album) {
        assets = assets.large_text(album);
    }

    let mut activity = Activity::new()
        .activity_type(ActivityType::Listening)
        .status_display_type(StatusDisplayType::Details)
        .details(song.title.as_str())
        .assets(assets);

    if let Some(artist) = text(&song.artist) {
        activity = activity.state(artist);
    }
    if stamps.1 > 0 {
        activity = activity.timestamps(Timestamps::new().start(stamps.0).end(stamps.1));
    }

    activity
}

#[cfg(desktop)]
fn start_discord(client_id: Option<String>) -> Sender<DiscordMessage> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || run_discord(client_id, receiver));
    sender
}

#[cfg(desktop)]
fn run_discord(client_id: Option<String>, receiver: Receiver<DiscordMessage>) {
    let Some(client_id) = client_id else {
        eprintln!(
            "Discord presence is switched on, but no application id is set. Put \
             DISCORD_CLIENT_ID in the config folder, or fill in \
             DEFAULT_DISCORD_CLIENT_ID in src/presence.rs"
        );
        return;
    };

    let mut discord = Discord::new(client_id);

    loop {
        let wait = if discord.waiting() {
            DISCORD_RETRY
        } else {
            IDLE
        };

        match receiver.recv_timeout(wait) {
            Ok(DiscordMessage::Show(song)) => discord.show(song),
            Ok(DiscordMessage::Stop) => {
                discord.stop();
                return;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                discord.stop();
                return;
            }
        }

        discord.push();
    }
}

/// The Discord application to report to: the config `.env` when it names one,
/// otherwise the id the build carries.
#[cfg(desktop)]
fn discord_client_id(app: &AppHandle) -> Option<String> {
    let from_env = read_env(app)
        .discord_client_id
        .filter(|id| !id.trim().is_empty());

    from_env.or_else(|| {
        (!DEFAULT_DISCORD_CLIENT_ID.is_empty()).then(|| DEFAULT_DISCORD_CLIENT_ID.to_string())
    })
}

/// WinRT wants the calling thread to be in an apartment. The main thread is
/// one already, but the worker is not, so it joins the multithreaded one for
/// as long as it lives.
#[cfg(all(desktop, windows))]
struct Apartment;

#[cfg(all(desktop, windows))]
impl Apartment {
    fn join() -> Self {
        use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};

        // A thread that is already in an apartment reports a mode change,
        // which is not a failure here.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        Self
    }
}

#[cfg(all(desktop, windows))]
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { windows::Win32::System::Com::CoUninitialize() };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn android_playback_worker_is_independent_of_media_controls() {
        assert!(system_worker_needed(true, false));
        assert!(system_worker_needed(true, true));
        assert!(!system_worker_needed(false, false));
        assert!(system_worker_needed(false, true));
    }

    fn song(title: &str, position_ms: u64, playing: bool) -> NowPlaying {
        NowPlaying {
            title: title.to_string(),
            artist: "Slowdive".to_string(),
            album: "Souvlaki".to_string(),
            duration_ms: 290_000,
            position_ms,
            playing,
            artwork: "C:\\cover.jpg".to_string(),
            colour: "#334455".to_string(),
        }
    }

    #[cfg(desktop)]
    #[test]
    fn a_song_is_only_written_to_the_controls_when_it_changes() {
        let first = song("When The Sun Hits", 0, true);
        let later = song("When The Sun Hits", 40_000, true);
        let other = song("Alison", 0, true);

        assert!(!rewritten(Some(&first), Some(&later)));
        assert!(rewritten(Some(&first), Some(&other)));
        assert!(rewritten(Some(&first), None));
        assert!(rewritten(None, Some(&first)));
        assert!(!rewritten(None, None));
    }

    #[cfg(desktop)]
    #[test]
    fn the_cover_is_a_url_souvlaki_can_load() {
        let cover = std::env::temp_dir().join("wave-presence-cover.jpg");
        std::fs::write(&cover, b"not really a jpeg").unwrap();
        let path = cover.to_string_lossy().to_string();
        let expected = format!("file://{path}");

        assert_eq!(cover_url(&path).as_deref(), Some(expected.as_str()));

        let _ = std::fs::remove_file(&cover);
        assert_eq!(cover_url(&path), None);
        assert_eq!(cover_url(""), None);
    }

    /// The library records its relative parts with forward slashes, so a cover
    /// joined onto the root arrives mixed. Windows refuses such a path outright,
    /// which used to cost the song its tags along with its picture.
    #[cfg(all(desktop, windows))]
    #[test]
    fn a_cover_path_is_handed_over_with_backslashes() {
        let cover = std::env::temp_dir().join("wave-presence-mixed.jpg");
        std::fs::write(&cover, b"not really a jpeg").unwrap();
        let mixed = cover.to_string_lossy().replace('\\', "/");

        let url = cover_url(&mixed).unwrap();
        let path = url.trim_start_matches("file://");

        assert!(!path.contains('/'), "{path}");

        let _ = std::fs::remove_file(&cover);
    }

    #[cfg(desktop)]
    #[test]
    fn a_button_press_becomes_what_the_player_understands() {
        let control = control_of(&MediaControlEvent::Next).unwrap();
        assert_eq!(control.action, "next");
        assert_eq!(control.value, None);

        for (direction, expected) in [
            (SeekDirection::Backward, -10_000.0),
            (SeekDirection::Forward, 10_000.0),
        ] {
            let control = control_of(&MediaControlEvent::Seek(direction)).unwrap();
            assert_eq!(control.action, "seekBy");
            assert_eq!(control.value, Some(expected));

            let control = control_of(&MediaControlEvent::SeekBy(
                direction,
                Duration::from_micros(10_000_000),
            ))
            .unwrap();
            assert_eq!(control.action, "seekBy");
            assert_eq!(control.value, Some(expected));
        }

        let control = control_of(&MediaControlEvent::SeekBy(
            SeekDirection::Backward,
            Duration::from_millis(2_500),
        ))
        .unwrap();
        assert_eq!(control.action, "seekBy");
        assert_eq!(control.value, Some(-2_500.0));

        let control = control_of(&MediaControlEvent::SetVolume(0.5)).unwrap();
        assert_eq!(control.action, "volume");
        assert_eq!(control.value, Some(50.0));

        let control = control_of(&MediaControlEvent::SetPosition(MediaPosition(
            Duration::from_millis(1_500),
        )))
        .unwrap();
        assert_eq!(control.action, "seekTo");
        assert_eq!(control.value, Some(1_500.0));

        assert!(control_of(&MediaControlEvent::Quit).is_none());
    }

    #[cfg(desktop)]
    #[test]
    fn a_seek_moves_the_timestamps_and_a_tick_does_not() {
        let mut discord = Discord::new("id".to_string());
        discord.show(Some(song("When The Sun Hits", 0, true)));
        let first = stamps(discord.anchor.as_ref(), discord.song.as_ref().unwrap());

        // A second later, where the song was always going to be.
        discord.show(Some(song("When The Sun Hits", 1_000, true)));
        assert_eq!(
            stamps(discord.anchor.as_ref(), discord.song.as_ref().unwrap()),
            first
        );

        // A jump forwards is a seek, so the bar starts again from there: the
        // song began two minutes later, so its start time is earlier.
        discord.show(Some(song("When The Sun Hits", 120_000, true)));
        let after = stamps(discord.anchor.as_ref(), discord.song.as_ref().unwrap());
        assert!(after.0 < first.0);
        assert!(after.1 > after.0);
    }

    #[cfg(desktop)]
    #[test]
    fn a_paused_song_has_no_progress_bar() {
        let mut discord = Discord::new("id".to_string());
        discord.show(Some(song("Alison", 30_000, false)));

        assert_eq!(
            stamps(discord.anchor.as_ref(), discord.song.as_ref().unwrap()),
            (0, 0)
        );
    }

    #[cfg(desktop)]
    #[test]
    fn a_paused_song_is_not_held() {
        let mut discord = Discord::new("id".to_string());
        discord.show(Some(song("Alison", 25_000, true)));
        assert!(discord.current().is_some());
        assert!(discord.waiting());

        discord.show(Some(song("Alison", 30_000, false)));

        assert!(discord.current().is_none());
        assert!(!discord.waiting());

        discord.push();
        assert!(discord.client.is_none());
        assert!(discord.shown.is_none());

        discord.show(Some(song("Alison", 90_000, false)));
        assert!(discord.current().is_none());
        assert!(!discord.waiting());

        discord.show(Some(song("Alison", 90_000, true)));
        assert!(discord.current().is_some());
        assert!(discord.waiting());
        let anchor = discord.anchor.as_ref().unwrap();
        let stamps = stamps(Some(anchor), discord.song.as_ref().unwrap());
        assert!(anchor.playing);
        assert_eq!(anchor.position_ms, 90_000);
        assert_eq!(stamps.0, anchor.at_ms.saturating_sub(90_000) as i64);
        assert_eq!(stamps.1 - stamps.0, 290_000);

        discord.show(None);
        assert!(discord.current().is_none());
        assert!(!discord.waiting());
    }

    #[cfg(desktop)]
    #[test]
    fn a_pause_clears_a_shown_activity_even_if_the_connection_fails() {
        let mut discord = Discord::new("id".to_string());
        discord.client = Some(DiscordIpcClient::new("id"));
        discord.shown = Some(Shown {
            title: "Alison".to_string(),
            artist: "Slowdive".to_string(),
            album: "Souvlaki".to_string(),
            start: 1,
            end: 2,
        });
        discord.show(Some(song("Alison", 30_000, false)));

        discord.push();
        assert!(discord.client.is_none());
        assert!(discord.shown.is_none());
        assert!(!discord.waiting());

        discord.show(Some(song("Alison", 30_000, true)));
        assert!(discord.waiting());
    }

    #[cfg(desktop)]
    #[test]
    #[ignore = "requires Discord and temporarily updates its activity"]
    fn live_discord_presence_tracks_pause_and_resume() {
        let mut discord = Discord::new(DEFAULT_DISCORD_CLIENT_ID.to_string());

        discord.show(Some(song("Wave presence verification", 30_000, true)));
        discord.push();
        let (_, response) = discord.client.as_mut().unwrap().recv().unwrap();
        assert_eq!(response["cmd"], "SET_ACTIVITY");
        assert_ne!(response["evt"], "ERROR");
        assert_eq!(response["data"]["details"], "Wave presence verification");

        discord.show(Some(song("Wave presence verification", 30_000, false)));
        discord.push();
        let (_, response) = discord.client.as_mut().unwrap().recv().unwrap();
        assert_eq!(response["cmd"], "SET_ACTIVITY");
        assert_ne!(response["evt"], "ERROR");
        assert!(response["data"].is_null());

        discord.show(Some(song("Wave presence verification", 90_000, true)));
        discord.push();
        let (_, response) = discord.client.as_mut().unwrap().recv().unwrap();
        assert_eq!(response["cmd"], "SET_ACTIVITY");
        assert_ne!(response["evt"], "ERROR");
        assert_eq!(response["data"]["details"], "Wave presence verification");
        let expected = stamps(discord.anchor.as_ref(), discord.song.as_ref().unwrap());
        assert_eq!(response["data"]["timestamps"]["start"], expected.0);
        assert_eq!(response["data"]["timestamps"]["end"], expected.1);
        discord.stop();
    }

    #[cfg(desktop)]
    #[test]
    fn a_song_with_no_title_is_not_shown() {
        let mut discord = Discord::new("id".to_string());
        discord.show(Some(song("", 0, true)));

        assert!(discord.song.is_none());
    }
}
