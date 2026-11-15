//! The phone's own music, permissions, and content URI metadata.
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
struct MusicFiles {
    files: Vec<MusicFile>,
}

#[derive(Debug, Deserialize)]
pub struct MusicFile {
    pub uri: String,
    pub name: String,
    pub mime: Option<String>,
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

#[derive(Debug, Deserialize)]
struct Folder {
    uri: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FolderFiles {
    files: Vec<FolderFile>,
}

#[derive(Debug, Deserialize)]
pub struct FolderFile {
    pub uri: String,
    pub parent: String,
    pub name: String,
}

#[derive(Serialize)]
struct UriArg<'a> {
    uri: &'a str,
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

    pub fn music_files(&self) -> Result<Vec<MusicFile>, String> {
        self.0
            .run_mobile_plugin::<MusicFiles>("musicFiles", ())
            .map(|found| found.files)
            .map_err(|error| format!("the phone's music index could not be read: {error}"))
    }

    /// What the system calls each picked file, so the library can name the
    /// songs after them and keep their extension.
    pub fn names(&self, uris: &[String]) -> Result<Vec<String>, String> {
        self.0
            .run_mobile_plugin::<Names>("names", Uris { uris })
            .map(|found| found.names)
            .map_err(|error| format!("the picked files could not be read: {error}"))
    }

    pub fn pick_folder(&self) -> Result<Option<String>, String> {
        self.0
            .run_mobile_plugin::<Folder>("pickFolder", ())
            .map(|answer| answer.uri)
            .map_err(|error| format!("the folder picker could not be opened: {error}"))
    }

    pub fn folder_files(&self, uri: &str) -> Result<Vec<FolderFile>, String> {
        self.0
            .run_mobile_plugin::<FolderFiles>("folderFiles", UriArg { uri })
            .map(|answer| answer.files)
            .map_err(|error| format!("the selected folder could not be read: {error}"))
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
