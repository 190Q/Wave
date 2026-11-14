//! Handing a downloaded update to the phone's own installer.
//!
//! Android does not let an app replace its own install, but it does let one ask
//! the system installer to. That is a Kotlin plugin beside the app, at
//! gen/android/app/src/main/java/com/wave/app/ApkInstallPlugin.kt, which
//! resolves the download through the app's FileProvider and starts the install
//! intent. This module is the Rust half of it.

use serde::Serialize;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{Manager, Wry};

/// Where the Kotlin plugin lives, and what it is called.
const PLUGIN_PACKAGE: &str = "com.wave.app";
const PLUGIN_CLASS: &str = "ApkInstallPlugin";

/// The name the plugin is registered under.
const PLUGIN_NAME: &str = "wave-apk-install";

/// What `installApk` is called with.
#[derive(Serialize)]
struct Apk<'a> {
    path: &'a str,
}

/// The Rust half of the Kotlin installer.
#[derive(Clone)]
pub struct ApkInstaller(PluginHandle<Wry>);

impl ApkInstaller {
    /// Asks the system installer to take the file over. It asks the user to
    /// confirm, so this only says the request was made.
    pub fn install(&self, path: &str) -> Result<(), String> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("installApk", Apk { path })
            .map(|_| ())
            .map_err(|error| format!("the installer could not be opened: {error}"))
    }
}

/// Registers the Kotlin plugin and keeps the handle the app reaches it through.
pub fn init() -> TauriPlugin<Wry> {
    Builder::new(PLUGIN_NAME)
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_PACKAGE, PLUGIN_CLASS)?;
            app.manage(ApkInstaller(handle));
            Ok(())
        })
        .build()
}
