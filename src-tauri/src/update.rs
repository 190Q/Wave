//! Checking for a newer release and installing it.
//!
//! The latest release is read from GitHub's releases API, the installer for
//! this platform is picked out of its assets, and on Windows and Linux Wave
//! can install it itself rather than sending the user to the release page.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::{self, Store};

/// The latest release, from the public releases API.
const RELEASES_URL: &str = "https://api.github.com/repos/190Q/Wave/releases/latest";

/// How long a metadata request may take before it is given up on.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// The size of each read while the installer downloads.
const CHUNK: usize = 64 * 1024;

/// Sent with the bytes received so far while the installer downloads.
const UPDATE_PROGRESS_EVENT: &str = "update-progress";

/// A newer release the app can offer to install.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateInfo {
    /// The release version, without a leading `v`.
    pub version: String,
    /// The release page, for a manual download.
    pub url: String,
    /// The lines under the release's `New features` heading.
    pub features: Vec<String>,
    /// When the release was published, as RFC 3339.
    pub published_at: String,
    /// The installer for this platform, empty when the release carries none.
    pub asset_name: String,
    /// Where that installer can be downloaded from.
    pub asset_url: String,
    /// True when Wave can install it itself rather than leaving it to the user.
    pub automatic: bool,
}

/// What the front end is told while the installer downloads.
#[derive(Clone, Serialize)]
struct Progress {
    received: u64,
    total: u64,
}

/// A GitHub release, in the shape the API returns it.
#[derive(Deserialize, Default)]
struct Release {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    published_at: String,
    #[serde(default)]
    assets: Vec<Asset>,
}

/// One file attached to a release.
#[derive(Debug, Clone, Deserialize, Default)]
struct Asset {
    #[serde(default)]
    name: String,
    #[serde(default)]
    browser_download_url: String,
}

/// The one HTTP client the updater uses. A whole-request timeout is set on the
/// metadata call instead, so a long installer download is not cut short.
fn client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .connect_timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new())
    })
}

/// Checks for a newer release and keeps the newest offer seen.
///
/// A release that is no newer than the running version clears the offer, and a
/// reading older than the one already stored never replaces it.
fn check(app: &AppHandle) -> Result<Option<UpdateInfo>, String> {
    let store = app.state::<Store>();
    let current = app.package_info().version.to_string();
    let release = latest_release(&current)?;

    let tag = release.tag_name.trim();
    let version = tag.strip_prefix('v').unwrap_or(tag).to_string();

    if !is_newer(&version, &current) {
        // The app has caught up, so the offer no longer stands.
        let next = store.update(|state| state.update = None);
        state::save(app, &next)?;
        return Ok(None);
    }

    let asset = installer_asset(&release.assets);
    let info = UpdateInfo {
        version,
        url: release.html_url,
        features: feature_lines(&release.body),
        published_at: release.published_at,
        asset_name: asset
            .as_ref()
            .map(|asset| asset.name.clone())
            .unwrap_or_default(),
        asset_url: asset
            .as_ref()
            .map(|asset| asset.browser_download_url.clone())
            .unwrap_or_default(),
        automatic: asset.is_some() && can_install_itself(),
    };

    if let Some(stored) = store.snapshot().update {
        if !is_newer(&info.version, &stored.version) {
            return Ok(Some(stored));
        }
    }

    let next = store.update(|state| state.update = Some(info.clone()));
    state::save(app, &next)?;
    Ok(Some(info))
}

/// The releases are read with a blocking client, which has to be on a thread of
/// its own rather than on the one the window runs on.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || check(&handle))
        .await
        .map_err(|e| format!("the update check stopped unexpectedly: {e}"))?
}

/// The update already found, without any network access. The settings panel
/// calls this when it opens so the button can already say what is waiting.
#[tauri::command]
pub fn update_status(app: AppHandle, store: State<'_, Store>) -> Option<UpdateInfo> {
    let stored = store.snapshot().update?;
    let current = app.package_info().version.to_string();
    if is_newer(&stored.version, &current) {
        return Some(stored);
    }

    let next = store.update(|state| state.update = None);
    let _ = state::save(&app, &next);
    None
}

/// Downloads the stored installer and starts it, then closes the app.
fn install_stored(app: &AppHandle) -> Result<(), String> {
    let store = app.state::<Store>();
    let Some(info) = store.snapshot().update else {
        return Err("there is no update to install".to_string());
    };

    if !info.automatic {
        return Err(format!(
            "this install cannot update itself, so the update has to come from {}",
            info.url
        ));
    }

    let downloaded = std::env::temp_dir().join(&info.asset_name);
    download(app, &info.asset_url, &downloaded)?;
    install(app, &downloaded, &info)
}

/// The installer is downloaded with a blocking client, so it is put on a thread
/// of its own rather than on the one the window runs on.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || install_stored(&handle))
        .await
        .map_err(|e| format!("the update stopped unexpectedly: {e}"))?
}

/// Reads the latest release from GitHub's releases API.
fn latest_release(current: &str) -> Result<Release, String> {
    let response = client()
        .get(RELEASES_URL)
        .header(reqwest::header::USER_AGENT, format!("Wave/{current}"))
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .timeout(REQUEST_TIMEOUT)
        .send()
        .map_err(|e| format!("the release list could not be reached: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "the release list was refused ({})",
            response.status().as_u16()
        ));
    }

    let body = response.text().unwrap_or_default();
    serde_json::from_str(&body).map_err(|e| format!("the release list was not understood: {e}"))
}

/// Streams the installer to `destination`, reporting progress as it goes.
fn download(app: &AppHandle, url: &str, destination: &Path) -> Result<(), String> {
    let mut response = client()
        .get(url)
        .send()
        .map_err(|e| format!("the installer could not be reached: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "the installer was refused ({})",
            response.status().as_u16()
        ));
    }

    // A server that sends no length reports 0, which the front end reads as
    // unknown rather than as an empty file.
    let total = response.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(destination)
        .map_err(|e| format!("could not write {}: {e}", destination.display()))?;

    let mut received: u64 = 0;
    let mut buffer = vec![0u8; CHUNK];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|e| format!("the installer download stopped: {e}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|e| format!("could not write {}: {e}", destination.display()))?;
        received += read as u64;
        let _ = app.emit(UPDATE_PROGRESS_EVENT, Progress { received, total });
    }

    Ok(())
}

/// True when `candidate` is a higher version than `current`.
fn is_newer(candidate: &str, current: &str) -> bool {
    let candidate = version_parts(candidate);
    let current = version_parts(current);
    let count = candidate.len().max(current.len());

    for index in 0..count {
        let left = candidate.get(index).copied().unwrap_or(0);
        let right = current.get(index).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }
    false
}

/// The numeric parts of a version, with a leading `v` and any `-suffix` gone.
fn version_parts(version: &str) -> Vec<u64> {
    let version = version.strip_prefix('v').unwrap_or(version);
    let version = version.split('-').next().unwrap_or(version);

    version
        .split('.')
        .map(|part| part.trim().parse::<u64>().unwrap_or(0))
        .collect()
}

/// The lines of the release body's `New features` list.
fn feature_lines(body: &str) -> Vec<String> {
    let mut features = Vec::new();
    let mut after_heading = false;

    for line in body.lines() {
        let line = line.trim();
        if !after_heading {
            after_heading = line.starts_with("## New features");
            continue;
        }
        if let Some(feature) = line.strip_prefix("- ") {
            let feature = feature.trim();
            if !feature.is_empty() {
                features.push(feature.to_string());
            }
            continue;
        }
        // An empty bullet is dropped, but anything else ends the list.
        if line.is_empty() || line == "-" {
            continue;
        }
        break;
    }

    features
}

/// The installer to offer for this platform, if the release carries one.
fn installer_asset(assets: &[Asset]) -> Option<Asset> {
    pick_asset(assets, installer_names())
}

/// Picks the asset whose name ends with the preferred suffix, then the plain
/// one. The slim name is a longer ending, so it is looked for first.
fn pick_asset(assets: &[Asset], names: (&str, &str)) -> Option<Asset> {
    let (preferred, plain) = names;

    assets
        .iter()
        .find(|asset| !preferred.is_empty() && asset.name.ends_with(preferred))
        .or_else(|| assets.iter().find(|asset| !plain.is_empty() && asset.name.ends_with(plain)))
        .cloned()
}

/// The two name endings the installer for this platform may have.
#[cfg(windows)]
fn installer_names() -> (&'static str, &'static str) {
    ("-setup-slim.exe", "-setup.exe")
}

#[cfg(target_os = "linux")]
fn installer_names() -> (&'static str, &'static str) {
    ("-slim.AppImage", ".AppImage")
}

#[cfg(not(any(windows, target_os = "linux")))]
fn installer_names() -> (&'static str, &'static str) {
    ("", "")
}

/// True when Wave can replace its own install rather than pointing at the
/// release page.
#[cfg(windows)]
fn can_install_itself() -> bool {
    true
}

/// An AppImage can replace itself. A `.deb` or `.rpm` install needs root, so
/// it is left to the release page.
#[cfg(target_os = "linux")]
fn can_install_itself() -> bool {
    std::env::var_os("APPIMAGE").is_some()
}

#[cfg(not(any(windows, target_os = "linux")))]
fn can_install_itself() -> bool {
    false
}

/// Runs the downloaded installer, which starts Wave again once it is done.
#[cfg(windows)]
fn install(app: &AppHandle, downloaded: &Path, _info: &UpdateInfo) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    // Silent, over the existing copy, and start Wave again afterwards. The
    // installer reads these in its `.onInit` and `.onInstSuccess`.
    std::process::Command::new(downloaded)
        .args(["/S", "/UPDATE", "/R"])
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map_err(|e| format!("the installer could not be started: {e}"))?;

    exit_soon(app);
    Ok(())
}

/// Replaces the running AppImage with the download and starts it again.
#[cfg(target_os = "linux")]
fn install(app: &AppHandle, downloaded: &Path, info: &UpdateInfo) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let appimage_os = std::env::var_os("APPIMAGE")
        .ok_or_else(|| "this install is not an AppImage, so it cannot update itself".to_string())?;
    let appimage = Path::new(&appimage_os);
    let folder = appimage
        .parent()
        .ok_or_else(|| "the AppImage has no folder to write into".to_string())?;

    // Staged beside the AppImage so the rename stays on one filesystem, which
    // a running executable can be swapped through and written to can not.
    let staged = folder.join(format!("{}.part", info.asset_name));
    std::fs::copy(downloaded, &staged)
        .map_err(|e| format!("could not write {}: {e}", staged.display()))?;
    std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("could not make {} runnable: {e}", staged.display()))?;
    std::fs::rename(&staged, appimage)
        .map_err(|e| format!("could not replace {}: {e}", appimage.display()))?;

    std::process::Command::new(appimage)
        .spawn()
        .map_err(|e| format!("the new AppImage could not be started: {e}"))?;

    exit_soon(app);
    Ok(())
}

#[cfg(not(any(windows, target_os = "linux")))]
fn install(_app: &AppHandle, _downloaded: &Path, _info: &UpdateInfo) -> Result<(), String> {
    Err("this platform cannot update itself".to_string())
}

/// Lets the front end paint its last state, then closes the app so the
/// installer is not fighting a running copy.
fn exit_soon(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        handle.exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> Asset {
        Asset {
            name: name.to_string(),
            browser_download_url: format!("https://example.com/{name}"),
        }
    }

    #[test]
    fn a_newer_patch_version_is_newer() {
        assert!(is_newer("0.1.5", "0.1.4"));
    }

    #[test]
    fn a_newer_minor_version_is_newer() {
        assert!(is_newer("0.2.0", "0.1.9"));
    }

    #[test]
    fn a_newer_major_version_is_newer() {
        assert!(is_newer("1.0.0", "0.9.9"));
    }

    #[test]
    fn the_same_version_is_not_newer() {
        assert!(!is_newer("0.1.4", "0.1.4"));
        assert!(!is_newer("v0.1.4", "0.1.4"));
    }

    #[test]
    fn an_older_version_is_not_newer() {
        assert!(!is_newer("0.1.3", "0.1.4"));
    }

    #[test]
    fn a_v_prefix_and_a_suffix_are_ignored() {
        assert!(is_newer("v0.1.5", "0.1.4"));
        assert!(is_newer("0.1.5-beta.1", "0.1.4"));
        assert!(!is_newer("0.1.5-beta.1", "0.1.5"));
    }

    #[test]
    fn a_double_digit_part_beats_a_single_digit_one() {
        assert!(is_newer("0.1.10", "0.1.9"));
    }

    #[test]
    fn the_feature_list_is_read_from_the_release_notes() {
        let body = "\
## New features

- Added a queue
- Fixed a bug

Installers for Windows and Linux.
";

        assert_eq!(
            feature_lines(body),
            vec!["Added a queue".to_string(), "Fixed a bug".to_string()]
        );
    }

    #[test]
    fn a_heading_with_a_note_after_it_still_counts() {
        let body = "## New features (0.1.5)\n\n- Added a queue\n";

        assert_eq!(feature_lines(body), vec!["Added a queue".to_string()]);
    }

    #[test]
    fn a_body_with_no_feature_heading_has_no_features() {
        let body = "A quiet release with nothing to list.\n";

        assert!(feature_lines(body).is_empty());
    }

    #[test]
    fn the_feature_list_stops_at_the_paragraph_after_it() {
        let body = "\
## New features

- Added a queue

Installers for Windows and Linux.
- Not a feature
";

        assert_eq!(feature_lines(body), vec!["Added a queue".to_string()]);
    }

    #[test]
    fn the_slim_installer_is_chosen_over_the_plain_one() {
        let assets = vec![
            asset("Wave_0.1.5_x64-setup.exe"),
            asset("Wave_0.1.5_x64-setup-slim.exe"),
        ];

        let chosen = pick_asset(&assets, ("-setup-slim.exe", "-setup.exe")).unwrap();

        assert_eq!(chosen.name, "Wave_0.1.5_x64-setup-slim.exe");
    }

    #[test]
    fn the_plain_installer_is_taken_when_there_is_no_slim_one() {
        let assets = vec![asset("Wave_0.1.5_x64-setup.exe")];

        let chosen = pick_asset(&assets, ("-setup-slim.exe", "-setup.exe")).unwrap();

        assert_eq!(chosen.name, "Wave_0.1.5_x64-setup.exe");
    }

    #[test]
    fn a_release_with_no_matching_asset_leaves_nothing_to_install() {
        let assets = vec![asset("Wave_0.1.5_amd64.deb")];

        assert!(pick_asset(&assets, ("-setup-slim.exe", "-setup.exe")).is_none());
    }
}
