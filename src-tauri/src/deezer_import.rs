use tauri::AppHandle;

use crate::deezer::{self, DeezerStatus, RefKind};
use crate::import::ImportOutcome;
use crate::import_source::{self, ImportPlan, Kind, Link};
use crate::progress::Reporter;

/// Reads the link and asks Deezer what it holds.
fn resolve(url: &str, report: &mut Reporter, enrich: bool) -> Result<Link, String> {
    let reference = deezer::resolve_ref(url)?;

    report.phase("resolving", "Reading the link from Deezer.");
    let (name, tracks) = match reference.kind {
        RefKind::Playlist => {
            let (name, mut entries) = deezer::playlist(&reference.id)?;

            if enrich && !entries.is_empty() {
                let enriched = deezer::fill_from_albums(&mut entries);
                if enriched.missed > 0 {
                    report.fail(format!(
                        "{} of {} albums would not answer, so those songs keep what the \
                         playlist listing had.",
                        enriched.missed,
                        enriched.albums + enriched.missed
                    ));
                }
            }

            (name, entries.into_iter().map(|entry| entry.meta).collect())
        }
        RefKind::Album => deezer::album(&reference.id)?,
        RefKind::Track => {
            let track = deezer::track(&reference.id)?;
            (import_source::track_label(&track), vec![track])
        }
    };

    if tracks.is_empty() {
        return Err("that Deezer link has no tracks in it".to_string());
    }

    Ok(Link {
        kind: match reference.kind {
            RefKind::Track => Kind::Single,
            RefKind::Playlist | RefKind::Album => Kind::Collection,
        },
        id: reference.id,
        name,
        tracks,
    })
}

/// Downloads a Deezer playlist, album or track into the library.
#[tauri::command]
pub async fn deezer_import(
    app: AppHandle,
    url: String,
    download_duplicates: bool,
) -> Result<ImportOutcome, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_source::run(&handle, "deezer", download_duplicates, |report| {
            resolve(&url, report, true)
        })
    })
    .await
    .map_err(|e| format!("the import stopped unexpectedly: {e}"))?
}

#[tauri::command]
pub async fn deezer_plan(app: AppHandle, url: String) -> Result<ImportPlan, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_source::plan(&handle, |report| resolve(&url, report, false))
    })
    .await
    .map_err(|e| format!("could not read the link: {e}"))?
}

#[tauri::command]
pub async fn deezer_status(app: AppHandle) -> Result<DeezerStatus, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // The tool overrides live in the shared `.env`, so make sure it is there.
        crate::source::ensure_env_file(&handle)?;
        Ok(deezer::status(&handle))
    })
    .await
    .map_err(|e| format!("the Deezer check stopped unexpectedly: {e}"))?
}
