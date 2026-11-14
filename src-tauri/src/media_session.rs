//! The phone's own media session.
//!
//! Android has no souvlaki backend, so the session the lockscreen, the
//! notification shade and the headset buttons see is a Kotlin plugin beside the
//! app, at gen/android/app/src/main/java/com/wave/app/MediaSessionPlugin.kt.
//! This module is the Rust half of it: it registers that plugin, pushes the
//! song across to it, and turns the button presses that come back into the same
//! `Control` the desktop path emits. Nothing above this module has to know
//! which platform it is running on.

use serde::Deserialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::presence::{Control, NowPlaying, CONTROL_EVENT};

/// Where the Kotlin plugin lives, and what it is called.
const PLUGIN_PACKAGE: &str = "com.wave.app";
const PLUGIN_CLASS: &str = "MediaSessionPlugin";

/// The name the plugin is registered under.
const PLUGIN_NAME: &str = "wave-media-session";

/// A button the phone's session reports, in the shape the plugin sends it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pressed {
    action: String,
    #[serde(default)]
    value: Option<f64>,
}

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

/// What `startEvents` is called with.
#[derive(serde::Serialize)]
struct Events {
    channel: Channel<serde_json::Value>,
}

/// The Rust half of the Kotlin media session.
#[derive(Clone)]
pub struct Session(PluginHandle<Wry>);

impl Session {
    /// Hands the plugin the channel its button presses come back on, so a press
    /// reaches the front end as the same `media-control` event the desktop
    /// path emits.
    fn listen(&self, app: &AppHandle<Wry>) -> Result<(), Box<dyn std::error::Error>> {
        let handle = app.clone();
        let channel = Channel::<serde_json::Value>::new(move |body| {
            let InvokeResponseBody::Json(raw) = body else {
                return Ok(());
            };
            if let Ok(pressed) = serde_json::from_str::<Pressed>(&raw) {
                let _ = handle.emit(
                    CONTROL_EVENT,
                    Control {
                        action: pressed.action,
                        value: pressed.value,
                    },
                );
            }
            Ok(())
        });

        self.0
            .run_mobile_plugin::<serde_json::Value>("startEvents", Events { channel })?;
        Ok(())
    }

    /// Shows a song on the phone's session, or clears it when there is none.
    pub fn show(&self, song: Option<NowPlaying>) {
        let payload = Show {
            song: song.as_ref().map(Song::from),
        };
        if let Err(error) =
            self.0
                .run_mobile_plugin::<serde_json::Value>("setNowPlaying", payload)
        {
            eprintln!("the phone's media session could not follow the song: {error}");
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
            session.listen(app)?;
            app.manage(session);
            Ok(())
        })
        .build()
}
