use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::catalog::Catalog;
use crate::download;
use crate::import::{self, ImportOutcome};
use crate::library;
use crate::playlists;
use crate::progress::Reporter;
use crate::source::{read_env, TrackMeta};
use crate::state::{PersistedState, Store};

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
    let tracks = link.tracks;

    let staging = staging_dir(app, source, &link.id)?;

    let existing = library_index(app);
    let mut ids: Vec<Option<String>> = vec![None; tracks.len()];
    let mut jobs: Vec<download::Job> = Vec::new();
    let mut reused: Vec<String> = Vec::new();

    for (index, meta) in tracks.iter().enumerate() {
        let label = track_label(meta);
        let known = if download_duplicates {
            None
        } else {
            held(&existing, meta)
        };

        match known {
            Some(id) => {
                ids[index] = Some(id.clone());
                reused.push(label);
            }
            None => jobs.push(download::Job {
                key: index,
                meta,
                dir: staging.join(index.to_string()),
                cover: None,
            }),
        }
    }

    report.phase("downloading", &download_message(jobs.len(), reused.len()));
    report.count(jobs.len());
    for label in &reused {
        report.reuse(label);
    }

    let mut songs = 0usize;
    let mut images = 0usize;
    let mut lyrics = 0usize;
    let mut similar = 0usize;
    let mut duplicates = reused.len();
    let mut handled = 0usize;

    download::fetch_all(&tools, &jobs, |fetched| {
        let label = track_label(&tracks[fetched.key]);
        handled += 1;

        match fetched.file.and_then(|file| import::land(app, &file)) {
            Ok(song) => {
                let done = import::complete(app, &song.id);

                songs += usize::from(!song.duplicate);
                duplicates += usize::from(song.duplicate);
                images += usize::from(song.cover || done.cover);
                lyrics += usize::from(song.lyrics || done.lyrics);
                similar += usize::from(song.similar);
                ids[fetched.key] = Some(song.id);
            }
            Err(error) => report.fail(format!("{label}: {error}")),
        }

        report.at(handled, &label);
    });

    let chosen: Vec<String> = ids.into_iter().flatten().collect();
    let playlist = if link.kind == Kind::Collection && !chosen.is_empty() {
        Some(playlists::write(app, &link.name, &chosen)?)
    } else {
        None
    };

    let outcome = ImportOutcome {
        songs,
        images,
        lyrics,
        skipped: 0,
        duplicates,
        similar,
        playlist,
        // The download failures belong in the same list as the import ones.
        errors: report.failures().to_vec(),
        state: PersistedState::default(),
    };

    let history = if link.kind == Kind::Collection {
        link.name.clone()
    } else {
        track_label(&tracks[0])
    };
    import::remember_import(app, source, &history, &outcome);

    let mut outcome = outcome;
    outcome.state = playlists::refresh(app, &app.state::<Store>());
    Ok(outcome)
}

fn download_message(todo: usize, duplicates: usize) -> String {
    if duplicates == 0 {
        return format!("Downloading {todo} tracks.");
    }
    format!("Downloading {todo} tracks. {duplicates} already in your library.")
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
    fn labels_a_track_the_way_the_history_shows_it() {
        let meta = TrackMeta {
            title: "Hey Jude".to_string(),
            artists: vec!["The Beatles".to_string(), "Someone".to_string()],
            ..TrackMeta::default()
        };
        assert_eq!(track_label(&meta), "The Beatles, Someone - Hey Jude");
    }
}
