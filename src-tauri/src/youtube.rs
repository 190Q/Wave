use serde::Serialize;
use tauri::AppHandle;

use crate::download;
use crate::import::ImportOutcome;
#[cfg(desktop)]
use crate::import_source::Service;
#[cfg(not(target_os = "android"))]
use crate::import_source;
use crate::import_source::{ImportPlan, Kind, Link};
#[cfg(desktop)]
use crate::progress::Output;
use crate::progress::Reporter;
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
pub(crate) fn folder_name(url: &str) -> String {
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

pub(crate) fn youtube_url(url: &str) -> Result<String, String> {
    let invalid = || "Paste a YouTube video or playlist link.".to_string();
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| invalid())?;
    if parsed.scheme() != "https" || parsed.port().is_some() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(invalid());
    }
    let host = parsed.host_str().ok_or_else(invalid)?;
    if !matches!(host, "youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com" | "youtu.be") {
        return Err(invalid());
    }

    let id = if host == "youtu.be" {
        let mut segments = parsed.path_segments().ok_or_else(invalid)?.filter(|segment| !segment.is_empty());
        let id = segments.next().map(str::to_owned);
        if segments.next().is_some() { return Err(invalid()); }
        id
    } else if parsed.path() == "/watch" {
        parsed.query_pairs().find(|(key, _)| key == "v").map(|(_, value)| value.into_owned())
    } else if matches!(parsed.path(), "/playlist" | "/playlist/") {
        None
    } else {
        let mut segments = parsed.path_segments().ok_or_else(invalid)?.filter(|segment| !segment.is_empty());
        match segments.next() {
            Some("shorts" | "embed" | "v") => {
                let id = segments.next().map(str::to_owned);
                if segments.next().is_some() { return Err(invalid()); }
                id
            }
            _ => return Err(invalid()),
        }
    };
    let valid_id = |id: &str| id.len() == 11
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    if (host == "youtu.be" || !matches!(parsed.path(), "/watch" | "/playlist" | "/playlist/"))
        && !id.as_deref().is_some_and(valid_id)
    {
        return Err(invalid());
    }
    if let Some((_, list)) = parsed.query_pairs().find(|(key, _)| key == "list") {
        if list.is_empty() || list.len() > 128
            || !list.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Err(invalid());
        }
        return Ok(format!("https://www.youtube.com/playlist?list={list}"));
    }
    let id = id.filter(|id| valid_id(id)).ok_or_else(invalid)?;
    Ok(format!("https://www.youtube.com/watch?v={id}"))
}

#[tauri::command]
pub async fn youtube_import(
    app: AppHandle,
    url: String,
    download_duplicates: bool,
) -> Result<ImportOutcome, String> {
    #[cfg(target_os = "android")]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            crate::youtube_phone::run(&app, &url, download_duplicates)
        })
        .await
        .map_err(|e| format!("the import stopped unexpectedly: {e}"))?;
    }

    #[cfg(all(not(desktop), not(target_os = "android")))]
    {
        let _ = (app, url, download_duplicates);
        return Err(import_source::NOT_ON_ANDROID.to_string());
    }

    #[cfg(desktop)]
    {
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
}

#[tauri::command]
pub async fn youtube_plan(app: AppHandle, url: String) -> Result<ImportPlan, String> {
    #[cfg(target_os = "android")]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            crate::youtube_phone::plan(&app, &url)
        })
        .await
        .map_err(|e| format!("could not read the link: {e}"))?;
    }

    #[cfg(all(not(desktop), not(target_os = "android")))]
    {
        let _ = (app, url);
        return Err(import_source::NOT_ON_ANDROID.to_string());
    }

    #[cfg(desktop)]
    {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            import_source::plan_link(&handle, Service::Youtube, &url, Output::Events)
        })
        .await
        .map_err(|e| format!("could not read the link: {e}"))?
    }
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
    fn accepts_only_youtube_videos_and_playlists() {
        let video = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
        assert_eq!(youtube_url(" https://youtu.be/dQw4w9WgXcQ?t=1 ").unwrap(), video);
        assert_eq!(youtube_url("https://music.youtube.com/watch?v=dQw4w9WgXcQ").unwrap(), video);
        assert_eq!(youtube_url("https://m.youtube.com/shorts/dQw4w9WgXcQ").unwrap(), video);
        assert_eq!(
            youtube_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL_123").unwrap(),
            "https://www.youtube.com/playlist?list=PL_123"
        );
        for bad in [
            "https://open.spotify.com/track/123",
            "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
            "https://youtube.com@evil.example/watch?v=dQw4w9WgXcQ",
            "http://youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/@channel",
            "https://youtube.com/@channel?list=PL123",
            "https://youtube.com/watch?v=bad",
            "https://youtube.com:444/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/watch?v=dQw4w9WgXcQ&list=",
            "https://youtu.be/bad?list=PL123",
            "https://youtu.be/dQw4w9WgXcQ/extra",
            "https://youtube.com/shorts/bad?list=PL123",
            "https://youtube.com/shorts?list=PL123",
            "https://youtube.com/playlist",
        ] {
            assert!(youtube_url(bad).is_err(), "{bad}");
        }
    }

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
