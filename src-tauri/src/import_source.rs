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
        .filter(|meta| held(&existing, meta).is_some())
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
            held(&existing, meta)
        };
        if let Some(id) = known {
            entries.push(Entry::Known(id.clone()));
            report.reuse(&label);
            continue;
        }

        downloading += 1;
        report.at(downloading, &label);

        match download::download(&tools, meta, &staging.join(index.to_string()), None) {
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
        .filter(|meta| download_duplicates || held(existing, meta).is_none())
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
        remember(
            &mut index,
            &track.id,
            &track.title,
            track.artist.as_deref().unwrap_or_default(),
            track.album.as_deref().unwrap_or_default(),
        );
    }

    index
}

pub(crate) fn catalog_index(catalog: &Catalog) -> Result<HashMap<String, String>, String> {
    let mut index = HashMap::new();

    for row in catalog.tracks()? {
        remember(
            &mut index,
            &row.id,
            &row.title,
            row.artist.as_deref().unwrap_or_default(),
            row.album.as_deref().unwrap_or_default(),
        );
    }

    Ok(index)
}

fn remember(index: &mut HashMap<String, String>, id: &str, title: &str, artist: &str, album: &str) {
    index
        .entry(track_key(title, artist, album))
        .or_insert_with(|| id.to_string());
    index
        .entry(loose_key(title, artist))
        .or_insert_with(|| id.to_string());
}

pub(crate) fn meta_key(meta: &TrackMeta) -> String {
    track_key(&meta.title, &meta.artists.join(", "), &meta.album)
}

/// The library song this track answers to, if the library holds one.
pub(crate) fn held<'a>(index: &'a HashMap<String, String>, meta: &TrackMeta) -> Option<&'a String> {
    index
        .get(&meta_key(meta))
        .or_else(|| index.get(&loose_key(&meta.title, &meta.artists.join(", "))))
}

/// Folded so case and stray spacing do not stand in for a different song.
pub(crate) fn track_key(title: &str, artist: &str, album: &str) -> String {
    format!("{}\u{1}{}\u{1}{}", fold(title), fold(artist), fold(album))
}

pub(crate) fn loose_key(title: &str, artist: &str) -> String {
    format!("{}\u{1}{}", fold(title), fold(main_artist(artist)))
}

/// The first name in a credit, which is the one every source agrees on.
fn main_artist(artist: &str) -> &str {
    artist
        .split([',', ';'])
        .map(str::trim)
        .find(|name| !name.is_empty())
        .unwrap_or(artist)
}

pub(crate) fn fold(value: &str) -> String {
    value
        .split_whitespace()
        .map(|word| word.to_lowercase().chars().map(plain).collect::<String>())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The plain letter behind a decorative one. Tags spell Korn as "KoЯn", and put
/// accents on names that need none.
fn plain(character: char) -> char {
    match character {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'č' | 'ĉ' | 'ċ' => 'c',
        'ď' | 'đ' => 'd',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => 'g',
        'ĥ' | 'ħ' => 'h',
        'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => 'i',
        'ĵ' => 'j',
        'ķ' => 'k',
        'ĺ' | 'ļ' | 'ľ' | 'ł' | 'ŀ' => 'l',
        'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => 'o',
        'ŕ' | 'ŗ' | 'ř' => 'r',
        'ś' | 'ŝ' | 'ş' | 'š' | 'ș' => 's',
        'ţ' | 'ť' | 'ŧ' | 'ț' => 't',
        'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => 'u',
        'ŵ' => 'w',
        'ý' | 'ÿ' | 'ŷ' => 'y',
        'ź' | 'ż' | 'ž' => 'z',
        // Cyrillic and Greek letters that stand in for Latin ones.
        'а' => 'a',
        'в' => 'b',
        'с' => 'c',
        'ԁ' => 'd',
        'е' => 'e',
        'ɡ' => 'g',
        'н' => 'h',
        'і' => 'i',
        'ј' => 'j',
        'к' => 'k',
        'м' => 'm',
        'о' => 'o',
        'р' => 'p',
        'я' => 'r',
        'ѕ' => 's',
        'т' => 't',
        'υ' => 'y',
        'х' => 'x',
        other => other,
    }
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
        .filter(|meta| held(&existing, meta).is_some())
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
    fn a_song_the_library_holds_under_another_spelling_is_still_that_song() {
        let mut index = HashMap::new();
        remember(&mut index, "id", "Eyeless", "Slipknot", "Slipknot");

        // The same song, on another album edition.
        let edition = TrackMeta {
            title: "Eyeless".to_string(),
            artists: vec!["Slipknot".to_string()],
            album: "Slipknot (10th Anniversary Edition)".to_string(),
            ..TrackMeta::default()
        };
        assert_eq!(held(&index, &edition).map(String::as_str), Some("id"));

        // A credit that names one artist where the library names three.
        let mut credited = HashMap::new();
        remember(
            &mut credited,
            "j",
            "Joseph",
            "Falling In Reverse, Corey Taylor, Serj Tankian",
            "Joseph",
        );
        let listed = TrackMeta {
            title: "Joseph".to_string(),
            artists: vec!["Falling In Reverse".to_string()],
            album: "Joseph".to_string(),
            ..TrackMeta::default()
        };
        assert_eq!(held(&credited, &listed).map(String::as_str), Some("j"));

        // The spelling a source uses for the artist.
        let mut spelled = HashMap::new();
        remember(&mut spelled, "k", "Freak On a Leash", "Korn", "Follow The Leader");
        let decorated = TrackMeta {
            title: "Freak On a Leash".to_string(),
            artists: vec!["KoЯn".to_string()],
            album: "Follow The Leader".to_string(),
            ..TrackMeta::default()
        };
        assert_eq!(held(&spelled, &decorated).map(String::as_str), Some("k"));

        // Another song with the same title is another song.
        let mut hostage = HashMap::new();
        remember(&mut hostage, "h", "Hostage", "Chelsea Grin", "Eternal Nightmare");
        let other = TrackMeta {
            title: "Hostage".to_string(),
            artists: vec!["Jane & The Boy".to_string()],
            album: "Turn It Up".to_string(),
            ..TrackMeta::default()
        };
        assert!(held(&hostage, &other).is_none());
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
