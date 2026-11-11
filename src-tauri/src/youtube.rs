use serde::Serialize;
use tauri::AppHandle;

use crate::download;
use crate::import::ImportOutcome;
use crate::import_source::{self, ImportPlan, Kind, Link, Service};
use crate::progress::{Output, Reporter};
use crate::source::{env_path, ensure_env_file, read_env, TrackMeta};
use crate::tools;

/// How many songs one pasted link may bring in.
const LIMIT: usize = 500;

/// What a pasted link needs: the download tools, and nothing else.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeStatus {
    pub env_path: String,
    pub yt_dlp: bool,
    pub yt_dlp_source: String,
    pub ffmpeg: bool,
    pub deno: bool,
    pub deno_source: String,
    pub message: String,
}

/// Reads a link the user pasted and turns it into the songs it points at. The
/// audio comes from the very upload they linked, so nothing is guessed at.
pub(crate) fn resolve(app: &AppHandle, url: &str, report: &mut Reporter) -> Result<Link, String> {
    let bundled = tools::bundled_dir(app);
    let tools = download::resolve_tools(&read_env(app), bundled.as_deref())?;

    report.phase("resolving", "Reading the link.");
    let (name, entries) = download::read_link(&tools, url, LIMIT)?;

    let tracks: Vec<TrackMeta> = entries
        .into_iter()
        .map(|entry| TrackMeta {
            title: entry.title,
            artists: entry.artists,
            album: entry.album,
            duration_ms: entry.duration_ms,
            source_url: Some(entry.url),
            ..TrackMeta::default()
        })
        .collect();

    Ok(Link {
        kind: if tracks.len() == 1 {
            Kind::Single
        } else {
            Kind::Collection
        },
        id: folder_name(url),
        name,
        tracks,
    })
}

/// A folder name for the link, so each one stages on its own.
fn folder_name(url: &str) -> String {
    let name: String = url
        .rsplit(['/', '='])
        .next()
        .unwrap_or_default()
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
        })
        .take(64)
        .collect();

    if name.is_empty() {
        "link".to_string()
    } else {
        name
    }
}

#[tauri::command]
pub async fn youtube_import(
    app: AppHandle,
    url: String,
    download_duplicates: bool,
) -> Result<ImportOutcome, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_source::run_link(
            &handle,
            Service::Youtube,
            &url,
            download_duplicates,
            Output::Events,
        )
    })
    .await
    .map_err(|e| format!("the import stopped unexpectedly: {e}"))?
}

#[tauri::command]
pub async fn youtube_plan(app: AppHandle, url: String) -> Result<ImportPlan, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_source::plan_link(&handle, Service::Youtube, &url, Output::Events)
    })
    .await
    .map_err(|e| format!("could not read the link: {e}"))?
}

#[tauri::command]
pub async fn youtube_status(app: AppHandle) -> Result<YoutubeStatus, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_env_file(&handle)?;
        let bundled = tools::bundled_dir(&handle);
        let found = tools::status(&read_env(&handle), bundled.as_deref());
        let message = found.problem().unwrap_or_else(|| {
            "A pasted link is downloaded exactly as it is, so nothing is guessed at.".to_string()
        });

        Ok(YoutubeStatus {
            env_path: env_path(&handle)
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default(),
            yt_dlp: found.yt_dlp,
            yt_dlp_source: found.yt_dlp_source,
            ffmpeg: found.ffmpeg,
            deno: found.deno,
            deno_source: found.deno_source,
            message,
        })
    })
    .await
    .map_err(|e| format!("the check stopped unexpectedly: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_staging_folder_after_the_link() {
        assert_eq!(folder_name("https://youtu.be/kPa7bsKwL-c"), "kPa7bsKwL-c");
        assert_eq!(folder_name("https://www.youtube.com/watch?v=abc123"), "abc123");
        assert_eq!(
            folder_name("https://www.youtube.com/playlist?list=PL123"),
            "PL123"
        );
        // A link with nothing to name it after still gets a folder.
        assert_eq!(folder_name("https://www.youtube.com/"), "link");
    }
}
