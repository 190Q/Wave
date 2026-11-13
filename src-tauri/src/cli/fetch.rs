//! The passes that fill in what the library is missing: lyrics, covers, genres
//! and the loudness readings the level volume plays from.

use tauri::AppHandle;

use crate::library;
use crate::progress::Output;

use super::{count, songs};

/// What a pass looks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum What {
    Lyrics,
    Covers,
    Genres,
    Level,
}

/// What a pass was asked for: which one, and what to run it over.
pub struct Options {
    pub what: What,
    /// The songs to work on, matched the way `search` matches. Nothing means
    /// every song in the library.
    pub text: Option<String>,
}

pub fn run(app: &AppHandle, options: &Options) -> Result<(), String> {
    let ids = ids(app, options)?;

    match options.what {
        What::Lyrics => failed(crate::lyrics_fetch::run(app, &ids, Output::Console)?.errors.len()),
        What::Covers => failed(crate::cover_fetch::run(app, &ids, Output::Console)?.errors.len()),
        What::Genres => failed(crate::genre_fetch::run(app, &ids, Output::Console)?.errors.len()),
        What::Level => {
            let outcome = crate::loudness::analyse(app, &ids);

            println!("Measured {}.", count(outcome.measured, "song"));
            if outcome.skipped > 0 {
                println!("{} were measured already.", count(outcome.skipped, "song"));
            }
            for failure in &outcome.failures {
                eprintln!("failed: {failure}");
            }

            failed(outcome.failures.len())
        }
    }
}

/// The songs a pass works on.
fn ids(app: &AppHandle, options: &Options) -> Result<Vec<String>, String> {
    let tracks = songs::all(app)?;
    let wanted: Vec<&library::Track> = match &options.text {
        Some(text) => songs::matching(&tracks, text),
        None => tracks.iter().collect(),
    };

    if wanted.is_empty() {
        return Err(match &options.text {
            Some(text) => format!("nothing in the library answers to {text}"),
            None => "the library is empty, so there is nothing to look for".to_string(),
        });
    }

    Ok(wanted.into_iter().map(|track| track.id.clone()).collect())
}

/// A pass that went cleanly has nothing to say; the exit code carries the rest.
fn failed(total: usize) -> Result<(), String> {
    if total == 0 {
        return Ok(());
    }
    Err(format!("{} failed", count(total, "song")))
}
