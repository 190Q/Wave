//! Deezer's public catalogue. A public playlist, album or track needs no
//! account: the API hands the metadata to anyone who asks. Only a playlist its
//! owner marked Private is refused, and that refusal names the fix.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::source::{client, encode, env_path, read_env, retry_after, wait_phrase, TrackMeta};
use crate::tools;

const API: &str = "https://api.deezer.com";

/// How many tracks one page of a listing asks for.
const PAGE: usize = 100;

/// Deezer's own share links carry no id: they answer with a redirect to one.
const SHORT_LINKS: [&str; 2] = ["deezer.page.link", "link.deezer.com"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefKind {
    Playlist,
    Album,
    Track,
}

#[derive(Debug, Clone)]
pub struct DeezerRef {
    pub kind: RefKind,
    pub id: String,
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub id: String,
    pub meta: TrackMeta,
    pub album_id: Option<String>,
}

/// A Deezer artist, as a search or a relation hands it back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Artist {
    pub id: String,
    pub name: String,
}

/// One of Deezer's own genres, which is a fixed list rather than free text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Genre {
    pub id: String,
    pub name: String,
}

/// How the album lookups went, so the dialog can say when they were refused.
#[derive(Debug, Clone, Copy, Default)]
pub struct Enriched {
    /// Albums that answered, whose songs got their genre and track number.
    pub albums: usize,
    /// Albums that would not answer, whose songs keep the listing's fields.
    pub missed: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeezerStatus {
    /// Where the `.env` is expected, so the tool overrides can be pointed out.
    pub env_path: String,
    pub yt_dlp: bool,
    pub yt_dlp_source: String,
    pub ffmpeg: bool,
    pub message: String,
}

pub fn status<R: Runtime>(app: &AppHandle<R>) -> DeezerStatus {
    let tools = tools::status(&read_env(app));
    let message = tools.problem().unwrap_or_else(|| {
        "Deezer is ready. No sign-in is needed: a public playlist, album or track is read \
         straight from Deezer's catalogue."
            .to_string()
    });

    DeezerStatus {
        env_path: env_path(app)
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
        yt_dlp: tools.yt_dlp,
        yt_dlp_source: tools.yt_dlp_source,
        ffmpeg: tools.ffmpeg,
        message,
    }
}

/// Splits a link or a URI into what it points at.
pub fn resolve_ref(input: &str) -> Result<DeezerRef, String> {
    let trimmed = input.trim();
    if let Some(reference) = parse(trimmed) {
        return Ok(reference);
    }

    // A share link hides the kind and the id behind a redirect.
    if let Some(reference) = follow(trimmed).and_then(|resolved| parse(&resolved)) {
        return Ok(reference);
    }

    Err(format!(
        "Could not read a Deezer link from: {input}. Paste a playlist, album or track link, \
         such as https://www.deezer.com/playlist/908622995."
    ))
}

/// The kind and the id in a link, whatever locale sits in front of them.
fn parse(input: &str) -> Option<DeezerRef> {
    for (needle, kind) in [
        ("playlist", RefKind::Playlist),
        ("album", RefKind::Album),
        ("track", RefKind::Track),
    ] {
        let Some(at) = input.find(needle) else {
            continue;
        };
        let Some(rest) = input[at + needle.len()..].strip_prefix(['/', ':']) else {
            continue;
        };
        let id: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if !id.is_empty() {
            return Some(DeezerRef { kind, id });
        }
    }
    None
}

/// The link a short share URL lands on.
fn follow(input: &str) -> Option<String> {
    if !SHORT_LINKS.iter().any(|host| input.contains(host)) {
        return None;
    }
    let response = client().get(input).send().ok()?;
    Some(response.url().to_string())
}

/// A path below the API, or the absolute `next` link a listing hands back.
fn get(target: &str) -> Result<Value, String> {
    let url = if target.starts_with("http") {
        target.to_string()
    } else {
        format!("{API}/{target}")
    };

    let response = client()
        .get(&url)
        .send()
        .map_err(|e| format!("could not reach Deezer: {e}"))?;

    let status = response.status();
    let retry = retry_after(&response);
    let body = response.text().unwrap_or_default();
    let parsed: Option<Value> = serde_json::from_str(&body).ok();

    if let Some(error) = parsed.as_ref().and_then(|value| value.get("error")) {
        return Err(refusal(status.as_u16(), retry, error));
    }
    if !status.is_success() {
        return Err(format!("Deezer refused the request ({}).", status.as_u16()));
    }

    parsed.ok_or_else(|| {
        format!(
            "Deezer sent an odd reply: {}",
            body.chars().take(200).collect::<String>()
        )
    })
}

fn refusal(status: u16, retry: Option<u64>, error: &Value) -> String {
    let code = error["code"].as_u64().unwrap_or(0);
    let message = error["message"].as_str().unwrap_or_default();

    match code {
        // Quota spent, or the service asking for a moment.
        4 | 700 => rate_limited(code, retry),
        // An active access token is the answer to a playlist marked Private.
        200 => "Deezer only hands that over to a signed-in account, which means it is marked \
                Private. Open it on Deezer, switch the Private toggle off, and paste the link \
                again."
            .to_string(),
        // Deezer's own "no data".
        800 => "Deezer has nothing at that link (800). Check the link, or the item may have \
                been taken down."
            .to_string(),
        _ if status == 429 => rate_limited(code, retry),
        _ => format!("Deezer refused the request ({status}): {message}"),
    }
}

fn rate_limited(code: u64, retry: Option<u64>) -> String {
    let wait = match retry {
        Some(seconds) => format!(" Try again {}.", wait_phrase(seconds)),
        None => " Try again in a few minutes.".to_string(),
    };
    format!("Deezer is limiting how often this can ask ({code}), not refusing the link.{wait}")
}

/// The playlist's name and every track in it, following the paging links.
pub fn playlist(id: &str) -> Result<(String, Vec<Entry>), String> {
    let meta = get(&format!("playlist/{id}"))?;
    let name = meta["title"].as_str().unwrap_or("Playlist").to_string();
    Ok((name, entries(&format!("playlist/{id}/tracks?limit={PAGE}"))?))
}

/// Every track in a listing, following the paging links.
fn entries(target: &str) -> Result<Vec<Entry>, String> {
    let mut target = target.to_string();
    let mut found = Vec::new();

    loop {
        let page = get(&target)?;

        for track in page["data"].as_array().into_iter().flatten() {
            if let Some(entry) = entry_of(track) {
                found.push(entry);
            }
        }

        match page["next"].as_str() {
            Some(next) if !next.is_empty() => target = next.to_string(),
            _ => break,
        }
    }

    Ok(found)
}

/// The artist whose name answers best to a search, if Deezer has one.
pub fn artist(name: &str) -> Result<Option<Artist>, String> {
    let reply = get(&format!("search/artist?q={}&limit=1", encode(name)))?;
    Ok(artist_in(&reply))
}

fn artist_in(reply: &Value) -> Option<Artist> {
    let found = reply["data"].as_array()?.first()?;
    let id = found["id"].as_u64()?;
    let name = found["name"].as_str()?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    Some(Artist {
        id: id.to_string(),
        name,
    })
}

/// An artist's most played tracks.
pub fn top_tracks(artist_id: &str, limit: usize) -> Result<Vec<Entry>, String> {
    entries(&format!("artist/{artist_id}/top?limit={limit}"))
}

/// The artists Deezer puts alongside this one.
pub fn related_artists(artist_id: &str) -> Result<Vec<Artist>, String> {
    let reply = get(&format!("artist/{artist_id}/related"))?;
    Ok(artists_in(&reply))
}

fn artists_in(reply: &Value) -> Vec<Artist> {
    reply["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|found| {
            let id = found["id"].as_u64()?;
            let name = found["name"].as_str()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some(Artist {
                id: id.to_string(),
                name,
            })
        })
        .collect()
}

/// Deezer's fixed genre list, which a library's free text is matched against.
pub fn genres() -> Result<Vec<Genre>, String> {
    let reply = get("genre")?;
    Ok(genre_list(&reply))
}

fn genre_list(reply: &Value) -> Vec<Genre> {
    reply["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|found| {
            let id = found["id"].as_u64()?;
            let name = found["name"].as_str()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            Some(Genre {
                id: id.to_string(),
                name,
            })
        })
        .collect()
}

/// How many songs a chart is asked for. Without this Deezer hands back ten.
const CHART_PAGE: usize = 100;

/// The songs charting in one of Deezer's genres.
pub fn genre_chart(genre_id: &str) -> Result<Vec<Entry>, String> {
    entries(&format!("chart/{genre_id}/tracks?limit={CHART_PAGE}"))
}

/// The songs the world is playing right now.
pub fn trending() -> Result<Vec<Entry>, String> {
    entries(&format!("chart/0/tracks?limit={CHART_PAGE}"))
}

pub fn album(id: &str) -> Result<(String, Vec<TrackMeta>), String> {
    let detail = get(&format!("album/{id}"))?;
    let name = detail["title"].as_str().unwrap_or("Album").to_string();
    let genres = genres_in(&detail);
    let release_date = detail["release_date"].as_str().unwrap_or_default().to_string();
    let album_artist = detail["artist"]["name"].as_str().unwrap_or_default().to_string();
    let total = detail["nb_tracks"].as_u64().map(|value| value as u32);

    let mut tracks = Vec::new();
    for (position, track) in detail["tracks"]["data"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let Some(mut meta) = normalise(track) else {
            continue;
        };
        meta.album = name.clone();
        meta.album_artist = album_artist.clone();
        meta.release_date = release_date.clone();
        meta.genres = genres.clone();
        meta.track_number = Some(position as u32 + 1);
        meta.track_total = total;
        tracks.push(meta);
    }

    Ok((name, tracks))
}

/// One track, with its album filled in for the genre and the album artist.
pub fn track(id: &str) -> Result<TrackMeta, String> {
    let found = get(&format!("track/{id}"))?;
    let mut meta = normalise(&found)
        .ok_or_else(|| "that Deezer track has no artist or title".to_string())?;

    // The track endpoint has these itself, unlike a listing.
    meta.release_date = found["release_date"].as_str().unwrap_or_default().to_string();
    meta.track_number = found["track_position"].as_u64().map(|value| value as u32);
    meta.disc_number = found["disk_number"].as_u64().map(|value| value as u32);

    let album = found["album"]["id"]
        .as_u64()
        .and_then(|id| detail_for(&id.to_string()));
    if let Some(detail) = album {
        meta.album_artist = detail.album_artist;
        meta.genres = detail.genres;
        meta.track_total = detail.total;
    }

    Ok(meta)
}

pub fn fill_from_albums(entries: &mut [Entry]) -> Enriched {
    let mut albums: HashMap<String, Option<AlbumDetail>> = HashMap::new();
    let mut filled = Enriched::default();

    for entry in entries.iter_mut() {
        let Some(album_id) = entry.album_id.clone() else {
            continue;
        };

        // Each album is looked up once, however many of its songs are here.
        let detail = albums.entry(album_id.clone()).or_insert_with(|| {
            let detail = detail_for(&album_id);
            if detail.is_some() {
                filled.albums += 1;
            } else {
                filled.missed += 1;
            }
            detail
        });

        let Some(detail) = detail.as_ref() else {
            continue;
        };

        entry.meta.album_artist = detail.album_artist.clone();
        entry.meta.release_date = detail.release_date.clone();
        entry.meta.genres = detail.genres.clone();
        entry.meta.track_total = detail.total;
        entry.meta.track_number = detail.positions.get(&entry.id).copied();
    }

    filled
}

/// The parts of an album a playlist listing does not carry.
struct AlbumDetail {
    album_artist: String,
    release_date: String,
    genres: Vec<String>,
    total: Option<u32>,
    /// Deezer track id -> its position on the album.
    positions: HashMap<String, u32>,
}

fn detail_for(id: &str) -> Option<AlbumDetail> {
    let detail = get(&format!("album/{id}")).ok()?;

    let positions = detail["tracks"]["data"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(position, track)| {
            track["id"]
                .as_u64()
                .map(|id| (id.to_string(), position as u32 + 1))
        })
        .collect();

    Some(AlbumDetail {
        album_artist: detail["artist"]["name"].as_str().unwrap_or_default().to_string(),
        release_date: detail["release_date"].as_str().unwrap_or_default().to_string(),
        genres: genres_in(&detail),
        total: detail["nb_tracks"].as_u64().map(|value| value as u32),
        positions,
    })
}

/// One track of a listing, with the album it sits on.
fn entry_of(track: &Value) -> Option<Entry> {
    Some(Entry {
        id: track["id"].as_u64()?.to_string(),
        meta: normalise(track)?,
        album_id: track["album"]["id"].as_u64().map(|id| id.to_string()),
    })
}

fn normalise(track: &Value) -> Option<TrackMeta> {
    let title = track["title"].as_str().unwrap_or_default().trim().to_string();
    let artist = track["artist"]["name"].as_str().unwrap_or_default().to_string();
    if title.is_empty() || artist.is_empty() {
        return None;
    }

    Some(TrackMeta {
        title,
        artists: vec![artist],
        album: track["album"]["title"].as_str().unwrap_or_default().to_string(),
        isrc: track["isrc"].as_str().unwrap_or_default().to_string(),
        // Deezer counts in seconds, and the rest of Wave in milliseconds.
        duration_ms: track["duration"].as_u64().map(|seconds| seconds * 1000),
        cover_url: cover_in(track),
        ..TrackMeta::default()
    })
}

/// The largest cover Deezer offers, which is square and 1000px.
fn cover_in(track: &Value) -> Option<String> {
    let album = &track["album"];
    ["cover_xl", "cover_big", "cover_medium"]
        .iter()
        .find_map(|key| album[*key].as_str())
        .filter(|url| !url.is_empty())
        .map(str::to_string)
}

/// An album's genres. A track carries none of its own.
fn genres_in(detail: &Value) -> Vec<String> {
    detail["genres"]["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|genre| genre["name"].as_str())
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_link_shape() {
        for link in [
            "https://www.deezer.com/playlist/908622995",
            "https://www.deezer.com/playlist/908622995?utm_source=deezer&utm_content=playlist-908622995",
            "https://api.deezer.com/playlist/908622995/tracks",
            "deezer:playlist:908622995",
        ] {
            let parsed = resolve_ref(link).unwrap();
            assert_eq!(parsed.kind, RefKind::Playlist, "{link}");
            assert_eq!(parsed.id, "908622995");
        }

        // A locale in the path does not hide the kind.
        let localised = resolve_ref("https://www.deezer.com/en/playlist/908622995").unwrap();
        assert_eq!(localised.kind, RefKind::Playlist);

        let album = resolve_ref("https://www.deezer.com/album/302127").unwrap();
        assert_eq!(album.kind, RefKind::Album);
        assert_eq!(album.id, "302127");

        let track = resolve_ref("https://www.deezer.com/track/3135556").unwrap();
        assert_eq!(track.kind, RefKind::Track);
        assert_eq!(track.id, "3135556");
    }

    #[test]
    fn rejects_what_is_not_a_link() {
        assert!(resolve_ref("https://example.com/nothing").is_err());
        assert!(resolve_ref("   ").is_err());
        // A bare id cannot say whether it is a playlist, an album or a track.
        assert!(resolve_ref("908622995").is_err());
    }

    #[test]
    fn says_what_to_do_about_a_private_playlist() {
        let error = serde_json::json!({
            "type": "OAuthException",
            "message": "An active access token must be used to query information about the current user",
            "code": 200
        });
        let refusal = refusal(200, None, &error);
        assert!(refusal.contains("Private"));
        assert!(refusal.contains("switch the Private toggle off"));
        // The wording matters: it has to stop the user hunting for a broken link.
        assert!(!refusal.contains("access token"));
    }

    #[test]
    fn a_missing_item_is_not_reported_as_a_refusal() {
        let error = serde_json::json!({ "type": "DataException", "message": "no data", "code": 800 });
        let refusal = refusal(200, None, &error);
        assert!(refusal.contains("nothing at that link"));
    }

    #[test]
    fn a_quota_is_a_wait_rather_than_a_broken_link() {
        let error = serde_json::json!({ "type": "Exception", "message": "Quota exceeded", "code": 4 });
        let limited = refusal(200, Some(30), &error);
        assert!(limited.contains("limiting how often"));
        assert!(limited.contains("in 30 seconds"));
        // The same code with no `Retry-After` still reads as a wait.
        assert!(refusal(200, None, &error).contains("in a few minutes"));

        // An HTTP 429 with no body error is a wait too.
        let bare = serde_json::json!({ "code": 0 });
        assert!(refusal(429, None, &bare).contains("limiting how often"));
    }

    #[test]
    fn reads_a_listing_entry() {
        let track = serde_json::json!({
            "id": 116348632,
            "title": "Hey Jude (Remastered 2015)",
            "isrc": "GBUM71505902",
            "artist": { "name": "The Beatles" },
            "album": {
                "id": 12047956,
                "title": "1 (Remastered 2015)",
                "cover_xl": "https://cdn-images.dzcdn.net/images/cover/x/1000x1000-000000-80-0-0.jpg"
            }
        });

        let entry = entry_of(&track).unwrap();
        assert_eq!(entry.id, "116348632");
        assert_eq!(entry.album_id.as_deref(), Some("12047956"));
        assert_eq!(entry.meta.title, "Hey Jude (Remastered 2015)");
        assert_eq!(entry.meta.artists, vec!["The Beatles"]);
        assert_eq!(entry.meta.album, "1 (Remastered 2015)");
        assert_eq!(entry.meta.isrc, "GBUM71505902");
        assert!(entry.meta.cover_url.unwrap().ends_with("1000x1000-000000-80-0-0.jpg"));
        // A listing has neither, so the album is what fills them in.
        assert!(entry.meta.genres.is_empty());
        assert_eq!(entry.meta.track_number, None);

        // A removed track leaves a null in the listing.
        assert!(entry_of(&serde_json::json!({ "id": 1, "title": "" })).is_none());
    }

    #[test]
    fn falls_back_to_a_smaller_cover() {
        let track = serde_json::json!({
            "title": "x",
            "artist": { "name": "y" },
            "album": { "cover_big": "https://cdn/big.jpg" }
        });
        assert_eq!(normalise(&track).unwrap().cover_url.as_deref(), Some("https://cdn/big.jpg"));

        // An entry with no cover at all is still usable.
        let bare = serde_json::json!({ "title": "x", "artist": { "name": "y" } });
        assert_eq!(normalise(&bare).unwrap().cover_url, None);
    }

    #[test]
    fn reads_the_genres_of_an_album() {
        let detail = serde_json::json!({
            "genres": { "data": [
                { "id": 106, "name": "Electro" },
                { "id": 152, "name": "  " }
            ] }
        });
        assert_eq!(genres_in(&detail), vec!["Electro"]);

        // An album Deezer has not classified carries no genres block.
        assert!(genres_in(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn reads_the_first_artist_of_a_search() {
        let reply = serde_json::json!({
            "data": [
                { "id": 1129431, "name": "The Beatles" },
                { "id": 2, "name": "The Beatles Tribute" }
            ]
        });

        let found = artist_in(&reply).unwrap();
        assert_eq!(found.id, "1129431");
        assert_eq!(found.name, "The Beatles");

        // A search that answered with nothing is not an artist.
        assert!(artist_in(&serde_json::json!({ "data": [] })).is_none());
    }

    #[test]
    fn reads_the_related_artists() {
        let reply = serde_json::json!({
            "data": [
                { "id": 1, "name": "  John Lennon " },
                { "id": 2, "name": "" },
                { "name": "No id" }
            ]
        });

        let found = artists_in(&reply);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "John Lennon");
        assert_eq!(found[0].id, "1");

        assert!(artists_in(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn reads_the_genre_list() {
        let reply = serde_json::json!({
            "data": [
                { "id": 132, "name": "Pop" },
                { "id": 152, "name": "Rock" },
                { "id": 0, "name": "  " }
            ]
        });

        let found = genre_list(&reply);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0], Genre { id: "132".to_string(), name: "Pop".to_string() });
        assert_eq!(found[1].name, "Rock");
    }

    #[test]
    fn reads_a_chart_entry() {
        let track = serde_json::json!({
            "id": 3135556,
            "title": "Harder, Better, Faster, Stronger",
            "artist": { "name": "Daft Punk" },
            "album": {
                "id": 302127,
                "title": "Discovery",
                "cover_xl": "https://cdn-images.dzcdn.net/images/cover/x/1000x1000-000000-80-0-0.jpg"
            }
        });

        let entry = entry_of(&track).unwrap();
        assert_eq!(entry.id, "3135556");
        assert_eq!(entry.album_id.as_deref(), Some("302127"));
        assert_eq!(entry.meta.artists, vec!["Daft Punk"]);
        assert_eq!(entry.meta.album, "Discovery");
    }

    #[test]
    fn says_which_tool_is_missing() {
        let status = DeezerStatus {
            env_path: String::new(),
            yt_dlp: true,
            yt_dlp_source: "yt-dlp.exe".to_string(),
            ffmpeg: true,
            message: "Deezer is ready.".to_string(),
        };

        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"ytDlpSource\""));
    }
}
