//! Registers the Android media session plugin and forwards fallback updates.

use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{Manager, Wry};

use crate::presence::{NowPlaying, QueueTrack};

/// Where the Kotlin plugin lives, and what it is called.
const PLUGIN_PACKAGE: &str = "com.wave.app";
const PLUGIN_CLASS: &str = "MediaSessionPlugin";

/// The name the plugin is registered under.
const PLUGIN_NAME: &str = "wave-media-session";

/// The song as the Kotlin side reads it. The cover is the library's own path,
/// which the plugin decodes itself: no URL and no CORS to worry about.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Song {
    title: String,
    artist: String,
    album: String,
    duration_ms: u64,
    position_ms: u64,
    playing: bool,
    artwork_path: String,
    colour: String,
}

impl From<&NowPlaying> for Song {
    fn from(song: &NowPlaying) -> Self {
        Self {
            title: song.title.clone(),
            artist: song.artist.clone(),
            album: song.album.clone(),
            duration_ms: song.duration_ms,
            position_ms: song.position_ms,
            playing: song.playing,
            artwork_path: song.artwork.clone(),
            colour: song.colour.clone(),
        }
    }
}

/// What `setNowPlaying` is called with. A null song takes the session down
/// without ending the process, which is what the front end does when nothing
/// is loaded.
#[derive(serde::Serialize)]
struct Show {
    song: Option<Song>,
}

/// What `setQueue` is called with.
#[derive(serde::Serialize)]
struct Queue<'a> {
    tracks: &'a [QueueTrack],
}

#[derive(serde::Serialize)]
struct Controls {
    enabled: bool,
}

#[derive(serde::Serialize)]
struct LogFile<'a> {
    name: &'a str,
}

/// The Rust half of the Kotlin media session.
#[derive(Clone)]
pub struct Session(PluginHandle<Wry>);

impl Session {
    pub fn audio_outputs(&self) -> Result<crate::audio_outputs::AudioOutputs, String> {
        self.0
            .run_mobile_plugin("getAudioOutputs", ())
            .map_err(|error| format!("the audio outputs could not be read: {error}"))
    }

    pub fn open_music_folder(&self) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("openMusicFolder", ())
            .map(|_| ())
            .map_err(|error| format!("the music folder could not be opened: {error}"))
    }

    pub fn open_log(&self, name: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("openLog", LogFile { name })
            .map(|_| ())
            .map_err(|error| format!("the log viewer could not be opened: {error}"))
    }

    /// Shows a song on the phone's session, or clears it when there is none.
    pub fn show(&self, song: Option<NowPlaying>) {
        let payload = Show {
            song: song.as_ref().map(Song::from),
        };
        if let Err(error) = self
            .0
            .run_mobile_plugin::<serde_json::Value>("setNowPlaying", payload)
        {
            eprintln!("the phone's media session could not follow the song: {error}");
        }
    }

    /// Hands the play order over, so the phone's own card can offer the queue.
    pub fn set_queue(&self, tracks: &[QueueTrack]) {
        let payload = Queue { tracks };
        if let Err(error) = self
            .0
            .run_mobile_plugin::<serde_json::Value>("setQueue", payload)
        {
            eprintln!("the phone's media session could not be given the queue: {error}");
        }
    }

    pub fn set_controls(&self, enabled: bool) {
        if let Err(error) = self
            .0
            .run_mobile_plugin::<serde_json::Value>("setControls", Controls { enabled })
        {
            eprintln!("the phone's media controls could not be changed: {error}");
        }
    }

    /// Takes the notification down and stops the playback service.
    pub fn stop(&self) {
        if let Err(error) = self
            .0
            .run_mobile_plugin::<serde_json::Value>("stopSession", ())
        {
            eprintln!("the phone's media session could not be taken down: {error}");
        }
    }
}

/// Registers the Kotlin plugin and keeps the handle the app reaches it through.
pub fn init() -> TauriPlugin<Wry> {
    Builder::new(PLUGIN_NAME)
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_PACKAGE, PLUGIN_CLASS)?;
            let session = Session(handle);
            app.manage(session);
            Ok(())
        })
        .build()
}
