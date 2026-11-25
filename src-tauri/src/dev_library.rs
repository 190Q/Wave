//! Desktop development can use its own library or the installed app's library.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

const SHARED_SUFFIX: &str = ".dev.shared";

fn is_shared(development: bool, requested: Option<&OsStr>) -> bool {
    development && (requested.is_none() || requested == Some(OsStr::new("shared")))
}

pub fn shared() -> bool {
    is_shared(cfg!(dev), std::env::var_os("WAVE_DEV_LIBRARY").as_deref())
}

fn installed_dir(base: &Path, identifier: &str) -> Result<PathBuf, String> {
    let installed = identifier
        .strip_suffix(SHARED_SUFFIX)
        .filter(|identifier| !identifier.is_empty())
        .ok_or_else(|| "could not identify the installed Wave data".to_string())?;
    Ok(base.join(installed))
}

fn installed_app_dir<R: Runtime>(app: &AppHandle<R>, base: &Path) -> Result<PathBuf, String> {
    if app.config().app.app_directories_override.is_some() {
        return Err("the installed Wave data cannot be located with app directory overrides".to_string());
    }
    installed_dir(base, &app.config().identifier)
}

pub fn installed_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app.path().data_dir()
        .map_err(|e| format!("could not resolve the app data directory: {e}"))?;
    installed_app_dir(app, &base)
}

pub fn installed_config_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app.path().config_dir()
        .map_err(|e| format!("could not resolve the app config directory: {e}"))?;
    installed_app_dir(app, &base)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_development_defaults_to_shared() {
        assert!(is_shared(true, Some(OsStr::new("shared"))));
        assert!(is_shared(true, None));
        assert!(!is_shared(false, Some(OsStr::new("shared"))));
        assert!(!is_shared(false, None));
        assert!(!is_shared(true, Some(OsStr::new("isolated"))));
        assert!(!is_shared(true, Some(OsStr::new("other"))));
    }

    #[test]
    fn shared_paths_use_the_installed_identifier() {
        let data = Path::new("data");
        assert_eq!(
            installed_dir(data, "com.wave.app.dev.shared").unwrap(),
            data.join("com.wave.app")
        );
        assert!(installed_dir(data, "com.wave.app.dev").is_err());
        assert!(installed_dir(data, ".dev.shared").is_err());
    }
}
