use std::fs;
use std::path::Path;

use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::{Accessor, TagExt, TaggedFileExt};
use lofty::tag::Tag;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::catalog::Catalog;
use crate::import_source::fold;
use crate::library::{self, library_root, track_label, Track};
use crate::progress::{Output, Reporter};
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
    /// Given the artist and album a lookup found, which the file did not carry.
    pub tagged: usize,
    pub errors: Vec<String>,
}

fn matches_featured(hit: &DeezerTrack, title: &str, artist: Option<&str>, featured: &str) -> bool {
    matches_deezer_title(hit, title, artist)
        && hit.contributors.iter().any(|person| fold(&person.name) == fold(featured))
}

fn featured_title(title: &str) -> Option<(&str, &str)> {
    let title = title.trim();
    let close = title.chars().last()?;
    let open = match close {
        ')' => '(',
        ']' => '[',
        _ => return None,
    };
    let start = title.rfind(open)?;
    let name = title[..start].trim();
    let credit = title[start + 1..title.len() - 1].trim();
    let lower = credit.to_ascii_lowercase();
    let prefix = ["feat.", "feat ", "ft.", "ft ", "featuring "]
        .iter()
        .find(|prefix| lower.starts_with(**prefix))?;
    let featured = credit[prefix.len()..].trim();
    (!name.is_empty() && !featured.is_empty()).then_some((name, featured))
}

fn matches_deezer_title(hit: &DeezerTrack, title: &str, artist: Option<&str>) -> bool {
    fold(&hit.title) == fold(title)
        && !hit.artist.name.trim().is_empty()
        && artist
            .filter(|name| !name.trim().is_empty())
            .map_or(true, |name| fold(name) == fold(&hit.artist.name))
}

/// A cover that was found.
struct Found {
    bytes: Vec<u8>,
    /// True when the art was already inside the file.
    from_file: bool,
}

pub fn fill(app: &AppHandle, track_ids: &[String]) -> Result<CoversOutcome, String> {
    run_inner(app, track_ids, &mut Reporter::quiet())
}

pub fn run(app: &AppHandle, track_ids: &[String], output: Output) -> Result<CoversOutcome, String> {
    let mut report = Reporter::new(app, PROGRESS_EVENT, output);
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

    let wanted = library::songs(app, &catalog, track_ids);
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

        let mut track = track.clone();
        let mut hint: Option<String> = None;

        if wants_tags(&track) {
            match named_by_title(&track.title, track.artist.as_deref()) {
                Ok(Some(named)) => {
                    match write_tags(&root, &catalog, &track, &named) {
                        Ok(true) => outcome.tagged += 1,
                        Ok(false) => {}
                        Err(error) => outcome.errors.push(format!("{label}: {error}")),
                    }

                    if blank(track.artist.as_deref()) && !named.artist.trim().is_empty() {
                        track.artist = Some(named.artist.clone());
                    }
                    if blank(track.album.as_deref()) && !named.album.trim().is_empty() {
                        track.album = Some(named.album.clone());
                    }
                    if blank(track.genre.as_deref()) && !named.genre.trim().is_empty() {
                        track.genre = Some(named.genre.clone());
                    }
                    hint = named.cover;
                }
                Ok(None) => {}
                Err(error) => outcome.errors.push(format!("{label}: {error}")),
            }
        }

        if track.artwork_path.is_some() {
            outcome.skipped += 1;
            continue;
        }

        match find_cover(token.as_deref(), &track, hint.as_deref()) {
            Ok(Some(found)) => match write_cover(&root, &catalog, &track, &found.bytes) {
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

fn find_cover(token: Option<&str>, track: &Track, hint: Option<&str>) -> Result<Option<Found>, String> {
    if let Some(bytes) = embedded(track) {
        return Ok(Some(Found {
            bytes,
            from_file: true,
        }));
    }

    let artist = track.artist.clone().unwrap_or_default();
    let album = track.album.clone().unwrap_or_default();
    let mut refusals: Vec<String> = Vec::new();

    let url = hint
        .map(str::to_string)
        .or_else(|| album_cover(token, &artist, &album, &mut refusals))
        .or_else(|| song_cover(token, &artist, &track.title, &album, &mut refusals));

    let Some(url) = url else {
        // Everything that was asked either refused or had nothing.
        return if refusals.is_empty() {
            Ok(None)
        } else {
            Err(refusals.join("; "))
        };
    };

    match download(&url) {
        Ok(Some(bytes)) => Ok(Some(Found { bytes, from_file: false })),
        Ok(None) => Ok(None),
        Err(error) => Err(error),
    }
}

fn album_cover(
    token: Option<&str>,
    artist: &str,
    album: &str,
    refusals: &mut Vec<String>,
) -> Option<String> {
    if album.trim().is_empty() {
        return None;
    }

    if let Some(token) = token {
        match spotify::cover_url(token, artist, "", album) {
            Ok(Some(url)) => return Some(url),
            Ok(None) => {}
            Err(error) => refusals.push(format!("Spotify: {error}")),
        }
    }

    for source in SOURCES {
        match source.album_cover(artist, album) {
            Ok(Some(url)) => return Some(url),
            Ok(None) => {}
            Err(error) => refusals.push(format!("{}: {error}", source.name())),
        }
    }
    None
}

fn song_cover(
    token: Option<&str>,
    artist: &str,
    title: &str,
    album: &str,
    refusals: &mut Vec<String>,
) -> Option<String> {
    if let Some(token) = token {
        match spotify::cover_url(token, artist, title, "") {
            Ok(Some(url)) => return Some(url),
            Ok(None) => {}
            Err(error) => refusals.push(format!("Spotify: {error}")),
        }
    }

    for source in SOURCES {
        match source.song_cover(artist, title, album) {
            Ok(Some(url)) => return Some(url),
            Ok(None) => {}
            Err(error) => refusals.push(format!("{}: {error}", source.name())),
        }
    }
    None
}

pub fn look_up(artist: &str, title: &str, album: &str) -> Option<Vec<u8>> {
    let artist = artist.trim();
    let title = title.trim();
    if artist.is_empty() || title.is_empty() {
        return None;
    }

    let mut refusals = Vec::new();
    let url = album_cover(None, artist, album.trim(), &mut refusals)
        .or_else(|| song_cover(None, artist, title, album.trim(), &mut refusals));

    url.and_then(|url| download(&url).ok().flatten())
}

/// What a lookup by title alone found.
struct Named {
    artist: String,
    album: String,
    genre: String,
    cover: Option<String>,
}

fn blank(value: Option<&str>) -> bool {
    value.unwrap_or_default().trim().is_empty()
}

fn wants_tags(track: &Track) -> bool {
    blank(track.artist.as_deref()) || blank(track.album.as_deref()) || blank(track.genre.as_deref())
}

fn matching_title<'a>(hits: &'a [ItunesHit], title: &str, artist: Option<&str>) -> Option<&'a ItunesHit> {
    let wanted = fold(title);
    let known_artist = artist.map(fold).filter(|name| !name.is_empty());
    hits.iter().find(|hit| {
        fold(&hit.track) == wanted
            && known_artist
                .as_ref()
                .map_or(true, |name| fold(&hit.artist) == *name)
    })
}

fn named_by_title(title: &str, artist: Option<&str>) -> Result<Option<Named>, String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let query = artist.filter(|value| !value.trim().is_empty())
        .map_or_else(|| trimmed.to_string(), |value| format!("{} {trimmed}", value.trim()));
    let hits = itunes_hits(&query)?;
    let hit = matching_title(&hits, trimmed, artist);
    if let Some(hit) = hit {
        return Ok(Some(Named {
            artist: hit.artist.clone(),
            album: hit.album.clone(),
            genre: hit.genre.clone(),
            cover: hit.cover(),
        }));
    }

    let Some((name, featured)) = featured_title(trimmed) else {
        return Ok(None);
    };
    let hits: Vec<DeezerTrack> = deezer_hits("https://api.deezer.com/search", &query)?;
    for hit in hits {
        if !matches_deezer_title(&hit, name, artist) || hit.id == 0 {
            continue;
        }
        let detail: DeezerTrack = deezer_detail(&format!("https://api.deezer.com/track/{}", hit.id))?;
        if !matches_featured(&detail, name, artist, featured) {
            continue;
        }
        let genre = if detail.album.id == 0 {
            String::new()
        } else {
            deezer_detail::<DeezerAlbum>(&format!("https://api.deezer.com/album/{}", detail.album.id))
                .ok()
                .and_then(|album| album.genres.data.into_iter().find(|genre| !genre.name.trim().is_empty()))
                .map(|genre| genre.name)
                .unwrap_or_default()
        };
        return Ok(Some(Named {
            artist: detail.artist.name.clone(),
            album: detail.album.title.clone(),
            genre,
            cover: detail.album.cover(),
        }));
    }
    Ok(None)
}

/// Writes what a lookup found into the file, and reads the row back so the
/// catalog says what the file says. True when something was written.
fn write_tags(
    root: &Path,
    catalog: &Catalog,
    track: &Track,
    named: &Named,
) -> Result<bool, String> {
    let path = Path::new(&track.path);
    if !write_tags_to_file(path, named)? {
        return Ok(false);
    }

    if let Some(known) = catalog.track(&track.id)? {
        let mut row = library::describe(
            root,
            &track.id,
            path,
            &known.original_name,
            known.content_hash.as_deref(),
        )?;
        row.added_at = known.added_at;
        catalog.upsert_track(&row)?;
    }

    Ok(true)
}

fn write_tags_to_file(path: &Path, named: &Named) -> Result<bool, String> {
    let tagged =
        lofty::read_from_path(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let mut tag = tagged.primary_tag().or_else(|| tagged.first_tag()).cloned()
        .unwrap_or_else(|| Tag::new(tagged.file_type().primary_tag_type()));

    let mut wrote = false;
    if blank(tag.artist().as_deref()) && !named.artist.trim().is_empty() {
        tag.set_artist(named.artist.clone());
        wrote = true;
    }
    if blank(tag.album().as_deref()) && !named.album.trim().is_empty() {
        tag.set_album(named.album.clone());
        wrote = true;
    }
    if blank(tag.genre().as_deref()) && !named.genre.trim().is_empty() {
        tag.set_genre(named.genre.clone());
        wrote = true;
    }

    if !wrote {
        return Ok(false);
    }

    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("could not write {}: {e}", path.display()))?;

    Ok(true)
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

    fn album_cover(self, artist: &str, album: &str) -> Result<Option<String>, String> {
        match self {
            Source::Itunes => itunes_album(artist, album),
            Source::Deezer => deezer_album(artist, album),
        }
    }

    /// The cover of the first hit for the song itself.
    fn song_cover(self, artist: &str, title: &str, album: &str) -> Result<Option<String>, String> {
        match self {
            Source::Itunes => itunes_song(artist, title, album),
            Source::Deezer => deezer_song(artist, title, album),
        }
    }
}

fn same_album(one: &str, other: &str) -> bool {
    let (one, other) = (fold(one), fold(other));

    !one.is_empty()
        && !other.is_empty()
        && (one == other || one.contains(&other) || other.contains(&one))
}

/// The hit that names the album, or `None` when none of them does.
fn naming<'a, T>(hits: &'a [T], name: impl Fn(&T) -> String, album: &str) -> Option<&'a T> {
    if album.trim().is_empty() {
        return None;
    }
    hits.iter().find(|hit| same_album(&name(hit), album))
}

/// The hit that names the album, or the first one when none of them does.
fn matching<'a, T>(hits: &'a [T], name: impl Fn(&T) -> String, album: &str) -> Option<&'a T> {
    naming(hits, &name, album).or_else(|| hits.first())
}

#[derive(Deserialize, Default)]
struct ItunesHit {
    #[serde(default, rename = "trackName")]
    track: String,
    #[serde(default, rename = "artistName")]
    artist: String,
    #[serde(default, rename = "collectionName")]
    album: String,
    #[serde(default, rename = "primaryGenreName")]
    genre: String,
    #[serde(default, rename = "artworkUrl100")]
    artwork: String,
}

impl ItunesHit {
    fn cover(&self) -> Option<String> {
        let url = self.artwork.replace("100x100", "600x600");
        (!url.is_empty()).then_some(url)
    }
}

#[derive(Deserialize, Default)]
struct ItunesReply {
    #[serde(default)]
    results: Vec<ItunesHit>,
}

/// An album as Deezer lists it: the name, and the art in three sizes.
#[derive(Deserialize, Default)]
struct DeezerAlbum {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    genres: DeezerGenres,
    #[serde(default, rename = "cover_xl")]
    cover_xl: String,
    #[serde(default, rename = "cover_big")]
    cover_big: String,
    #[serde(default, rename = "cover_medium")]
    cover_medium: String,
}

#[derive(Deserialize, Default)]
struct DeezerGenres {
    #[serde(default)]
    data: Vec<DeezerGenre>,
}

#[derive(Deserialize, Default)]
struct DeezerGenre {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize, Default)]
struct DeezerArtist {
    #[serde(default)]
    name: String,
}

impl DeezerAlbum {
    fn cover(&self) -> Option<String> {
        [&self.cover_xl, &self.cover_big, &self.cover_medium]
            .into_iter()
            .find(|url| !url.is_empty())
            .cloned()
    }
}

/// A Deezer track search hit, which carries the album it is on.
#[derive(Deserialize, Default)]
struct DeezerTrack {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    artist: DeezerArtist,
    #[serde(default)]
    contributors: Vec<DeezerArtist>,
    #[serde(default)]
    album: DeezerAlbum,
}

#[derive(Deserialize, Default)]
struct DeezerReply<T> {
    #[serde(default)]
    data: Vec<T>,
}

fn itunes_hits(term: &str) -> Result<Vec<ItunesHit>, String> {
    let response = send(
        "https://itunes.apple.com/search",
        &[
            ("term", term.to_string()),
            ("media", "music".to_string()),
            ("entity", "song".to_string()),
            ("limit", "10".to_string()),
        ],
    )?;
    let body = body_of(response)?;
    let reply: ItunesReply =
        serde_json::from_str(&body).map_err(|e| format!("sent an odd reply: {e}"))?;

    Ok(reply.results)
}

fn deezer_hits<T: serde::de::DeserializeOwned + Default>(
    url: &str,
    query: &str,
) -> Result<Vec<T>, String> {
    // Deezer ignores `artist:` and `track:` qualifiers, so this is a plain query.
    let response = send(
        url,
        &[("q", query.to_string()), ("limit", "10".to_string())],
    )?;
    let body = body_of(response)?;
    let reply: DeezerReply<T> =
        serde_json::from_str(&body).map_err(|e| format!("sent an odd reply: {e}"))?;

    Ok(reply.data)
}

fn deezer_detail<T: serde::de::DeserializeOwned>(url: &str) -> Result<T, String> {
    let body = body_of(send(url, &[])?)?;
    serde_json::from_str(&body).map_err(|e| format!("sent an odd reply: {e}"))
}

fn itunes_song(artist: &str, title: &str, album: &str) -> Result<Option<String>, String> {
    let hits = itunes_hits(&format!("{artist} {title}"))?;

    Ok(matching(&hits, |hit| hit.album.clone(), album).and_then(ItunesHit::cover))
}

fn itunes_album(artist: &str, album: &str) -> Result<Option<String>, String> {
    let hits = itunes_hits(&format!("{artist} {album}"))?;

    Ok(naming(&hits, |hit| hit.album.clone(), album).and_then(ItunesHit::cover))
}

fn deezer_song(artist: &str, title: &str, album: &str) -> Result<Option<String>, String> {
    let hits: Vec<DeezerTrack> =
        deezer_hits("https://api.deezer.com/search", &format!("{artist} {title}"))?;

    Ok(matching(&hits, |hit| hit.album.title.clone(), album).and_then(|hit| hit.album.cover()))
}

/// The art of a named album, asked for as an album rather than through a song.
fn deezer_album(artist: &str, album: &str) -> Result<Option<String>, String> {
    let hits: Vec<DeezerAlbum> =
        deezer_hits("https://api.deezer.com/search/album", &format!("{artist} {album}"))?;

    Ok(naming(&hits, |hit| hit.title.clone(), album).and_then(DeezerAlbum::cover))
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
    if outcome.tagged > 0 {
        parts.push(format!("{} given tags", outcome.tagged));
    }
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
    tauri::async_runtime::spawn_blocking(move || run(&handle, &track_ids, Output::Events))
        .await
        .map_err(|e| format!("the cover fetch stopped unexpectedly: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_featured_recording_requires_matching_title_and_credits() {
        assert_eq!(
            featured_title("God Is A Weapon (feat. Marilyn Manson)"),
            Some(("God Is A Weapon", "Marilyn Manson"))
        );
        assert_eq!(featured_title("A Song [FT. Guest]"), Some(("A Song", "Guest")));
        assert_eq!(featured_title("A Song (Remix)"), None);
        assert_eq!(featured_title("A Song (feat.)"), None);

        let track = DeezerTrack {
            title: "God Is A Weapon".into(),
            artist: DeezerArtist { name: "Falling In Reverse".into() },
            contributors: vec![DeezerArtist { name: "Marilyn Manson".into() }],
            ..DeezerTrack::default()
        };
        assert!(matches_featured(&track, "god is a weapon", None, "MARILYN MANSON"));
        assert!(matches_featured(&track, "God Is A Weapon", Some("Falling In Reverse"), "Marilyn Manson"));
        assert!(!matches_featured(&track, "A Different Song", None, "Marilyn Manson"));
        assert!(!matches_featured(&track, "God Is A Weapon", Some("Someone Else"), "Marilyn Manson"));
        assert!(!matches_featured(&track, "God Is A Weapon", None, "A Different Guest"));
    }

    #[test]
    fn title_lookup_respects_the_known_artist() {
        let hits = [
            ItunesHit {
                track: "A Song".into(),
                artist: "Another Artist".into(),
                ..ItunesHit::default()
            },
            ItunesHit {
                track: "A Song".into(),
                artist: "The Artist".into(),
                album: "The Album".into(),
                ..ItunesHit::default()
            },
        ];
        assert_eq!(
            matching_title(&hits, "a song", Some("THE ARTIST")).map(|hit| hit.album.as_str()),
            Some("The Album")
        );
        assert!(matching_title(&hits, "A Song", Some("Missing Artist")).is_none());
        assert!(matching_title(&hits, "Another Song", None).is_none());
        assert_eq!(
            matching_title(&hits, "A Song", None).map(|hit| hit.artist.as_str()),
            Some("Another Artist")
        );
    }

    #[test]
    fn writes_missing_tags_to_a_file_without_a_tag() {
        let dir = std::env::temp_dir().join(format!("wave-tag-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("audio.wav");
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&38u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&8000u32.to_le_bytes());
        wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&2u32.to_le_bytes());
        wav.extend_from_slice(&[0, 0]);
        fs::write(&path, wav).unwrap();

        let named = Named {
            artist: "Artist".into(),
            album: "Album".into(),
            genre: "Genre".into(),
            cover: None,
        };
        assert!(write_tags_to_file(&path, &named).unwrap());
        let tagged = lofty::read_from_path(&path).unwrap();
        let tag = tagged.primary_tag().or_else(|| tagged.first_tag()).unwrap();
        assert_eq!(tag.artist().as_deref(), Some("Artist"));
        assert_eq!(tag.album().as_deref(), Some("Album"));
        assert_eq!(tag.genre().as_deref(), Some("Genre"));
        assert!(!write_tags_to_file(&path, &named).unwrap());
        fs::remove_dir_all(&dir).unwrap();
    }

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
    fn an_album_is_matched_on_its_name() {
        assert!(same_album("Hindsight", "Hindsight"));
        assert!(same_album("Hindsight", "Hindsight (Deluxe Edition)"));
        assert!(same_album("Follow the Leader", "Follow The Leader (Expanded Edition)"));

        // Another release is another release, and a blank is not a name.
        assert!(!same_album("Hindsight", "Goodbye To The Gallows"));
        assert!(!same_album("", "Hindsight"));
        assert!(!same_album("Hindsight", "   "));
    }

    #[test]
    fn the_hit_that_names_the_album_is_taken_over_the_first() {
        let hits = ["Goodbye To The Gallows", "Hindsight"];
        let named = |name: &&str| name.to_string();

        assert_eq!(matching(&hits, named, "Hindsight"), Some(&"Hindsight"));
        // Nothing names it, so the first hit stands in.
        assert_eq!(
            matching(&hits, named, "Something Else"),
            Some(&"Goodbye To The Gallows")
        );

        // The album pass takes only a hit that names it.
        assert_eq!(naming(&hits, named, "Hindsight"), Some(&"Hindsight"));
        assert_eq!(naming(&hits, named, "Something Else"), None);
        assert_eq!(naming(&hits, named, ""), None);

        let none: [&str; 0] = [];
        assert_eq!(matching(&none, named, "Hindsight"), None);
    }

    #[test]
    fn a_hit_carries_the_art_of_the_album_it_came_out_on() {
        // iTunes answers a song search with the album, and with its art.
        let hit = ItunesHit {
            album: "Hindsight".to_string(),
            artwork: "https://example.com/100x100bb.jpg".to_string(),
            ..ItunesHit::default()
        };
        assert_eq!(hit.cover().as_deref(), Some("https://example.com/600x600bb.jpg"));

        // Deezer answers with the art in three sizes.
        let album = DeezerAlbum {
            title: "Hindsight".to_string(),
            cover_xl: String::new(),
            cover_big: "big.jpg".to_string(),
            cover_medium: "medium.jpg".to_string(),
            ..DeezerAlbum::default()
        };
        assert_eq!(album.cover().as_deref(), Some("big.jpg"));
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
            tagged: 2,
            errors: vec![],
        };
        assert_eq!(
            summary(&outcome),
            "5 restored, 2 given tags, 2 from the files themselves, 3 fetched, 40 already had covers, 1 not found"
        );
    }
}
