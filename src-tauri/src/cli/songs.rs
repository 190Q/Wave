//! The commands that work on the songs themselves: reading them, searching
//! them, scanning them, liking them and deleting them.

use std::collections::HashSet;

use tauri::{AppHandle, Manager};

use crate::catalog::Catalog;
use crate::library::{self, Track};
use crate::search::{all, matching};
use crate::state::Store;

use super::{count, Find, Pick};

pub fn list(app: &AppHandle, options: &Find) -> Result<(), String> {
    let tracks = all(app)?;
    let found: Vec<&Track> = tracks.iter().collect();
    show(&found, options)
}

pub fn search(app: &AppHandle, options: &Find) -> Result<(), String> {
    let tracks = all(app)?;
    let found = matching(&tracks, &options.text);
    if found.is_empty() {
        return Err(format!("nothing in the library answers to {}", options.text));
    }

    show(&found, options)
}

/// The songs a command that acts on them should act on. More than one match is
/// refused unless the command was told to take them all, so a word that turns
/// out to be common cannot change more than was meant.
pub fn pick<'a>(tracks: &'a [Track], options: &Pick) -> Result<Vec<&'a Track>, String> {
    let found = matching(tracks, &options.text);
    if found.is_empty() {
        return Err(format!("nothing in the library answers to {}", options.text));
    }
    if found.len() == 1 || options.all {
        return Ok(found);
    }

    let mut message = format!("{} songs answer to {}:\n", found.len(), options.text);
    for track in found.iter().take(SHOWN) {
        message.push_str(&format!("  {}\n", library::track_label(track)));
    }
    if found.len() > SHOWN {
        message.push_str(&format!("  and {} more\n", found.len() - SHOWN));
    }
    message.push_str("Name one of them, or add --all.");

    Err(message)
}

/// How many of an ambiguous match are listed before the rest are counted.
const SHOWN: usize = 10;

/// Prints the songs, or writes them out for a script.
fn show(tracks: &[&Track], options: &Find) -> Result<(), String> {
    let limit = options.limit.unwrap_or(usize::MAX);
    let shown: Vec<&&Track> = tracks.iter().take(limit).collect();

    if options.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&shown).map_err(|e| e.to_string())?
        );
        return Ok(());
    }

    if shown.is_empty() {
        println!("The library is empty.");
        return Ok(());
    }

    for track in &shown {
        println!("{}", library::track_label(track));
    }
    if shown.len() < tracks.len() {
        println!();
        println!(
            "{} of {} songs. Raise --limit to see the rest.",
            shown.len(),
            tracks.len()
        );
    }

    Ok(())
}

/// Brings the catalog in line with what is on disk.
pub fn scan(app: &AppHandle) -> Result<(), String> {
    let catalog = app.state::<Catalog>();
    let store = app.state::<Store>();

    let summary = library::scan(app, &catalog, false);
    let _ = crate::playlists::refresh(app, &store);

    for error in &summary.errors {
        eprintln!("failed: {error}");
    }
    println!("{} at {}", count(summary.total, "song"), summary.root);
    if summary.skipped > 0 {
        println!("{} files that are not music were left alone.", summary.skipped);
    }

    Ok(())
}

/// Where the library is, and what it holds.
pub fn info(app: &AppHandle, json: bool) -> Result<(), String> {
    let root = library::library_root(app)?;
    let catalog = app.state::<Catalog>();
    let (tracks, missing) = catalog.counts();
    let database = catalog.file_size();
    let state = path_of(crate::state::state_file(app));
    let config = path_of(crate::source::env_path(app));
    let log = crate::download_log::import_log_path(app.clone()).unwrap_or_default();

    if json {
        let info = serde_json::json!({
            "library": root.to_string_lossy(),
            "songs": tracks,
            "missing": missing,
            "databaseBytes": database,
            "state": state,
            "config": config,
            "log": log,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&info).map_err(|e| e.to_string())?
        );
        return Ok(());
    }

    println!("library  {}", root.display());
    println!(
        "songs    {tracks}{}",
        if missing > 0 {
            format!(", {missing} missing")
        } else {
            String::new()
        }
    );
    println!("database {}", size(database));
    println!("state    {state}");
    println!("config   {config}");
    println!("log      {log}");

    Ok(())
}

/// Puts the songs a search finds into Liked Songs, or takes them out again.
pub fn set_liked(app: &AppHandle, options: &Pick, liked: bool) -> Result<(), String> {
    let binding = all(app)?;
    let tracks = pick(&binding, options)?;
    let store = app.state::<Store>();
    let ids: HashSet<String> = tracks.iter().map(|track| track.id.clone()).collect();

    let next = store.update(|state| {
        let mut held: HashSet<String> = state.likes.iter().cloned().collect();
        if liked {
            for id in &ids {
                if held.insert(id.clone()) {
                    state.likes.push(id.clone());
                }
            }
        } else {
            for id in &ids {
                held.remove(id);
            }
            state.likes.retain(|id| held.contains(id));
        }
    });
    crate::state::save(app, &next)?;

    println!(
        "{} {}.",
        if liked { "Liked" } else { "Unliked" },
        count(tracks.len(), "song")
    );
    Ok(())
}

/// Deletes the songs a search finds, with their files.
pub fn delete(app: &AppHandle, options: &Pick) -> Result<(), String> {
    let binding = all(app)?;
    let tracks = pick(&binding, options)?;
    let ids: Vec<String> = tracks.iter().map(|track| track.id.clone()).collect();

    let catalog = app.state::<Catalog>();
    let store = app.state::<Store>();
    library::delete(app, &catalog, &store, &ids)?;

    println!("Deleted {}.", count(ids.len(), "song"));
    Ok(())
}

/// A path as a readout shows it, empty when it cannot be placed.
fn path_of(path: Result<std::path::PathBuf, String>) -> String {
    path.map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// A size a person can read at a glance.
fn size(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    const KB: f64 = 1024.0;

    let bytes = bytes as f64;
    if bytes >= MB {
        format!("{:.1} MB", bytes / MB)
    } else if bytes >= KB {
        format!("{:.0} KB", bytes / KB)
    } else {
        format!("{bytes:.0} bytes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str, title: &str, artist: &str, album: &str) -> Track {
        Track {
            id: id.to_string(),
            path: String::new(),
            relative_path: String::new(),
            title: title.to_string(),
            artist: Some(artist.to_string()),
            album: Some(album.to_string()),
            album_artist: None,
            track_no: None,
            disc_no: None,
            year: None,
            genre: None,
            duration_ms: 0,
            codec: String::new(),
            bitrate: None,
            sample_rate: None,
            artwork_path: None,
            lyrics_path: None,
            has_embedded_art: false,
            lufs: None,
            peak: None,
            added_at: 0,
        }
    }

    fn library() -> Vec<Track> {
        vec![
            track("a", "Duality", "Slipknot", "Vol. 3"),
            track("b", "Eyeless", "Slipknot", "Slipknot"),
            track("c", "Hey Jude", "The Beatles", "Past Masters"),
            track("d", "Freak on a Leash", "KoЯn", "Follow the Leader"),
        ]
    }

    fn found(query: &str) -> Vec<String> {
        matching(&library(), query)
            .into_iter()
            .map(|track| track.id.clone())
            .collect()
    }

    #[test]
    fn a_song_is_found_by_its_title_its_artist_or_its_album() {
        assert_eq!(found("duality"), vec!["a"]);
        assert_eq!(found("slipknot"), vec!["a", "b"]);
        assert_eq!(found("past masters"), vec!["c"]);
        // The title and the artist can be searched for together.
        assert_eq!(found("eyeless slipknot"), vec!["b"]);
    }

    #[test]
    fn case_accents_and_stray_spacing_do_not_matter() {
        assert_eq!(found("  HEY   jude "), vec!["c"]);
        // The tags spell Korn with a Cyrillic Я, and the search need not.
        assert_eq!(found("korn"), vec!["d"]);
        assert_eq!(found("KoЯn"), vec!["d"]);
    }

    #[test]
    fn a_song_id_is_the_song() {
        assert_eq!(found("b"), vec!["b"]);
        assert_eq!(found("nothing at all"), Vec::<String>::new());
        // An empty search is not every song.
        assert_eq!(found("   "), Vec::<String>::new());
    }

    #[test]
    fn an_ambiguous_search_is_refused_unless_all_is_asked_for() {
        let tracks = library();
        let one = Pick {
            text: "slipknot".to_string(),
            all: false,
        };
        let error = pick(&tracks, &one).unwrap_err();
        assert!(error.contains("2 songs answer to slipknot"), "{error}");
        assert!(error.contains("Duality"), "{error}");
        assert!(error.contains("--all"), "{error}");

        let every = Pick {
            text: "slipknot".to_string(),
            all: true,
        };
        assert_eq!(pick(&tracks, &every).unwrap().len(), 2);

        // One match needs no such permission.
        let narrow = Pick {
            text: "duality".to_string(),
            all: false,
        };
        assert_eq!(pick(&tracks, &narrow).unwrap().len(), 1);
    }

    #[test]
    fn a_search_that_finds_nothing_says_so() {
        let tracks = library();
        let nothing = Pick {
            text: "nirvana".to_string(),
            all: true,
        };
        assert!(pick(&tracks, &nothing).unwrap_err().contains("nothing in the library answers to"));
    }

    #[test]
    fn a_size_is_said_in_the_unit_that_fits() {
        assert_eq!(size(0), "0 bytes");
        assert_eq!(size(1024), "1 KB");
        assert_eq!(size(1024 * 1024 * 3 / 2), "1.5 MB");
    }
}
