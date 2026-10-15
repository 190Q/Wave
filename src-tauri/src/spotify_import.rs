use tauri::AppHandle;

use crate::import::ImportOutcome;
use crate::import_source::{self, ImportPlan, Kind, Link};
use crate::progress::Reporter;
use crate::source::read_env;
use crate::spotify::{self, RefKind};

/// Reads the link and asks Spotify what it holds.
fn resolve(app: &AppHandle, url: &str, report: &mut Reporter) -> Result<Link, String> {
    let env = read_env(app);
    let reference = spotify::resolve_ref(url)?;

    report.phase(
        "authorising",
        "Checking your Spotify sign-in. The first one opens a browser window.",
    );
    let token = spotify::access_token(app, &env)?;

    report.phase("resolving", "Reading the playlist from Spotify.");
    let (name, tracks) = match reference.kind {
        RefKind::Playlist => spotify::playlist_tracks(&token, &reference.id)?,
        RefKind::Track => {
            let track = spotify::single_track(&token, &reference.id)?;
            (import_source::track_label(&track), vec![track])
        }
    };

    if tracks.is_empty() {
        return Err("that Spotify link has no tracks in it".to_string());
    }

    Ok(Link {
        kind: match reference.kind {
            RefKind::Playlist => Kind::Collection,
            RefKind::Track => Kind::Single,
        },
        id: reference.id,
        name,
        tracks,
    })
}

#[tauri::command]
pub async fn spotify_import(
    app: AppHandle,
    url: String,
    download_duplicates: bool,
) -> Result<ImportOutcome, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_source::run(&handle, "spotify", download_duplicates, |report| {
            resolve(&handle, &url, report)
        })
    })
    .await
    .map_err(|e| format!("the import stopped unexpectedly: {e}"))?
}

/// Reads the link and works out which of its tracks the library already has, so
/// the dialog can ask before downloading them again.
#[tauri::command]
pub async fn spotify_plan(app: AppHandle, url: String) -> Result<ImportPlan, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_source::plan(&handle, |report| resolve(&handle, &url, report))
    })
    .await
    .map_err(|e| format!("could not read the link: {e}"))?
}
