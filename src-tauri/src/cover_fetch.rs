use std::fs;
use std::path::Path;

use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::{TagExt, TaggedFileExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::catalog::Catalog;
use crate::library::{self, library_root, track_label, Track};
use crate::progress::Reporter;
use crate::source::{client, read_env};
use crate::spotify;

/// Follows one covers fetch, song by song.
pub const PROGRESS_EVENT: &str = "covers-fetch";

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoversOutcome {
    /// Written and linked.
    pub restored: usize,
    /// Of those, the ones the file already carried.
    pub embedded: usize,
    /// Of those, the ones fetched from a service.
    pub online: usize,
    /// Already had a cover, so they were left alone.
    pub skipped: usize,
    /// Nothing found anywhere.
    pub missing: usize,
    /// No artist to look them up by.
    pub untagged: usize,
    pub errors: Vec<String>,
}

/// A cover that was found.
struct Found {
    bytes: Vec<u8>,
    /// True when the art was already inside the file.
    from_file: bool,
}

fn run(app: &AppHandle, track_ids: &[String]) -> Result<CoversOutcome, String> {
    let mut report = Reporter::new(app, PROGRESS_EVENT);
    let outcome = run_inner(app, track_ids, &mut report);

    match &outcome {
        Ok(outcome) => report.phase("done", &summary(outcome)),
        Err(error) => report.phase("failed", error),
    }

    outcome
}

fn run_inner(
    app: &AppHandle,
    track_ids: &[String],
    report: &mut Reporter,
) -> Result<CoversOutcome, String> {
    let root = library_root(app)?;
    let catalog = app.state::<Catalog>();

    let by_id: std::collections::HashMap<String, Track> = library::scan(app, &catalog)
        .tracks
        .into_iter()
        .map(|track| (track.id.clone(), track))
        .collect();

    let wanted: Vec<Track> = track_ids
        .iter()
        .filter_map(|id| by_id.get(id).cloned())
        .collect();
    if wanted.is_empty() {
        return Err("there is nothing in that collection to find covers for".to_string());
    }

    let token = if spotify::signed_in(app) {
        spotify::access_token(app, &read_env(app)).ok()
    } else {
        None
    };

    report.phase(
        "covers",
        &format!("Looking for covers for {} songs.", wanted.len()),
    );
    report.count(wanted.len());

    let mut outcome = CoversOutcome::default();

    for (position, track) in wanted.iter().enumerate() {
        let label = track_label(track);
        report.at(position + 1, &label);

        // A song that already has a cover beside it is left alone.
        if track.artwork_path.is_some() {
            outcome.skipped += 1;
            continue;
        }

        match find_cover(token.as_deref(), track) {
            Ok(Some(found)) => match write_cover(&root, &catalog, track, &found.bytes) {
                Ok(()) => {
                    outcome.restored += 1;
                    if found.from_file {
                        outcome.embedded += 1;
                    } else {
                        outcome.online += 1;
                    }
                }
                Err(error) => {
                    outcome.errors.push(format!("{label}: {error}"));
                    report.fail(format!("{label}: {error}"));
                }
            },
            Ok(None) => {
                if track.artist.as_deref().unwrap_or_default().trim().is_empty() {
                    outcome.untagged += 1;
                } else {
                    outcome.missing += 1;
                }
            }
            Err(error) => {
                outcome.errors.push(format!("{label}: {error}"));
                report.fail(format!("{label}: {error}"));
            }
        }
    }

    Ok(outcome)
}

fn find_cover(token: Option<&str>, track: &Track) -> Result<Option<Found>, String> {
    if let Some(bytes) = embedded(track) {
        return Ok(Some(Found {
            bytes,
            from_file: true,
        }));
    }

    let artist = track.artist.clone().unwrap_or_default();
    let mut refusals: Vec<String> = Vec::new();

    if let Some(token) = token {
        match spotify::cover_url(token, &artist, &track.title) {
            Ok(Some(url)) => match download(&url) {
                Ok(Some(bytes)) => return Ok(Some(Found { bytes, from_file: false })),
                Ok(None) => {}
                Err(error) => refusals.push(format!("Spotify: {error}")),
            },
            Ok(None) => {}
            Err(error) => refusals.push(format!("Spotify: {error}")),
        }
    }

    for source in SOURCES {
        match source.look_up(&artist, &track.title) {
            Ok(Some(url)) => match download(&url) {
                Ok(Some(bytes)) => return Ok(Some(Found { bytes, from_file: false })),
                Ok(None) => {}
                Err(error) => refusals.push(format!("{}: {error}", source.name())),
            },
            Ok(None) => {}
            Err(error) => refusals.push(format!("{}: {error}", source.name())),
        }
    }

    let tried = SOURCES.len() + usize::from(token.is_some());
    if tried > 0 && refusals.len() == tried {
        return Err(refusals.join("; "));
    }
    Ok(None)
}

pub fn look_up(artist: &str, title: &str) -> Option<Vec<u8>> {
    let artist = artist.trim();
    let title = title.trim();
    if artist.is_empty() || title.is_empty() {
        return None;
    }

    SOURCES
        .iter()
        .filter_map(|source| source.look_up(artist, title).ok().flatten())
        .find_map(|url| download(&url).ok().flatten())
}

/// The art already inside the file, if it has any.
fn embedded(track: &Track) -> Option<Vec<u8>> {
    let tagged = lofty::read_from_path(&track.path).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    tag.pictures().first().map(|picture| picture.data().to_vec())
}

fn write_cover(root: &Path, catalog: &Catalog, track: &Track, bytes: &[u8]) -> Result<(), String> {
    // The extension follows the bytes, so the image is served as what it is.
    let (extension, mime) = if is_png(bytes) {
        ("png", MimeType::Png)
    } else {
        ("jpg", MimeType::Jpeg)
    };

    let target = library::cover_path(root, &track.id, extension);
    fs::write(&target, bytes).map_err(|e| format!("could not write {}: {e}", target.display()))?;

    if let Some(relative) = library::relative(root, &target) {
        catalog.set_cover(&track.id, Some(&relative))?;
    }

    let _ = embed(&track.path, bytes, mime);
    Ok(())
}

fn embed(path: &str, bytes: &[u8], mime: MimeType) -> Result<(), String> {
    let path = Path::new(path);

    // The tag is cloned out so the reader is closed before the file is written.
    let mut tag = {
        let tagged = lofty::read_from_path(path)
            .map_err(|e| format!("could not read {}: {e}", path.display()))?;
        tagged
            .primary_tag()
            .cloned()
            .ok_or_else(|| format!("{} carries no tags to write a cover into", path.display()))?
    };

    tag.remove_picture_type(PictureType::CoverFront);
    tag.push_picture(
        Picture::unchecked(bytes.to_vec())
            .pic_type(PictureType::CoverFront)
            .mime_type(mime)
            .build(),
    );

    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("could not write a cover into {}: {e}", path.display()))
}

pub(crate) fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x89, b'P', b'N', b'G'])
}

/// The free image sources, in the order they are tried.
const SOURCES: [Source; 2] = [Source::Itunes, Source::Deezer];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    /// Apple's catalogue, whose thumbnails come in several sizes.
    Itunes,
    /// Deezer's, which serves square covers up to 1000px.
    Deezer,
}

impl Source {
    fn name(self) -> &'static str {
        match self {
            Source::Itunes => "iTunes",
            Source::Deezer => "Deezer",
        }
    }

    fn look_up(self, artist: &str, title: &str) -> Result<Option<String>, String> {
        match self {
            Source::Itunes => itunes(artist, title),
            Source::Deezer => deezer(artist, title),
        }
    }
}

fn itunes(artist: &str, title: &str) -> Result<Option<String>, String> {
    #[derive(Deserialize, Default)]
    struct Reply {
        #[serde(default)]
        results: Vec<Entry>,
    }

    #[derive(Deserialize, Default)]
    struct Entry {
        #[serde(default, rename = "artworkUrl100")]
        artwork: String,
    }

    let response = send(
        "https://itunes.apple.com/search",
        &[
            ("term", format!("{artist} {title}")),
            ("media", "music".to_string()),
            ("entity", "song".to_string()),
            ("limit", "1".to_string()),
        ],
    )?;
    let body = body_of(response)?;
    let reply: Reply = serde_json::from_str(&body).map_err(|e| format!("sent an odd reply: {e}"))?;

    // The reply points at a 100px thumbnail; the same image comes in any size.
    Ok(reply
        .results
        .first()
        .map(|entry| entry.artwork.replace("100x100", "600x600"))
        .filter(|url| !url.is_empty()))
}

fn deezer(artist: &str, title: &str) -> Result<Option<String>, String> {
    #[derive(Deserialize, Default)]
    struct Reply {
        #[serde(default)]
        data: Vec<Entry>,
    }

    #[derive(Deserialize, Default)]
    struct Entry {
        #[serde(default)]
        album: Album,
    }

    #[derive(Deserialize, Default)]
    struct Album {
        #[serde(default, rename = "cover_xl")]
        cover_xl: String,
        #[serde(default, rename = "cover_big")]
        cover_big: String,
        #[serde(default, rename = "cover_medium")]
        cover_medium: String,
    }

    // Deezer ignores `artist:` and `track:` qualifiers, so this is a plain query.
    let response = send(
        "https://api.deezer.com/search",
        &[
            ("q", format!("{artist} {title}")),
            ("limit", "1".to_string()),
        ],
    )?;
    let body = body_of(response)?;
    let reply: Reply = serde_json::from_str(&body).map_err(|e| format!("sent an odd reply: {e}"))?;

    let Some(entry) = reply.data.first() else {
        return Ok(None);
    };

    Ok(
        [&entry.album.cover_xl, &entry.album.cover_big, &entry.album.cover_medium]
            .into_iter()
            .find(|url| !url.is_empty())
            .cloned(),
    )
}

fn send(url: &str, params: &[(&str, String)]) -> Result<reqwest::blocking::Response, String> {
    client()
        .get(url)
        .query(params)
        .send()
        .map_err(|e| format!("could not be reached: {e}"))
}

fn body_of(response: reqwest::blocking::Response) -> Result<String, String> {
    if !response.status().is_success() {
        return Err(format!("refused the search ({})", response.status().as_u16()));
    }
    Ok(response.text().unwrap_or_default())
}

fn download(url: &str) -> Result<Option<Vec<u8>>, String> {
    let response = client()
        .get(url)
        .send()
        .map_err(|e| format!("could not be reached: {e}"))?;

    if !response.status().is_success() {
        return Ok(None);
    }

    Ok(response.bytes().ok().map(|bytes| bytes.to_vec()))
}

fn summary(outcome: &CoversOutcome) -> String {
    let mut parts = vec![format!("{} restored", outcome.restored)];
    if outcome.embedded > 0 {
        parts.push(format!("{} from the files themselves", outcome.embedded));
    }
    if outcome.online > 0 {
        parts.push(format!("{} fetched", outcome.online));
    }
    if outcome.skipped > 0 {
        parts.push(format!("{} already had covers", outcome.skipped));
    }
    if outcome.untagged > 0 {
        parts.push(format!("{} with no artist tag", outcome.untagged));
    }
    if outcome.missing > 0 {
        parts.push(format!("{} not found", outcome.missing));
    }
    if !outcome.errors.is_empty() {
        parts.push(format!("{} failed", outcome.errors.len()));
    }
    parts.join(", ")
}

#[tauri::command]
pub async fn fetch_covers(app: AppHandle, track_ids: Vec<String>) -> Result<CoversOutcome, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || run(&handle, &track_ids))
        .await
        .map_err(|e| format!("the cover fetch stopped unexpectedly: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spots_a_png_by_its_signature() {
        assert!(is_png(&[0x89, b'P', b'N', b'G', 0x0D]));
        assert!(!is_png(&[0xFF, 0xD8, 0xFF, 0xE0]));
        assert!(!is_png(&[]));
    }

    #[test]
    fn a_cover_lands_in_the_song_that_owns_it() {
        let root = Path::new("library");
        let path = library::cover_path(root, "a-song", "png");

        assert!(path.ends_with(Path::new("songs").join("a-song").join("cover.png")));
    }

    #[test]
    fn sums_up_what_happened() {
        let outcome = CoversOutcome {
            restored: 5,
            embedded: 2,
            online: 3,
            skipped: 40,
            missing: 1,
            untagged: 0,
            errors: vec![],
        };
        assert_eq!(
            summary(&outcome),
            "5 restored, 2 from the files themselves, 3 fetched, 40 already had covers, 1 not found"
        );
    }
}
