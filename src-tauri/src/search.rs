//! Finding songs in the library by what they are called.
//!
//! The command line's `search`, `like` and `delete` and the local API's own
//! search all match the same way, and the API answers on every platform, so the
//! matching lives here rather than inside the command line.

use tauri::{AppHandle, Manager};

use crate::catalog::Catalog;
use crate::import_source::fold;
use crate::library::{self, Track};

/// Every song the library holds, as the catalog has it, in title order.
pub fn all(app: &AppHandle) -> Result<Vec<Track>, String> {
    let catalog = app.state::<Catalog>();
    library::all_tracks(app, &catalog)
}

/// The songs a query answers to. A track id is itself; anything else is matched
/// on title, artist and album together, folded the way the importer folds tags,
/// so case, accents and stray spacing do not matter. The songs are borrowed, so
/// a match does not copy the song.
pub fn matching<'a>(tracks: &'a [Track], query: &str) -> Vec<&'a Track> {
    let query = query.trim();

    if let Some(found) = tracks.iter().find(|track| track.id == query) {
        return vec![found];
    }

    let needle = fold(query);
    if needle.is_empty() {
        return Vec::new();
    }

    tracks
        .iter()
        .filter(|track| haystack(track).contains(&needle))
        .collect()
}

/// Everything about a song that a search can land on, folded into one string.
fn haystack(track: &Track) -> String {
    fold(&format!(
        "{} {} {}",
        track.title,
        track.artist.as_deref().unwrap_or_default(),
        track.album.as_deref().unwrap_or_default()
    ))
}
