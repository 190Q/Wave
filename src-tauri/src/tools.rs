//! The external programs a download needs. Neither is a Rust library, so both
//! are looked for on PATH unless the config `.env` points at one.

use std::path::PathBuf;

use crate::source::Env;

/// Looks for an executable on PATH, which is where an installer puts it.
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

pub(crate) fn tool_path(override_path: Option<&String>, name: &str) -> Option<PathBuf> {
    if let Some(explicit) = override_path {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            return path.is_file().then_some(path);
        }
    }
    find_tool(name)
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
pub fn find_yt_dlp(override_path: Option<&String>) -> Option<YtDlp> {
    if let Some(explicit) = override_path {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            return path.is_file().then_some(YtDlp::Exe(path));
        }
    }

    if let Some(path) = find_tool("yt-dlp") {
        return Some(YtDlp::Exe(path));
    }

    python_with_module("yt_dlp").map(YtDlp::Python)
}

/// The first interpreter on PATH that can import `module`.
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
    pub yt_dlp: bool,
    /// How yt-dlp was found, so the user is not left guessing where it is.
    pub yt_dlp_source: String,
    pub ffmpeg: bool,
}

impl ToolsStatus {
    /// What to tell the user about the tools, or `None` when both are there.
    pub fn problem(&self) -> Option<String> {
        if !self.yt_dlp {
            return Some("yt-dlp was not found. Install it, or set YTDLP_PATH.".to_string());
        }
        if !self.ffmpeg {
            return Some("ffmpeg was not found. Install it, or set FFMPEG_PATH.".to_string());
        }
        None
    }
}

/// Looks for both programs, and describes how yt-dlp was found.
pub fn status(env: &Env) -> ToolsStatus {
    let yt_dlp = find_yt_dlp(env.yt_dlp.as_ref());
    ToolsStatus {
        yt_dlp: yt_dlp.is_some(),
        yt_dlp_source: yt_dlp.map(|found| found.describe()).unwrap_or_default(),
        ffmpeg: tool_path(env.ffmpeg.as_ref(), "ffmpeg").is_some(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_which_tool_is_missing() {
        let missing_both = ToolsStatus::default();
        assert!(missing_both.problem().unwrap().contains("yt-dlp"));

        let no_ffmpeg = ToolsStatus {
            yt_dlp: true,
            yt_dlp_source: "yt-dlp.exe".to_string(),
            ffmpeg: false,
        };
        assert!(no_ffmpeg.problem().unwrap().contains("ffmpeg"));

        let ready = ToolsStatus {
            yt_dlp: true,
            yt_dlp_source: "yt-dlp.exe".to_string(),
            ffmpeg: true,
        };
        assert!(ready.problem().is_none());
    }
}
