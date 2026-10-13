use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::thread::sleep;
use std::time::Duration;

use lofty::config::WriteOptions;
use lofty::prelude::{ItemKey, TagExt, TaggedFileExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::library::{
    self, library_root, read_index, song_stem, track_label, write_index, LibraryIndex, Track,
    TrackPaths, LYRICS_DIR,
};
use crate::progress::Reporter;
use crate::spotify::{client, encode};

const LRCLIB: &str = "https://lrclib.net/api";

/// LRCLIB asks callers to say who they are.
const AGENT: &str = "Wave/0.1 ( https://lrclib.net )";

/// NetEase only answers to something that looks like a browser.
const BROWSER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) \
     Chrome/120.0 Safari/537.36";

/// A pause between lookups so the API is not hammered, matching the script.
const DELAY_MS: u64 = 500;

/// Follows one lyrics fetch, song by song.
pub const PROGRESS_EVENT: &str = "lyrics-fetch";

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsOutcome {
    /// Looked up and written.
    pub fetched: usize,
    /// Of those, the ones with timings, which the player can scroll.
    pub synced: usize,
    /// Already had lyrics, so they were left alone.
    pub skipped: usize,
    /// LRCLIB had nothing for them.
    pub missing: usize,
    /// No tags to look a song up by.
    pub untagged: usize,
    pub errors: Vec<String>,
}

/// One LRCLIB result.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Found {
    plain_lyrics: String,
    synced_lyrics: String,
    track_name: String,
}

impl Found {
    fn has_lyrics(&self) -> bool {
        !self.plain_lyrics.trim().is_empty() || !self.synced_lyrics.trim().is_empty()
    }
}

fn run(app: &AppHandle, track_ids: &[String]) -> Result<LyricsOutcome, String> {
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
) -> Result<LyricsOutcome, String> {
    let root = library_root(app)?;
    let paths = app.state::<TrackPaths>();

    let by_id: HashMap<String, Track> = library::scan(app, &paths)
        .tracks
        .into_iter()
        .map(|track| (track.id.clone(), track))
        .collect();

    let wanted: Vec<Track> = track_ids
        .iter()
        .filter_map(|id| by_id.get(id).cloned())
        .collect();
    if wanted.is_empty() {
        return Err("there is nothing in that collection to look lyrics up for".to_string());
    }

    report.phase(
        "lyrics",
        &format!("Looking up lyrics for {} songs.", wanted.len()),
    );
    report.count(wanted.len());

    let lyrics_dir = root.join(LYRICS_DIR);
    let mut index = read_index(&root);
    let mut outcome = LyricsOutcome::default();

    for (position, track) in wanted.iter().enumerate() {
        let label = track_label(track);
        report.at(position + 1, &label);

        if track.lyrics_path.is_some() {
            outcome.skipped += 1;
            continue;
        }

        // Without an artist there is nothing to match on, exactly as the script
        // skips a file whose tags it cannot use.
        if track.artist.as_deref().unwrap_or_default().trim().is_empty() {
            outcome.untagged += 1;
            continue;
        }

        match look_up(track) {
            Ok(Some(found)) => {
                match file_lyrics(&lyrics_dir, &mut index, track, &found) {
                    Ok(()) => {
                        if !found.synced_lyrics.trim().is_empty() {
                            outcome.synced += 1;
                        }
                        outcome.fetched += 1;
                    }
                    Err(error) => {
                        outcome.errors.push(format!("{label}: {error}"));
                        report.fail(format!("{label}: {error}"));
                    }
                }
            }
            Ok(None) => outcome.missing += 1,
            Err(error) => {
                outcome.errors.push(format!("{label}: {error}"));
                report.fail(format!("{label}: {error}"));
            }
        }

        sleep(Duration::from_millis(DELAY_MS));
    }

    write_index(&root, &index)?;
    Ok(outcome)
}

/// Writes what was found: timings beside the song, plain text inside it.
fn file_lyrics(
    lyrics_dir: &Path,
    index: &mut LibraryIndex,
    track: &Track,
    found: &Found,
) -> Result<(), String> {
    let synced = found.synced_lyrics.trim();
    if !synced.is_empty() {
        let name = format!("{}.lrc", song_stem(&track.path));
        let target = lyrics_dir.join(&name);
        fs::write(&target, synced)
            .map_err(|e| format!("could not write {}: {e}", target.display()))?;
        index
            .lyrics
            .insert(track.relative_path.clone(), format!("{LYRICS_DIR}/{name}"));
    }

    let plain = found.plain_lyrics.trim();
    if !plain.is_empty() {
        embed(&track.path, plain)?;
    }

    Ok(())
}

/// Adds the plain lyrics to the file's own tags, keeping everything else.
fn embed(path: &str, plain: &str) -> Result<(), String> {
    let path = Path::new(path);

    // The tag is cloned out so the reader is closed before the file is written.
    let mut tag = {
        let tagged = lofty::read_from_path(path)
            .map_err(|e| format!("could not read {}: {e}", path.display()))?;
        tagged
            .primary_tag()
            .cloned()
            .ok_or_else(|| format!("{} carries no tags to write lyrics into", path.display()))?
    };

    tag.insert_text(ItemKey::UnsyncLyrics, plain.to_string());
    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("could not write lyrics into {}: {e}", path.display()))
}

/// Where lyrics are looked for, in the order they are tried. The first source
/// with anything for a song wins.
const SOURCES: [Source; 3] = [Source::Lrclib, Source::LyricsOvh, Source::NetEase];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    /// Timed and plain lyrics, matched on artist, title, album and duration.
    Lrclib,
    /// Plain lyrics only, matched on artist and title.
    LyricsOvh,
    /// Usually timed. Undocumented, so it is tried last.
    NetEase,
}

impl Source {
    fn name(self) -> &'static str {
        match self {
            Source::Lrclib => "LRCLIB",
            Source::LyricsOvh => "lyrics.ovh",
            Source::NetEase => "NetEase",
        }
    }

    fn look_up(self, track: &Track) -> Result<Option<Found>, String> {
        match self {
            Source::Lrclib => lrclib(track),
            Source::LyricsOvh => lyrics_ovh(track),
            Source::NetEase => netease(track),
        }
    }
}

fn look_up(track: &Track) -> Result<Option<Found>, String> {
    let mut refusals: Vec<String> = Vec::new();

    for source in SOURCES {
        match source.look_up(track) {
            Ok(Some(found)) if found.has_lyrics() => return Ok(Some(found)),
            Ok(_) => {}
            Err(error) => refusals.push(format!("{}: {error}", source.name())),
        }
    }

    if refusals.len() == SOURCES.len() {
        return Err(refusals.join("; "));
    }
    Ok(None)
}

fn lrclib(track: &Track) -> Result<Option<Found>, String> {
    let artist = track.artist.clone().unwrap_or_default();
    let title = track.title.clone();

    let mut exact: Vec<(&str, String)> = vec![
        ("artist_name", artist.clone()),
        ("track_name", title.clone()),
    ];
    if let Some(album) = track.album.as_deref().filter(|album| !album.trim().is_empty()) {
        exact.push(("album_name", album.to_string()));
    }
    let seconds = track.duration_ms / 1000;
    if seconds > 0 {
        exact.push(("duration", seconds.to_string()));
    }

    if let Some(found) = lrclib_one(&format!("{LRCLIB}/get"), &exact)? {
        if found.has_lyrics() {
            return Ok(Some(found));
        }
    }

    let search: Vec<(&str, String)> = vec![
        ("artist_name", artist),
        ("track_name", title.clone()),
    ];
    let results = lrclib_list(&format!("{LRCLIB}/search"), &search)?;

    // A result whose title matches exactly is the one to trust; otherwise the
    // first that has any lyrics at all.
    let wanted = title.to_lowercase();
    Ok(results
        .iter()
        .find(|found| found.has_lyrics() && found.track_name.to_lowercase() == wanted)
        .or_else(|| results.iter().find(|found| found.has_lyrics()))
        .cloned())
}

/// Plain lyrics, with the artist and title as path segments.
fn lyrics_ovh(track: &Track) -> Result<Option<Found>, String> {
    let artist = track.artist.clone().unwrap_or_default();
    let url = format!(
        "https://api.lyrics.ovh/v1/{}/{}",
        encode(&artist),
        encode(&track.title)
    );

    let response = send(&url, &[], AGENT, None)?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("refused the lookup ({})", response.status().as_u16()));
    }

    #[derive(Deserialize, Default)]
    struct Reply {
        #[serde(default)]
        lyrics: String,
    }

    let body = response.text().unwrap_or_default();
    let reply: Reply =
        serde_json::from_str(&body).map_err(|e| format!("sent an odd reply: {e}"))?;

    Ok(Some(Found {
        plain_lyrics: clean_plain(&reply.lyrics),
        ..Found::default()
    }))
}

/// Search for the song, then ask for its lyrics.
fn netease(track: &Track) -> Result<Option<Found>, String> {
    let artist = track.artist.clone().unwrap_or_default();

    let search = netease_get(
        "https://music.163.com/api/search/get",
        &[
            ("s", format!("{artist} {}", track.title)),
            ("type", "1".to_string()),
            ("offset", "0".to_string()),
            ("limit", "5".to_string()),
        ],
    )?;
    if !search.status().is_success() {
        return Err(format!("refused the search ({})", search.status().as_u16()));
    }

    let body = search.text().unwrap_or_default();
    let found: NetEaseSearch =
        serde_json::from_str(&body).map_err(|e| format!("sent an odd reply: {e}"))?;

    let wanted = track.title.to_lowercase();
    let song = found
        .result
        .songs
        .iter()
        .find(|song| song.name.to_lowercase() == wanted)
        .or_else(|| found.result.songs.first());
    let Some(song) = song else {
        return Ok(None);
    };

    let lyric = netease_get(
        "https://music.163.com/api/song/lyric",
        &[
            ("id", song.id.to_string()),
            ("lv", "1".to_string()),
            ("kv", "1".to_string()),
            ("tv", "-1".to_string()),
        ],
    )?;
    if !lyric.status().is_success() {
        return Err(format!("refused the lyrics ({})", lyric.status().as_u16()));
    }

    let body = lyric.text().unwrap_or_default();
    let found: NetEaseLyric =
        serde_json::from_str(&body).map_err(|e| format!("sent an odd reply: {e}"))?;
    let text = found.lrc.lyric.trim();
    if text.is_empty() {
        return Ok(None);
    }

    // It usually sends timings, but not always.
    Ok(Some(if is_timed(text) {
        Found {
            synced_lyrics: text.to_string(),
            ..Found::default()
        }
    } else {
        Found {
            plain_lyrics: text.to_string(),
            ..Found::default()
        }
    }))
}

#[derive(Deserialize, Default)]
struct NetEaseSearch {
    #[serde(default)]
    result: NetEaseResult,
}

#[derive(Deserialize, Default)]
struct NetEaseResult {
    #[serde(default)]
    songs: Vec<NetEaseSong>,
}

#[derive(Deserialize, Default)]
struct NetEaseSong {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize, Default)]
struct NetEaseLyric {
    #[serde(default)]
    lrc: NetEaseLines,
}

#[derive(Deserialize, Default)]
struct NetEaseLines {
    #[serde(default)]
    lyric: String,
}

fn netease_get(url: &str, params: &[(&str, String)]) -> Result<reqwest::blocking::Response, String> {
    send(url, params, BROWSER_AGENT, Some("https://music.163.com"))
}

/// True when the text carries `[mm:ss]` style timings. NetEase mixes in tags
/// such as `[by:someone]`, which are not timings.
fn is_timed(text: &str) -> bool {
    text.lines().any(|line| {
        let Some(rest) = line.trim_start().strip_prefix('[') else {
            return false;
        };
        let Some((tag, _)) = rest.split_once(']') else {
            return false;
        };
        tag.contains(':') && tag.chars().all(|c| c.is_ascii_digit() || c == ':' || c == '.')
    })
}

/// lyrics.ovh opens with a French header line, which is not part of the song.
fn clean_plain(raw: &str) -> String {
    let mut lines: Vec<&str> = raw.lines().collect();

    while lines.first().is_some_and(|line| {
        let line = line.trim();
        line.is_empty() || line.to_lowercase().starts_with("paroles de la chanson")
    }) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }

    lines.join("\n")
}

fn lrclib_one(url: &str, params: &[(&str, String)]) -> Result<Option<Found>, String> {
    let response = send(url, params, AGENT, None)?;

    // A miss is an answer rather than a failure.
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("refused the lookup ({})", response.status().as_u16()));
    }

    let body = response.text().unwrap_or_default();
    serde_json::from_str(&body)
        .map(Some)
        .map_err(|e| format!("sent an odd reply: {e}"))
}

fn lrclib_list(url: &str, params: &[(&str, String)]) -> Result<Vec<Found>, String> {
    let response = send(url, params, AGENT, None)?;
    if !response.status().is_success() {
        return Err(format!("refused the search ({})", response.status().as_u16()));
    }

    let body = response.text().unwrap_or_default();
    serde_json::from_str(&body).map_err(|e| format!("sent an odd reply: {e}"))
}

fn send(
    url: &str,
    params: &[(&str, String)],
    agent: &str,
    referer: Option<&str>,
) -> Result<reqwest::blocking::Response, String> {
    let mut request = client()
        .get(url)
        .query(params)
        .header(reqwest::header::USER_AGENT, agent);

    if let Some(referer) = referer {
        request = request.header(reqwest::header::REFERER, referer);
    }

    request.send().map_err(|e| format!("could not be reached: {e}"))
}

fn summary(outcome: &LyricsOutcome) -> String {
    let mut parts = vec![format!("{} found", outcome.fetched)];
    if outcome.synced > 0 {
        parts.push(format!("{} with timings", outcome.synced));
    }
    if outcome.skipped > 0 {
        parts.push(format!("{} already had lyrics", outcome.skipped));
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

/// Looks lyrics up for the given songs. Runs on a blocking thread: the HTTP
/// client parks the calling thread, which is not allowed on a runtime worker.
#[tauri::command]
pub async fn fetch_lyrics(app: AppHandle, track_ids: Vec<String>) -> Result<LyricsOutcome, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || run(&handle, &track_ids))
        .await
        .map_err(|e| format!("the lyrics fetch stopped unexpectedly: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_a_result_with_either_kind_of_lyrics() {
        let plain = Found {
            plain_lyrics: "words".to_string(),
            ..Found::default()
        };
        assert!(plain.has_lyrics());

        let synced = Found {
            synced_lyrics: "[00:01.00]words".to_string(),
            ..Found::default()
        };
        assert!(synced.has_lyrics());

        // Whitespace is not lyrics.
        let empty = Found {
            plain_lyrics: "   ".to_string(),
            synced_lyrics: "\n".to_string(),
            ..Found::default()
        };
        assert!(!empty.has_lyrics());
    }

    #[test]
    fn tells_timings_apart_from_other_tags() {
        assert!(is_timed("[00:12.34] words"));
        assert!(is_timed("[by:someone]\n[01:02] words"));
        // A metadata tag alone is not a timing.
        assert!(!is_timed("[by:someone]\nwords"));
        assert!(!is_timed("just words"));
    }

    #[test]
    fn drops_the_header_lyrics_ovh_prefixes() {
        let raw = "\r\nParoles de la chanson Hey Jude par The Beatles\r\n\r\nHey Jude, don't make it bad\r\n\r\n";
        assert_eq!(clean_plain(raw), "Hey Jude, don't make it bad");

        // Text without the header is left alone.
        assert_eq!(clean_plain("  one\n\ntwo\n"), "  one\n\ntwo");
    }

    #[test]
    fn sums_up_what_happened() {
        let outcome = LyricsOutcome {
            fetched: 10,
            synced: 8,
            skipped: 2,
            missing: 1,
            untagged: 0,
            errors: vec![],
        };
        assert_eq!(
            summary(&outcome),
            "10 found, 8 with timings, 2 already had lyrics, 1 not found"
        );
    }
}
