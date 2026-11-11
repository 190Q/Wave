//! The import command: a link, a folder, or a Wave playlist.

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::import::import_into_library;
use crate::import_source::{self, Service};
use crate::progress::{Output, Reporter};

use super::{report_import, Import};

pub fn run(app: &AppHandle, options: &Import) -> Result<(), String> {
    let target = options.target.trim();
    let path = PathBuf::from(target);

    if path.is_dir() {
        return folder(app, &path, options);
    }
    if path.is_file() {
        return file(app, &path);
    }
    if looks_like_a_link(target) || options.from.is_some() {
        return link(app, target, options);
    }

    Err(format!(
        "there is no file or folder at {target}. To read it as a link, give a URL, or say which \
         service it belongs to with --from."
    ))
}

/// Whether the word is a link rather than a path.
fn looks_like_a_link(value: &str) -> bool {
    value.contains("://") || value.starts_with("spotify:") || value.starts_with("deezer:")
}

/// A folder on this machine, copied into the library.
fn folder(app: &AppHandle, path: &Path, options: &Import) -> Result<(), String> {
    if options.plan {
        return Err("--plan reads a link; a folder is imported as it stands".to_string());
    }
    if options.duplicates {
        return Err(
            "--duplicates is for a link; a folder import always skips the songs the library \
             already holds"
                .to_string(),
        );
    }

    let outcome = import_into_library(
        app,
        path,
        !options.no_playlist,
        options.playlist.as_deref(),
    )?;

    report_import(&outcome)
}

/// A file: the one kind Wave imports by itself is a Wave playlist.
fn file(app: &AppHandle, path: &Path) -> Result<(), String> {
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("wavelist"))
    {
        return Err(format!(
            "{} is not a .wavelist file, and not a folder",
            path.display()
        ));
    }

    let mut report = Reporter::new(app, crate::transfer::PROGRESS_EVENT, Output::Console);
    let outcome = crate::transfer::run(app, path, &mut report);

    match &outcome {
        Ok(_) => report.phase("done", "Finished."),
        Err(error) => report.phase("failed", error),
    }

    report_import(&outcome?)
}

/// A link from Spotify, Deezer or YouTube.
fn link(app: &AppHandle, url: &str, options: &Import) -> Result<(), String> {
    if options.playlist.is_some() || options.no_playlist {
        return Err(
            "--playlist and --no-playlist are for a folder; a link's playlist is named after \
             what the link points at"
                .to_string(),
        );
    }

    let service = match options.from.as_deref() {
        Some(name) => Service::parse(name)?,
        None => Service::of(url),
    };

    if options.plan {
        let plan = import_source::plan_link(app, service, url, Output::Console)?;
        println!();
        println!(
            "{} holds {}.",
            plan.name,
            super::count(plan.total, "song")
        );
        if plan.duplicates > 0 {
            println!(
                "{} of them {} already in your library.",
                plan.duplicates,
                if plan.duplicates == 1 { "is" } else { "are" }
            );
            for example in &plan.examples {
                println!("  {example}");
            }
            println!("They are skipped unless --duplicates is given.");
        }
        return Ok(());
    }

    let outcome = import_source::run_link(app, service, url, options.duplicates, Output::Console)?;
    report_import(&outcome)
}
