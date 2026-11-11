//! The playlist commands: reading them, downloading what they are waiting on,
//! and writing one out as a Wave playlist.

use std::collections::HashMap;
use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::catalog::{Catalog, TrackRow};
use crate::import_source::fold;
use crate::library;
use crate::progress::Output;
use crate::state::{PendingTrack, Playlist};

use super::{count, report_import, Show};

pub fn list(app: &AppHandle, json: bool) -> Result<(), String> {
    let playlists = app.state::<Catalog>().playlists()?;

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&playlists).map_err(|e| e.to_string())?
        );
        return Ok(());
    }

    if playlists.is_empty() {
        println!("There are no playlists yet.");
        return Ok(());
    }

    let width = playlists
        .iter()
        .map(|playlist| playlist.name.chars().count())
        .max()
        .unwrap_or(0);

    for playlist in &playlists {
        println!(
            "{:width$}  {}",
            playlist.name,
            subtitle(playlist),
            width = width
        );
    }

    Ok(())
}

pub fn show(app: &AppHandle, options: &Show) -> Result<(), String> {
    let catalog = app.state::<Catalog>();
    let playlist = find(&catalog, &options.name)?;

    if options.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&playlist).map_err(|e| e.to_string())?
        );
        return Ok(());
    }

    let root = library::library_root(app)?;
    let tracks: HashMap<String, TrackRow> = catalog
        .tracks()?
        .into_iter()
        .map(|row| (row.id.clone(), row))
        .collect();

    println!("{} ({})", playlist.name, subtitle(&playlist));
    if playlist.entries.is_empty() {
        println!("Nothing in it yet.");
        return Ok(());
    }

    let limit = options.limit.unwrap_or(usize::MAX);
    let number = playlist.entries.len().to_string().len();
    for (position, entry) in playlist.entries.iter().take(limit).enumerate() {
        let waiting = playlist.pending.iter().find(|track| &track.id == entry);
        let line = match (waiting, tracks.get(entry)) {
            (Some(track), _) => format!("{} (to download)", pending_label(track)),
            (None, Some(row)) => library::track_label(&library::to_track(row, &root)),
            // A song whose row has gone: it keeps its place until it is deleted.
            (None, None) => format!("{entry} (gone)"),
        };
        println!("{:>number$}. {line}", position + 1, number = number);
    }
    if limit < playlist.entries.len() {
        println!(
            "\n{} of {} songs. Raise --limit to see the rest.",
            limit,
            playlist.entries.len()
        );
    }

    Ok(())
}

/// Downloads the songs a playlist is waiting on.
pub fn download(app: &AppHandle, name: &str) -> Result<(), String> {
    let catalog = app.state::<Catalog>();
    let playlist = find(&catalog, name)?;

    // An empty list means every song the playlist is waiting on.
    let outcome = crate::playlist_download::run(app, &playlist.id, &[], Output::Console)?;

    report_import(&outcome)
}

/// Writes a playlist out as a .wavelist file.
pub fn export(app: &AppHandle, name: &str, file: &Path) -> Result<(), String> {
    let catalog = app.state::<Catalog>();
    let playlist = find(&catalog, name)?;

    if playlist.track_ids.is_empty() {
        return Err(format!(
            "{} holds no songs the library has, so there is nothing to write",
            playlist.name
        ));
    }

    let written = crate::transfer::export(app, file, playlist.name.clone(), &playlist.track_ids)?;

    println!(
        "Wrote {} to {}.",
        count(written, "song"),
        file.display()
    );
    Ok(())
}

/// The playlist a name or an id points at.
fn find(catalog: &Catalog, wanted: &str) -> Result<Playlist, String> {
    let wanted = wanted.trim();
    let folded = fold(wanted);

    catalog
        .playlists()?
        .into_iter()
        .find(|playlist| playlist.id == wanted || fold(&playlist.name) == folded)
        .ok_or_else(|| {
            format!("there is no playlist called {wanted}. Run `wave playlists` to see them.")
        })
}

/// `12 songs`, `50 songs, 3 to download`.
fn subtitle(playlist: &Playlist) -> String {
    let mut parts = vec![count(playlist.track_ids.len(), "song")];
    let waiting = playlist.entries.len().saturating_sub(playlist.track_ids.len());
    if waiting > 0 {
        parts.push(format!("{waiting} to download"));
    }
    parts.join(", ")
}

/// A song the playlist is waiting on, named the way a library song is.
fn pending_label(track: &PendingTrack) -> String {
    let artists = track
        .artists
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(", ");

    if artists.trim().is_empty() {
        track.title.clone()
    } else {
        format!("{artists} - {}", track.title)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::CUSTOM_KIND;

    fn playlist(name: &str, songs: usize, waiting: usize) -> Playlist {
        Playlist {
            id: "p".to_string(),
            name: name.to_string(),
            track_ids: vec!["a".to_string(); songs],
            created_at: 0,
            kind: CUSTOM_KIND.to_string(),
            entries: vec!["a".to_string(); songs + waiting],
            pending: Vec::new(),
        }
    }

    #[test]
    fn says_what_a_playlist_holds_and_what_it_is_waiting_on() {
        assert_eq!(subtitle(&playlist("One", 12, 0)), "12 songs");
        assert_eq!(subtitle(&playlist("Two", 50, 3)), "50 songs, 3 to download");
        assert_eq!(subtitle(&playlist("Three", 1, 0)), "1 song");
    }

    #[test]
    fn names_a_waiting_song_the_way_a_library_one_is_named() {
        let track = PendingTrack {
            title: "Duality".to_string(),
            artists: vec!["Slipknot".to_string()],
            ..PendingTrack::default()
        };
        assert_eq!(pending_label(&track), "Slipknot - Duality");

        // A source that gave no artist leaves the title on its own.
        let bare = PendingTrack {
            title: "Duality".to_string(),
            ..PendingTrack::default()
        };
        assert_eq!(pending_label(&bare), "Duality");
    }
}
