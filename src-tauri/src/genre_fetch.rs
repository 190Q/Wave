use std::collections::HashMap;
use std::path::Path;
use std::thread::sleep;
use std::time::Duration;

use lofty::config::WriteOptions;
use lofty::prelude::{Accessor, TagExt, TaggedFileExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::catalog::Catalog;
use crate::library::{self, track_label, Track};
use crate::progress::Reporter;
use crate::source::{client, retry_after, wait_phrase, TrackMeta};

/// Follows one genre pass, song by song.
pub const PROGRESS_EVENT: &str = "genres-fetch";

/// The first pause between lookups, so a handful of songs is over quickly.
const DELAY_START_MS: u64 = 500;

/// The slowest the pace is allowed to fall to. iTunes allows about twenty
/// lookups a minute, so a pass that has been pushed back keeps under that.
const DELAY_CEILING_MS: u64 = 3_500;

/// The first wait after the service asks the pass to slow down.
const BACKOFF_START_MS: u64 = 5_000;

/// The longest one wait is allowed to grow to.
const BACKOFF_CEILING_MS: u64 = 300_000;

/// How many waits in a row one song is worth before the pass ends. Past this
/// the service is not going to answer, and the rest are left for another run.
const LIMIT_TOLERANCE: usize = 8;

/// How many refusals in a row end a pass, leaving the rest for another run.
const REFUSAL_LIMIT: usize = 3;

const ITUNES: &str = "https://itunes.apple.com/search";

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenresOutcome {
    /// Looked up and written into the file.
    pub tagged: usize,
    /// Already carried a genre, so they were left alone.
    pub skipped: usize,
    /// The service had nothing for them.
    pub missing: usize,
    /// No artist tag to look them up by.
    pub untagged: usize,
    /// How many times the pass waited the service out instead of moving on.
    pub paused: usize,
    /// The pass stopped early rather than working through everything.
    pub gave_up: bool,
    /// Songs the pass never reached, because it stopped early.
    pub remaining: usize,
    pub errors: Vec<String>,
}

/// One iTunes song result.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct Entry {
    #[serde(rename = "primaryGenreName")]
    genre: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct Reply {
    results: Vec<Entry>,
}

/// What one lookup came back with.
#[derive(Debug, Clone, PartialEq)]
enum Answer {
    /// The genre of the first match.
    Genre(String),
    /// The service had nothing for it.
    Nothing,
    /// The service asked the pass to slow down, and said how long for.
    RateLimited(Option<u64>),
    /// Anything else went wrong, and it belongs to this song alone.
    Refused(String),
}

fn look_up(artist: &str, title: &str) -> Answer {
    let response = match client()
        .get(ITUNES)
        .query(&[
            ("term", format!("{artist} {title}")),
            ("media", "music".to_string()),
            ("entity", "song".to_string()),
            ("limit", "1".to_string()),
        ])
        .send()
    {
        Ok(response) => response,
        Err(error) => return Answer::Refused(format!("iTunes could not be reached: {error}")),
    };

    let status = response.status();
    // The headers have to be read before the body takes the response over.
    let retry = retry_after(&response);
    if !status.is_success() {
        return classify(status.as_u16(), retry);
    }

    match genre_in(&response.text().unwrap_or_default()) {
        Ok(Some(genre)) => Answer::Genre(genre),
        Ok(None) => Answer::Nothing,
        Err(error) => Answer::Refused(error),
    }
}

/// A refusal that is only a matter of pace is a wait, not a failure.
fn classify(status: u16, retry: Option<u64>) -> Answer {
    match status {
        429 => Answer::RateLimited(retry),
        _ => Answer::Refused(format!("iTunes refused the search ({status})")),
    }
}

fn wait_for(retry: Option<u64>, backoff_ms: u64) -> u64 {
    let asked = retry
        .map(|seconds| seconds.saturating_mul(1_000))
        .unwrap_or(0);
    asked.max(backoff_ms).min(BACKOFF_CEILING_MS)
}

struct Pace {
    delay_ms: u64,
    /// How many times the service has pushed back, over the whole pass.
    waits: usize,
}

impl Default for Pace {
    fn default() -> Self {
        Self {
            delay_ms: DELAY_START_MS,
            waits: 0,
        }
    }
}

impl Pace {
    /// The pause after a lookup that landed.
    fn pause(&self) {
        sleep(Duration::from_millis(self.delay_ms));
    }

    /// The service pushed back, so the pass keeps a slower pace from here.
    fn slower(&mut self) {
        self.delay_ms = (self.delay_ms * 2).min(DELAY_CEILING_MS);
    }
}

/// Why a song's genre could not be settled.
enum Stop {
    /// The service kept pushing back, so the pass ends and the rest wait.
    Throttled,
    /// Something else went wrong, and it belongs to this song alone.
    Refused(String),
}

fn look_up_patiently(
    artist: &str,
    title: &str,
    pace: &mut Pace,
    mut tell: impl FnMut(&str),
) -> Result<Option<String>, Stop> {
    let mut backoff = BACKOFF_START_MS;
    // Counted per song: a pass that is refused now and then carries on.
    let mut waited = 0;

    loop {
        match look_up(artist, title) {
            Answer::Genre(genre) => return Ok(Some(genre)),
            Answer::Nothing => return Ok(None),
            Answer::Refused(error) => return Err(Stop::Refused(error)),
            Answer::RateLimited(retry) => {
                waited += 1;
                if waited > LIMIT_TOLERANCE {
                    return Err(Stop::Throttled);
                }

                let wait = wait_for(retry, backoff);
                tell(&format!(
                    "iTunes is limiting how often this can ask. Trying again {}. \
                     The pass will carry on from here.",
                    wait_phrase(wait.div_ceil(1_000)),
                ));
                pace.waits += 1;
                pace.slower();
                sleep(Duration::from_millis(wait));
                backoff = (backoff * 2).min(BACKOFF_CEILING_MS);
            }
        }
    }
}

/// The genre of the first match in a search reply, if it gave one.
fn genre_in(body: &str) -> Result<Option<String>, String> {
    let reply: Reply =
        serde_json::from_str(body).map_err(|e| format!("iTunes sent an odd reply: {e}"))?;

    Ok(reply
        .results
        .first()
        .map(|entry| entry.genre.trim().to_string())
        .filter(|genre| !genre.is_empty()))
}

/// Puts the genre into the file's own tags, keeping everything else.
pub fn write_genre(path: &str, genre: &str) -> Result<(), String> {
    let path = Path::new(path);

    // The tag is cloned out so the reader is closed before the file is written.
    let mut tag = {
        let tagged = lofty::read_from_path(path)
            .map_err(|e| format!("could not read {}: {e}", path.display()))?;
        tagged
            .primary_tag()
            .cloned()
            .ok_or_else(|| format!("{} carries no tags to write a genre into", path.display()))?
    };

    tag.set_genre(genre.to_string());
    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("could not write a genre into {}: {e}", path.display()))
}

#[derive(Default)]
struct Breaker {
    refusals: usize,
}

impl Breaker {
    fn ok(&mut self) {
        self.refusals = 0;
    }

    /// Records a refusal, and says whether that was one too many.
    fn refused(&mut self) -> bool {
        self.refusals += 1;
        self.refusals >= REFUSAL_LIMIT
    }
}

/// Looks up a genre for every track it is handed, and says how many landed.
pub fn fill<'a>(
    report: Option<&mut Reporter>,
    tracks: impl IntoIterator<Item = &'a mut TrackMeta>,
) -> usize {
    let mut report = report;
    let mut breaker = Breaker::default();
    let mut pace = Pace::default();
    let mut filled = 0;

    for (position, meta) in tracks.into_iter().enumerate() {
        if !meta.genres.is_empty() {
            continue;
        }

        let artist = meta.artists.join(", ");
        if artist.trim().is_empty() {
            continue;
        }

        if let Some(report) = report.as_deref_mut() {
            report.at(position + 1, &format!("{artist} - {}", meta.title));
        }

        let answer = look_up_patiently(&artist, &meta.title, &mut pace, |line| {
            if let Some(report) = report.as_deref_mut() {
                report.phase("genres", line);
            }
        });

        match answer {
            Ok(Some(genre)) => {
                meta.genres = vec![genre];
                filled += 1;
                breaker.ok();
            }
            Ok(None) => breaker.ok(),
            Err(Stop::Throttled) => break,
            Err(Stop::Refused(_)) => {
                if breaker.refused() {
                    break;
                }
            }
        }

        pace.pause();
    }

    filled
}

fn run(app: &AppHandle, track_ids: &[String]) -> Result<GenresOutcome, String> {
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
) -> Result<GenresOutcome, String> {
    let catalog = app.state::<Catalog>();

    let by_id: HashMap<String, Track> = library::scan(app, &catalog)
        .tracks
        .into_iter()
        .map(|track| (track.id.clone(), track))
        .collect();

    let wanted: Vec<Track> = track_ids
        .iter()
        .filter_map(|id| by_id.get(id).cloned())
        .collect();
    if wanted.is_empty() {
        return Err("there is nothing in that collection to look genres up for".to_string());
    }

    report.phase(
        "genres",
        &format!("Looking up genres for {} songs.", wanted.len()),
    );
    report.count(wanted.len());

    let mut outcome = GenresOutcome::default();
    let mut breaker = Breaker::default();
    let mut pace = Pace::default();

    for (position, track) in wanted.iter().enumerate() {
        let label = track_label(track);
        report.at(position + 1, &label);

        // A song that already carries a genre is left exactly as it is.
        if track.genre.is_some() {
            outcome.skipped += 1;
            continue;
        }

        // Without an artist there is nothing to match on.
        let artist = track.artist.as_deref().unwrap_or_default().trim().to_string();
        if artist.is_empty() {
            outcome.untagged += 1;
            continue;
        }

        let answer = look_up_patiently(&artist, &track.title, &mut pace, |line| {
            report.phase("genres", line);
        });

        match answer {
            Ok(Some(genre)) => match write_genre(&track.path, &genre) {
                Ok(()) => {
                    outcome.tagged += 1;
                    breaker.ok();
                }
                Err(error) => {
                    outcome.errors.push(format!("{label}: {error}"));
                    report.fail(format!("{label}: {error}"));
                    breaker.ok();
                }
            },
            Ok(None) => {
                outcome.missing += 1;
                breaker.ok();
            }
            Err(Stop::Throttled) => {
                outcome.gave_up = true;
                break;
            }
            Err(Stop::Refused(error)) => {
                outcome.errors.push(format!("{label}: {error}"));
                report.fail(format!("{label}: {error}"));
                if breaker.refused() {
                    outcome.gave_up = true;
                    break;
                }
            }
        }

        pace.pause();
    }

    outcome.paused = pace.waits;
    let handled = outcome.tagged
        + outcome.skipped
        + outcome.missing
        + outcome.untagged
        + outcome.errors.len();
    outcome.remaining = wanted.len().saturating_sub(handled);

    Ok(outcome)
}

fn summary(outcome: &GenresOutcome) -> String {
    let mut parts = vec![format!("{} tagged", outcome.tagged)];
    if outcome.skipped > 0 {
        parts.push(format!("{} already had genres", outcome.skipped));
    }
    if outcome.untagged > 0 {
        parts.push(format!("{} with no artist tag", outcome.untagged));
    }
    if outcome.missing > 0 {
        parts.push(format!("{} not found", outcome.missing));
    }
    if outcome.paused > 0 {
        parts.push(format!("waited out the rate limit {} times", outcome.paused));
    }
    if !outcome.errors.is_empty() {
        parts.push(format!("{} failed", outcome.errors.len()));
    }
    if outcome.gave_up {
        parts.push(match outcome.remaining {
            0 => "stopped early".to_string(),
            left => format!("stopped early, {left} still without a genre"),
        });
    }
    parts.join(", ")
}

/// Writes the genre of the given songs into their files.
#[tauri::command]
pub async fn fetch_genres(
    app: AppHandle,
    track_ids: Vec<String>,
) -> Result<GenresOutcome, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || run(&handle, &track_ids))
        .await
        .map_err(|e| format!("the genre lookup stopped unexpectedly: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_genre_of_the_first_match() {
        let body = r#"{
            "resultCount": 2,
            "results": [
                { "trackName": "Hey Jude", "primaryGenreName": "Rock" },
                { "trackName": "Hey Jude", "primaryGenreName": "Pop" }
            ]
        }"#;

        assert_eq!(genre_in(body).unwrap().as_deref(), Some("Rock"));
    }

    #[test]
    fn a_reply_with_nothing_in_it_is_no_genre() {
        assert_eq!(genre_in(r#"{ "resultCount": 0, "results": [] }"#).unwrap(), None);
        // A song iTunes has not classified carries an empty term.
        let unclassified = r#"{ "results": [ { "primaryGenreName": "  " } ] }"#;
        assert_eq!(genre_in(unclassified).unwrap(), None);
        // The field can be absent altogether.
        assert_eq!(genre_in(r#"{ "results": [ { "trackName": "x" } ] }"#).unwrap(), None);
    }

    #[test]
    fn an_unreadable_reply_is_an_error() {
        assert!(genre_in("not json").is_err());
    }

    #[test]
    fn a_pass_gives_up_after_a_run_of_refusals() {
        let mut breaker = Breaker::default();

        for _ in 1..REFUSAL_LIMIT {
            assert!(!breaker.refused());
        }
        assert!(breaker.refused());

        // A lookup that lands resets the run, so scattered refusals never add up.
        breaker.ok();
        assert!(!breaker.refused());
    }

    #[test]
    fn fills_only_the_tracks_that_carry_no_genre() {
        let mut tracks = vec![
            TrackMeta {
                title: "Already Tagged".to_string(),
                artists: vec!["Someone".to_string()],
                genres: vec!["Jazz".to_string()],
                ..TrackMeta::default()
            },
            // No artist, so there is nothing to look up.
            TrackMeta {
                title: "Untagged".to_string(),
                ..TrackMeta::default()
            },
        ];

        assert_eq!(fill(None, &mut tracks), 0);
        assert_eq!(tracks[0].genres, vec!["Jazz"]);
        assert!(tracks[1].genres.is_empty());
    }

    #[test]
    fn a_rate_limit_is_a_wait_rather_than_a_failure() {
        assert_eq!(classify(429, Some(30)), Answer::RateLimited(Some(30)));
        // A limit with no `Retry-After` is still a wait.
        assert_eq!(classify(429, None), Answer::RateLimited(None));
        // Anything else is the song's own problem, and is reported as such.
        let refused = classify(500, None);
        assert!(matches!(refused, Answer::Refused(message) if message.contains("500")));
    }

    #[test]
    fn the_wait_is_the_longer_of_what_was_asked_and_the_backoff() {
        // A service that says nothing still gets the backoff.
        assert_eq!(wait_for(None, BACKOFF_START_MS), BACKOFF_START_MS);
        // A service that asks for longer than the backoff is taken at its word.
        assert_eq!(wait_for(Some(30), BACKOFF_START_MS), 30_000);
        // A backoff that has outgrown the answer is not cut short by it.
        assert_eq!(wait_for(Some(2), 20_000), 20_000);
        // Neither can hold the pass up for longer than the ceiling.
        assert_eq!(wait_for(Some(3_600), BACKOFF_START_MS), BACKOFF_CEILING_MS);
    }

    #[test]
    fn a_pass_slows_down_when_the_service_pushes_back() {
        let mut pace = Pace::default();
        assert_eq!(pace.delay_ms, DELAY_START_MS);

        // The pace keeps giving way, and settles at one the service will take.
        for _ in 0..20 {
            pace.slower();
        }
        assert_eq!(pace.delay_ms, DELAY_CEILING_MS);
        assert!(60_000 / pace.delay_ms <= 20, "the ceiling is under twenty a minute");
    }

    #[test]
    fn sums_up_what_happened() {
        let outcome = GenresOutcome {
            tagged: 5,
            skipped: 40,
            missing: 1,
            untagged: 0,
            paused: 0,
            gave_up: false,
            remaining: 0,
            errors: vec![],
        };
        assert_eq!(summary(&outcome), "5 tagged, 40 already had genres, 1 not found");

        let stopped = GenresOutcome {
            tagged: 2,
            skipped: 0,
            missing: 0,
            untagged: 1,
            paused: 3,
            gave_up: true,
            remaining: 12,
            errors: vec!["x: iTunes refused the search (500)".to_string()],
        };
        assert_eq!(
            summary(&stopped),
            "2 tagged, 1 with no artist tag, waited out the rate limit 3 times, 1 failed, \
             stopped early, 12 still without a genre"
        );
    }
}
