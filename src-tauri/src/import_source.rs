use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::catalog::Catalog;
use crate::download;
use crate::genre_fetch;
use crate::import::{self, ImportOutcome};
use crate::library;
use crate::playlists;
use crate::progress::Reporter;
use crate::source::{read_env, TrackMeta};
use crate::state::Store;

/// Follows one import, track by track.
pub const PROGRESS_EVENT: &str = "source-import";

/// What a link points at, as far as the runner is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A collection of songs, which becomes a Wave playlist.
    Collection,
    /// One song on its own.
    Single,
}

/// What a link resolved to, before the library is consulted.
#[derive(Debug, Clone)]
pub struct Link {
    pub kind: Kind,
    /// The source's own id for it, so each link keeps its own staging folder.
    pub id: String,
    pub name: String,
    pub tracks: Vec<TrackMeta>,
}

pub fn run(
    app: &AppHandle,
    source: &str,
    download_duplicates: bool,
    resolve: impl FnOnce(&mut Reporter) -> Result<Link, String>,
) -> Result<ImportOutcome, String> {
    let mut report = Reporter::new(app, PROGRESS_EVENT);
    let outcome = run_inner(app, source, &mut report, download_duplicates, resolve);

    match &outcome {
        Ok(_) => report.phase("done", "Finished."),
        Err(error) => report.phase("failed", error),
    }

    outcome
}

fn run_inner(
    app: &AppHandle,
    source: &str,
    report: &mut Reporter,
    download_duplicates: bool,
    resolve: impl FnOnce(&mut Reporter) -> Result<Link, String>,
) -> Result<ImportOutcome, String> {
    let tools = download::resolve_tools(&read_env(app))?;
    let link = resolve(report)?;
    let mut tracks = link.tracks;

    // The ones the library already has, unless the user asked for them again.
    let existing = library_index(app);
    let duplicates = tracks
        .iter()
        .filter(|meta| existing.contains_key(&meta_key(meta)))
        .count();
    let todo = if download_duplicates {
        tracks.len()
    } else {
        tracks.len() - duplicates
    };

    let pending = to_look_up(&mut tracks, &existing, download_duplicates);
    if !pending.is_empty() {
        report.phase("genres", &genre_message(pending.len()));
        genre_fetch::fill(Some(report), pending);
    }

    let staging = staging_dir(app, source, &link.id)?;
    report.phase("downloading", &download_message(todo, duplicates));
    report.count(todo);

    // Kept in the order the source gave.
    let mut entries: Vec<Entry> = Vec::new();
    let mut downloading = 0usize;

    for (index, meta) in tracks.iter().enumerate() {
        let label = track_label(meta);

        // A song the library already holds keeps its place without a download.
        let known = if download_duplicates {
            None
        } else {
            existing.get(&meta_key(meta))
        };
        if let Some(id) = known {
            entries.push(Entry::Known(id.clone()));
            report.reuse(&label);
            continue;
        }

        downloading += 1;
        report.at(downloading, &label);

        match download::download(&tools, meta, &staging.join(index.to_string())) {
            Ok(_) => entries.push(Entry::Fetched(staged_key(index))),
            Err(error) => report.fail(format!("{label}: {error}")),
        }
    }

    report.phase("importing", "Adding the songs to your library.");
    let imported = import::import_into_library(app, &staging, false, None)?;
    let mut outcome = imported.outcome;

    if link.kind == Kind::Collection {
        let chosen: Vec<String> = entries
            .iter()
            .filter_map(|entry| match entry {
                Entry::Known(id) => Some(id.clone()),
                Entry::Fetched(key) => imported.by_source.get(key).cloned(),
            })
            .collect();

        outcome.playlist = Some(playlists::write(app, &link.name, &chosen)?);
        let store = app.state::<Store>();
        outcome.state = playlists::refresh(app, &store);
    }

    // The download failures belong in the same list as the import ones.
    outcome.errors.extend(report.failures().to_vec());

    let history = if link.kind == Kind::Collection {
        link.name.clone()
    } else {
        track_label(&tracks[0])
    };
    import::remember_import(app, source, &history, &outcome);

    outcome.state = app.state::<Store>().snapshot();
    Ok(outcome)
}

enum Entry {
    Known(String),
    Fetched(String),
}

fn staged_key(index: usize) -> String {
    format!("{index}/{}.mp3", library::AUDIO_STEM)
}

fn download_message(todo: usize, duplicates: usize) -> String {
    if duplicates == 0 {
        return format!("Downloading {todo} tracks.");
    }
    format!("Downloading {todo} tracks. {duplicates} already in your library.")
}

fn to_look_up<'a>(
    tracks: &'a mut [TrackMeta],
    existing: &HashMap<String, String>,
    download_duplicates: bool,
) -> Vec<&'a mut TrackMeta> {
    tracks
        .iter_mut()
        .filter(|meta| download_duplicates || !existing.contains_key(&meta_key(meta)))
        .collect()
}

fn genre_message(todo: usize) -> String {
    if todo == 1 {
        return "Looking up the genre of 1 track.".to_string();
    }
    format!("Looking up the genre of {todo} tracks.")
}

/// Every library track, by the three fields a duplicate is judged on.
fn library_index(app: &AppHandle) -> HashMap<String, String> {
    let catalog = app.state::<Catalog>();
    let mut index = HashMap::new();

    for track in library::scan(app, &catalog).tracks {
        let key = track_key(
            &track.title,
            track.artist.as_deref().unwrap_or_default(),
            track.album.as_deref().unwrap_or_default(),
        );
        // The first song wins, so a rescan cannot shuffle the choice.
        index.entry(key).or_insert(track.id);
    }

    index
}

pub(crate) fn catalog_index(catalog: &Catalog) -> Result<HashMap<String, String>, String> {
    let mut index = HashMap::new();

    for row in catalog.tracks()? {
        let key = track_key(
            &row.title,
            row.artist.as_deref().unwrap_or_default(),
            row.album.as_deref().unwrap_or_default(),
        );
        index.entry(key).or_insert(row.id);
    }

    Ok(index)
}

pub(crate) fn meta_key(meta: &TrackMeta) -> String {
    track_key(&meta.title, &meta.artists.join(", "), &meta.album)
}

/// Folded so case and stray spacing do not stand in for a different song.
pub(crate) fn track_key(title: &str, artist: &str, album: &str) -> String {
    format!("{}\u{1}{}\u{1}{}", fold(title), fold(artist), fold(album))
}

fn fold(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn staging_dir(app: &AppHandle, source: &str, id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data directory: {e}"))?
        .join(source)
        .join(id);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// How a track is named in the readout and the history.
pub fn track_label(meta: &TrackMeta) -> String {
    format!("{} - {}", meta.artists.join(", "), meta.title)
}

/// What the dialog needs to ask about the duplicates before downloading.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    pub name: String,
    pub total: usize,
    pub duplicates: usize,
    /// A few of them, so the prompt can name what it found.
    pub examples: Vec<String>,
}

pub fn plan(
    app: &AppHandle,
    resolve: impl FnOnce(&mut Reporter) -> Result<Link, String>,
) -> Result<ImportPlan, String> {
    let mut report = Reporter::new(app, PROGRESS_EVENT);
    let link = resolve(&mut report)?;
    let existing = library_index(app);

    let duplicates: Vec<String> = link
        .tracks
        .iter()
        .filter(|meta| existing.contains_key(&meta_key(meta)))
        .map(track_label)
        .collect();

    Ok(ImportPlan {
        name: link.name,
        total: link.tracks.len(),
        duplicates: duplicates.len(),
        examples: duplicates.iter().take(3).cloned().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_a_track_on_title_artist_and_album() {
        let meta = TrackMeta {
            title: "Hey Jude".to_string(),
            artists: vec!["The Beatles".to_string()],
            album: "Past Masters".to_string(),
            ..TrackMeta::default()
        };

        assert_eq!(meta_key(&meta), track_key("Hey Jude", "The Beatles", "Past Masters"));
        // Case and stray spacing are not a different song.
        assert_eq!(
            meta_key(&meta),
            track_key("  hey   jude ", "THE BEATLES", "past masters")
        );
        // A different album is, though.
        assert_ne!(meta_key(&meta), track_key("Hey Jude", "The Beatles", "1"));
        // And so is a different artist.
        assert_ne!(meta_key(&meta), track_key("Hey Jude", "Someone", "Past Masters"));
    }

    #[test]
    fn says_what_it_will_do_about_the_duplicates() {
        assert_eq!(download_message(40, 0), "Downloading 40 tracks.");
        assert_eq!(
            download_message(28, 12),
            "Downloading 28 tracks. 12 already in your library."
        );
    }

    #[test]
    fn says_how_many_genres_it_will_look_up() {
        assert_eq!(genre_message(1), "Looking up the genre of 1 track.");
        assert_eq!(genre_message(12), "Looking up the genre of 12 tracks.");
    }

    #[test]
    fn looks_a_genre_up_only_for_the_songs_the_library_is_missing() {
        let mut tracks = vec![
            TrackMeta {
                title: "Hey Jude".to_string(),
                artists: vec!["The Beatles".to_string()],
                album: "Past Masters".to_string(),
                ..TrackMeta::default()
            },
            TrackMeta {
                title: "Let It Be".to_string(),
                artists: vec!["The Beatles".to_string()],
                album: "Let It Be".to_string(),
                ..TrackMeta::default()
            },
        ];

        let existing = HashMap::from([(
            track_key("Hey Jude", "The Beatles", "Past Masters"),
            "id".to_string(),
        )]);

        let pending = to_look_up(&mut tracks, &existing, false);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].title, "Let It Be");

        // Asked for again, a song the library holds is looked up like any other.
        assert_eq!(to_look_up(&mut tracks, &existing, true).len(), 2);
    }

    #[test]
    fn labels_a_track_the_way_the_history_shows_it() {
        let meta = TrackMeta {
            title: "Hey Jude".to_string(),
            artists: vec!["The Beatles".to_string(), "Someone".to_string()],
            ..TrackMeta::default()
        };
        assert_eq!(track_label(&meta), "The Beatles, Someone - Hey Jude");
    }
}
