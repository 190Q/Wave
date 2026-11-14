//! The external programs a download needs. None of them is a Rust library, so
//! each is looked for in the config `.env`, then in the copy Wave ships beside
//! it, then on PATH.
//!
//! None of the three runs on Android, so there the lookups are no-ops and the
//! status says so outright rather than reporting three programs as missing.

use std::path::{Path, PathBuf};

#[cfg(desktop)]
use tauri::Manager;
use tauri::{AppHandle, Runtime};

use crate::source::Env;

/// The folder the bundled tools are unpacked into, beside the other resources.
#[cfg(desktop)]
const BUNDLE_DIR: &str = "tools";

/// Looks for an executable on PATH, which is where an installer puts it.
#[cfg(desktop)]
pub fn find_tool(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd"), name.to_string()]
    } else {
        vec![name.to_string()]
    };

    for dir in std::env::split_paths(&path) {
        for candidate in &names {
            let full = dir.join(candidate);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

#[cfg(desktop)]
pub fn bundled_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let installed = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join(BUNDLE_DIR));

    #[cfg(debug_assertions)]
    let candidates = [
        installed,
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(BUNDLE_DIR)),
    ];
    #[cfg(not(debug_assertions))]
    let candidates = [installed];

    candidates.into_iter().flatten().find(|dir| dir.is_dir())
}

/// The name a tool has in the folder Wave ships.
#[cfg(desktop)]
fn bundled_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// A tool from the folder Wave ships, when it is there.
#[cfg(desktop)]
fn in_bundle(bundled: Option<&Path>, name: &str) -> Option<PathBuf> {
    let candidate = bundled?.join(bundled_name(name));
    candidate.is_file().then_some(candidate)
}

/// Whether a tool is one of the copies Wave shipped.
#[cfg(desktop)]
fn is_bundled(path: &Path, bundled: Option<&Path>) -> bool {
    match (path.parent(), bundled) {
        (Some(dir), Some(bundled)) => dir == bundled,
        _ => false,
    }
}

/// The file an override points at, which has to be there to count.
#[cfg(desktop)]
fn override_file(override_path: Option<&String>) -> Option<PathBuf> {
    let path = PathBuf::from(override_path?.trim());
    path.is_file().then_some(path)
}

/// The override, then the copy Wave ships, then PATH.
#[cfg(desktop)]
pub(crate) fn tool_path(
    override_path: Option<&String>,
    name: &str,
    bundled: Option<&Path>,
) -> Option<PathBuf> {
    override_file(override_path)
        .or_else(|| in_bundle(bundled, name))
        .or_else(|| find_tool(name))
}

/// How yt-dlp will be run.
#[derive(Debug, Clone)]
pub enum YtDlp {
    /// A `yt-dlp` executable.
    Exe(PathBuf),
    /// The interpreter holding the `yt_dlp` module. pip does install a launcher,
    /// but into a folder that is usually left off PATH.
    Python(PathBuf),
}

impl YtDlp {
    /// How it was found, for the status the dialog shows.
    pub fn describe(&self) -> String {
        match self {
            YtDlp::Exe(path) => path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "yt-dlp".to_string()),
            YtDlp::Python(python) => format!("{} -m yt_dlp", python.display()),
        }
    }
}

/// The executable if there is one, otherwise the Python module.
#[cfg(desktop)]
pub fn find_yt_dlp(override_path: Option<&String>, bundled: Option<&Path>) -> Option<YtDlp> {
    if let Some(path) = tool_path(override_path, "yt-dlp", bundled) {
        return Some(YtDlp::Exe(path));
    }

    python_with_module("yt_dlp").map(YtDlp::Python)
}

/// The first interpreter on PATH that can import `module`.
#[cfg(desktop)]
fn python_with_module(module: &str) -> Option<PathBuf> {
    for name in ["python", "python3", "py"] {
        let Some(python) = find_tool(name) else {
            continue;
        };

        let mut command = std::process::Command::new(&python);
        command.arg("-c").arg(format!("import {module}"));
        hide_console(&mut command);

        if command
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
        {
            return Some(python);
        }
    }
    None
}

/// Keeps a console window from flashing up for a probe or a download.
pub(crate) fn hide_console(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// What the dialog shows about the download tools, whichever source asked.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsStatus {
    /// True when the platform cannot run the tools at all, which is Android.
    /// The three flags below are then all false for that reason rather than
    /// because something is missing from the machine.
    pub unavailable: bool,
    pub yt_dlp: bool,
    /// How yt-dlp was found, so the user is not left guessing where it is.
    pub yt_dlp_source: String,
    pub ffmpeg: bool,
    pub deno: bool,
    /// How Deno was found, which is worth saying when Wave shipped it.
    pub deno_source: String,
}

impl ToolsStatus {
    /// What to tell the user about the tools, or `None` when all three are there.
    pub fn problem(&self) -> Option<String> {
        if self.unavailable {
            return Some(
                "yt-dlp, ffmpeg and Deno cannot run on Android, so link imports are not \
                 available here."
                    .to_string(),
            );
        }
        if !self.yt_dlp {
            return Some("yt-dlp was not found. Install it, or set YTDLP_PATH.".to_string());
        }
        if !self.ffmpeg {
            return Some("ffmpeg was not found. Install it, or set FFMPEG_PATH.".to_string());
        }
        if !self.deno {
            return Some(
                "Deno was not found. YouTube now needs it to solve the player's challenges, \
                 so install it, or set DENO_PATH."
                    .to_string(),
            );
        }
        None
    }
}

/// How a tool was found, for the line the dialog shows.
#[cfg(desktop)]
fn describe_tool(path: Option<&Path>, bundled: Option<&Path>) -> String {
    match path {
        Some(path) if is_bundled(path, bundled) => "bundled with Wave".to_string(),
        Some(path) => path.to_string_lossy().into_owned(),
        None => String::new(),
    }
}

/// Looks for all three programs, and says how each was found.
#[cfg(desktop)]
pub fn status(env: &Env, bundled: Option<&Path>) -> ToolsStatus {
    let yt_dlp = find_yt_dlp(env.yt_dlp.as_ref(), bundled);
    let deno = tool_path(env.deno.as_ref(), "deno", bundled);

    ToolsStatus {
        unavailable: false,
        yt_dlp: yt_dlp.is_some(),
        yt_dlp_source: yt_dlp
            .as_ref()
            .map(|found| match found {
                YtDlp::Exe(path) if is_bundled(path, bundled) => {
                    "yt-dlp (bundled with Wave)".to_string()
                }
                other => other.describe(),
            })
            .unwrap_or_default(),
        ffmpeg: tool_path(env.ffmpeg.as_ref(), "ffmpeg", bundled).is_some(),
        deno: deno.is_some(),
        deno_source: describe_tool(deno.as_deref(), bundled),
    }
}

/// None of the three runs on Android, so nothing is looked for and the status
/// says why rather than naming three programs that are not there.
#[cfg(not(desktop))]
pub fn bundled_dir<R: Runtime>(_app: &AppHandle<R>) -> Option<PathBuf> {
    None
}

#[cfg(not(desktop))]
pub(crate) fn tool_path(
    _override_path: Option<&String>,
    _name: &str,
    _bundled: Option<&Path>,
) -> Option<PathBuf> {
    None
}

#[cfg(not(desktop))]
pub fn find_yt_dlp(_override_path: Option<&String>, _bundled: Option<&Path>) -> Option<YtDlp> {
    None
}

#[cfg(not(desktop))]
pub fn status(_env: &Env, _bundled: Option<&Path>) -> ToolsStatus {
    ToolsStatus {
        unavailable: true,
        ..ToolsStatus::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An empty folder to stand in for the tools Wave ships.
    #[cfg(desktop)]
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wave-tools-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A folder holding one copy of ffmpeg.
    #[cfg(desktop)]
    fn shipped(name: &str) -> PathBuf {
        let dir = scratch(name);
        std::fs::write(dir.join(bundled_name("ffmpeg")), b"a copy Wave shipped").unwrap();
        dir
    }

    #[test]
    fn says_which_tool_is_missing() {
        assert!(ToolsStatus::default().problem().unwrap().contains("yt-dlp"));

        let no_ffmpeg = ToolsStatus {
            yt_dlp: true,
            yt_dlp_source: "yt-dlp.exe".to_string(),
            ..ToolsStatus::default()
        };
        assert!(no_ffmpeg.problem().unwrap().contains("ffmpeg"));

        let no_deno = ToolsStatus {
            yt_dlp: true,
            yt_dlp_source: "yt-dlp.exe".to_string(),
            ffmpeg: true,
            ..ToolsStatus::default()
        };
        assert!(no_deno.problem().unwrap().contains("Deno"));

        let ready = ToolsStatus {
            yt_dlp: true,
            yt_dlp_source: "yt-dlp.exe".to_string(),
            ffmpeg: true,
            deno: true,
            deno_source: "deno.exe".to_string(),
            ..ToolsStatus::default()
        };
        assert!(ready.problem().is_none());

        // Android cannot run any of the three, which is said outright rather
        // than reported as three programs that are not installed.
        let on_a_phone = ToolsStatus {
            unavailable: true,
            ..ToolsStatus::default()
        };
        assert!(
            on_a_phone
                .problem()
                .unwrap()
                .contains("cannot run on Android")
        );
    }

    #[cfg(desktop)]
    #[test]
    fn takes_the_copy_that_shipped_ahead_of_path() {
        let dir = shipped("prefers");
        let found = tool_path(None, "ffmpeg", Some(&dir)).unwrap();

        assert_eq!(found, dir.join(bundled_name("ffmpeg")));
        assert!(is_bundled(&found, Some(&dir)));
        assert!(!is_bundled(&found, Some(Path::new("/somewhere/else"))));
    }

    #[cfg(desktop)]
    #[test]
    fn an_override_that_is_not_there_is_passed_over() {
        let dir = shipped("override");
        let gone = dir.join("moved-away.exe").to_string_lossy().into_owned();

        // A path the user pointed at that has since gone falls back to the copy
        // Wave ships, rather than leaving the tools unusable.
        assert_eq!(
            tool_path(Some(&gone), "ffmpeg", Some(&dir)).unwrap(),
            dir.join(bundled_name("ffmpeg"))
        );

        let present = dir.join(bundled_name("ffmpeg")).to_string_lossy().into_owned();
        assert_eq!(
            tool_path(Some(&present), "ffmpeg", None).unwrap(),
            PathBuf::from(&present)
        );
    }

    #[cfg(desktop)]
    #[test]
    fn a_folder_that_is_not_there_holds_no_tools() {
        assert!(in_bundle(Some(Path::new("/no/such/folder")), "ffmpeg").is_none());
        assert!(in_bundle(None, "ffmpeg").is_none());
    }

    #[cfg(desktop)]
    #[test]
    fn says_when_a_tool_came_with_the_app() {
        let dir = shipped("describes");
        let found = dir.join(bundled_name("ffmpeg"));

        assert_eq!(describe_tool(Some(&found), Some(&dir)), "bundled with Wave");
        assert_eq!(
            describe_tool(Some(Path::new("/usr/bin/ffmpeg")), Some(&dir)),
            "/usr/bin/ffmpeg"
        );
        assert_eq!(describe_tool(None, Some(&dir)), "");
    }
}
