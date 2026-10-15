use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use notify::Watcher;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

use crate::library::{library_root, CONFIG_DIR};

const ENV_FILE: &str = ".env";

/// One track's metadata, in the shape every source maps its own reply into and
/// the downloader reads back out.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackMeta {
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub album_artist: String,
    pub release_date: String,
    pub track_number: Option<u32>,
    pub track_total: Option<u32>,
    pub disc_number: Option<u32>,
    pub genres: Vec<String>,
    pub isrc: String,
    pub cover_url: Option<String>,
}

/// The credentials and tool overrides read from the config `.env`. The file is
/// shared: the credentials belong to Spotify, the tool paths serve every import.
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub client_id: String,
    pub client_secret: String,
    pub yt_dlp: Option<String>,
    pub ffmpeg: Option<String>,
}

impl Env {
    pub fn complete(&self) -> bool {
        !self.client_id.trim().is_empty() && !self.client_secret.trim().is_empty()
    }
}

fn env_template() -> String {
    format!(
        "\
# Spotify credentials for the Import dialog, and the download tools every
# import uses.
#
# 1. Create an app at https://developer.spotify.com/dashboard
# 2. In that app, add this to Redirect URIs, exactly as written:
#
#      {}
#
#    Spotify refuses the sign-in if it does not match character for character.
# 3. Paste the app's Client ID and Client Secret below.
#
# Deezer needs no credentials at all: a Deezer link is read from the public
# catalogue. The two paths below are what a download needs.
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
# YTDLP_PATH=
# FFMPEG_PATH=
",
        crate::spotify::redirect_uri()
    )
}

pub fn config_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(library_root(app)?.join(CONFIG_DIR))
}

pub fn env_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join(ENV_FILE))
}

/// Writes a commented template when the file is absent, so there is something
/// to fill in rather than a path the user has to guess at.
pub fn ensure_env_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let path = env_path(app)?;
    if !path.exists() {
        fs::write(&path, env_template())
            .map_err(|e| format!("could not write {}: {e}", path.display()))?;
    }
    Ok(path)
}

/// Fired when the config `.env` is written, so the dialog can re-check it.
pub const CONFIG_EVENT: &str = "config-changed";

/// The watcher stops when it is dropped, so it is kept for the app's life.
static WATCHER: Mutex<Option<notify::RecommendedWatcher>> = Mutex::new(None);

/// Re-checks the credentials and the tools whenever the `.env` is saved.
pub fn watch_config(app: &AppHandle) {
    let Ok(dir) = config_dir(app) else {
        return;
    };
    let _ = ensure_env_file(app);

    let handle = app.clone();
    let Ok(mut watcher) = notify::recommended_watcher(
        move |result: Result<notify::Event, notify::Error>| {
            let Ok(event) = result else {
                return;
            };
            let touched = event.paths.iter().any(|path| {
                path.file_name()
                    .map(|name| name.eq_ignore_ascii_case(ENV_FILE))
                    .unwrap_or(false)
            });
            if touched {
                let _ = handle.emit(CONFIG_EVENT, ());
            }
        },
    ) else {
        return;
    };

    if watcher
        .watch(&dir, notify::RecursiveMode::NonRecursive)
        .is_err()
    {
        return;
    }

    let mut slot = WATCHER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *slot = Some(watcher);
}

pub fn read_env<R: Runtime>(app: &AppHandle<R>) -> Env {
    let Ok(path) = env_path(app) else {
        return Env::default();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return Env::default();
    };
    parse_env(&raw)
}

fn parse_env(raw: &str) -> Env {
    let mut env = Env::default();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = unquote(value.trim());
        match key.trim() {
            "SPOTIFY_CLIENT_ID" => env.client_id = value,
            "SPOTIFY_CLIENT_SECRET" => env.client_secret = value,
            "YTDLP_PATH" => env.yt_dlp = Some(value),
            "FFMPEG_PATH" => env.ffmpeg = Some(value),
            _ => {}
        }
    }
    env
}

fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    for quote in ['"', '\''] {
        if trimmed.len() >= 2 && trimmed.starts_with(quote) && trimmed.ends_with(quote) {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

/// The one HTTP client every source shares.
pub(crate) fn client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .user_agent("Wave/0.1")
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new())
    })
}

/// The seconds a service asked us to wait, from the `Retry-After` on a 429.
pub(crate) fn retry_after(response: &reqwest::blocking::Response) -> Option<u64> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse().ok())
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Percent-encodes a value, leaving only the characters a URL can carry bare.
pub(crate) fn encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// A wait said the way a person would, from a count of seconds.
pub(crate) fn wait_phrase(seconds: u64) -> String {
    let (count, unit) = match seconds {
        0..=1 => return "in a second".to_string(),
        2..=59 => return format!("in {seconds} seconds"),
        60..=3599 => (seconds.div_ceil(60), "minute"),
        3600..=86_399 => (seconds.div_ceil(3600), "hour"),
        _ => (seconds.div_ceil(86_400), "day"),
    };
    let plural = if count == 1 { "" } else { "s" };
    format!("in {count} {unit}{plural}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_env_file() {
        let env = parse_env(
            "\
# a comment
SPOTIFY_CLIENT_ID=abc
SPOTIFY_CLIENT_SECRET='shh'
YTDLP_PATH=\"C:\\tools\\yt-dlp.exe\"
not a pair
",
        );

        assert_eq!(env.client_id, "abc");
        assert_eq!(env.client_secret, "shh");
        assert_eq!(env.yt_dlp.as_deref(), Some("C:\\tools\\yt-dlp.exe"));
        assert!(env.complete());
    }

    #[test]
    fn says_a_wait_the_way_a_person_would() {
        assert_eq!(wait_phrase(0), "in a second");
        assert_eq!(wait_phrase(45), "in 45 seconds");
        assert_eq!(wait_phrase(60), "in 1 minute");
        assert_eq!(wait_phrase(119), "in 2 minutes");
        assert_eq!(wait_phrase(3600), "in 1 hour");
        assert_eq!(wait_phrase(48_000), "in 14 hours");
        assert_eq!(wait_phrase(86_400), "in 1 day");
    }

    #[test]
    fn quotes_the_redirect_uri_the_way_spotify_wants_it() {
        // The template has to carry it, or the user has nothing to paste.
        assert!(env_template().contains(&crate::spotify::redirect_uri()));
    }

    #[test]
    fn encodes_what_a_url_cannot_carry_bare() {
        assert_eq!(encode("a b/c"), "a%20b%2Fc");
        assert_eq!(encode("keep-me.~_"), "keep-me.~_");
    }
}
