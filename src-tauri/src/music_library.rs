//! The phone's own music: the permission to read it, the folders songs live
//! in, and the names behind the `content://` URIs the picker hands back.
//!
//! All of that is behind Android's own APIs, so it lives in a Kotlin plugin
//! beside the app, at gen/android/app/src/main/java/com/wave/app/
//! MusicLibraryPlugin.kt. This module is the Rust half of it.

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{Manager, Wry};

/// Where the Kotlin plugin lives, and what it is called.
const PLUGIN_PACKAGE: &str = "com.wave.app";
const PLUGIN_CLASS: &str = "MusicLibraryPlugin";

/// The name the plugin is registered under.
const PLUGIN_NAME: &str = "wave-music-library";

#[derive(Debug, Deserialize)]
struct Granted {
    granted: bool,
}

#[derive(Debug, Deserialize)]
struct Directories {
    directories: Vec<String>,
}

/// The names of the picked files, in the order they were asked about.
#[derive(Debug, Deserialize)]
struct Names {
    names: Vec<String>,
}

/// What `names` is called with.
#[derive(Serialize)]
struct Uris<'a> {
    uris: &'a [String],
}

/// The Rust half of the Kotlin plugin.
#[derive(Clone)]
pub struct MusicLibrary(PluginHandle<Wry>);

impl MusicLibrary {
    /// Asks for the permission to read the phone's audio, and says whether it
    /// was granted. Android 13 and later ask for audio on its own; older
    /// versions ask for the whole of shared storage.
    pub fn request_audio_permission(&self) -> Result<bool, String> {
        self.0
            .run_mobile_plugin::<Granted>("requestAudioPermission", ())
            .map(|answer| answer.granted)
            .map_err(|error| format!("the audio permission could not be asked for: {error}"))
    }

    /// The standard music folders the phone has, in the order to import them.
    pub fn music_directories(&self) -> Result<Vec<String>, String> {
        self.0
            .run_mobile_plugin::<Directories>("musicDirectories", ())
            .map(|found| found.directories)
            .map_err(|error| format!("the music folders could not be read: {error}"))
    }

    /// What the system calls each picked file, so the library can name the
    /// songs after them and keep their extension.
    pub fn names(&self, uris: &[String]) -> Result<Vec<String>, String> {
        self.0
            .run_mobile_plugin::<Names>("names", Uris { uris })
            .map(|found| found.names)
            .map_err(|error| format!("the picked files could not be read: {error}"))
    }
}

/// Registers the Kotlin plugin and keeps the handle the app reaches it through.
pub fn init() -> TauriPlugin<Wry> {
    Builder::new(PLUGIN_NAME)
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_PACKAGE, PLUGIN_CLASS)?;
            app.manage(MusicLibrary(handle));
            Ok(())
        })
        .build()
}
