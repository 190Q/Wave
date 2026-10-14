use std::collections::HashMap;
use std::path::Path;
use std::thread::sleep;
use std::time::Duration;

use lofty::config::WriteOptions;
use lofty::prelude::{Accessor, TagExt, TaggedFileExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::library::{self, track_label, Track, TrackPaths};
use crate::progress::Reporter;
use crate::spotify::{client, TrackMeta};

/// Follows one genre pass, song by song.
pub const PROGRESS_EVENT: &str = "genres-fetch";

/// A pause between lookups so the API is not hammered, matching the script.
pub const DELAY_MS: u64 = 500;

/// How many refusals in a row end a pass, leaving the rest for the next one.
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
    /// The pass gave up on a run of refusals; the rest wait for the next one.
    pub gave_up: bool,
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

pub fn look_up(artist: &str, title: &str) -> Result<Option<String>, String> {
    let response = client()
        .get(ITUNES)
        .query(&[
            ("term", format!("{artist} {title}")),
            ("media", "music".to_string()),
            ("entity", "song".to_string()),
            ("limit", "1".to_string()),
        ])
        .send()
        .map_err(|e| format!("iTunes could not be reached: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "iTunes refused the search ({})",
            response.status().as_u16()
        ));
    }

    genre_in(&response.text().unwrap_or_default())
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

pub fn fill(report: Option<&mut Reporter>, tracks: &mut [TrackMeta]) -> usize {
    let mut report = report;
    let mut breaker = Breaker::default();
    let mut filled = 0;

    for (position, meta) in tracks.iter_mut().enumerate() {
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

        match look_up(&artist, &meta.title) {
            Ok(Some(genre)) => {
                meta.genres = vec![genre];
                filled += 1;
                breaker.ok();
            }
            Ok(None) => breaker.ok(),
            Err(_) => {
                if breaker.refused() {
                    break;
                }
            }
        }

        sleep(Duration::from_millis(DELAY_MS));
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
        return Err("there is nothing in that collection to look genres up for".to_string());
    }

    report.phase(
        "genres",
        &format!("Looking up genres for {} songs.", wanted.len()),
    );
    report.count(wanted.len());

    let mut outcome = GenresOutcome::default();
    let mut breaker = Breaker::default();

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

        match look_up(&artist, &track.title) {
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
            Err(error) => {
                outcome.errors.push(format!("{label}: {error}"));
                report.fail(format!("{label}: {error}"));
                if breaker.refused() {
                    outcome.gave_up = true;
                    break;
                }
            }
        }

        sleep(Duration::from_millis(DELAY_MS));
    }

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
    if !outcome.errors.is_empty() {
        parts.push(format!("{} failed", outcome.errors.len()));
    }
    if outcome.gave_up {
        parts.push("stopped early, the rest are left for next time".to_string());
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
    fn sums_up_what_happened() {
        let outcome = GenresOutcome {
            tagged: 5,
            skipped: 40,
            missing: 1,
            untagged: 0,
            gave_up: false,
            errors: vec![],
        };
        assert_eq!(summary(&outcome), "5 tagged, 40 already had genres, 1 not found");

        let stopped = GenresOutcome {
            tagged: 2,
            skipped: 0,
            missing: 0,
            untagged: 1,
            gave_up: true,
            errors: vec!["x: iTunes refused the search (429)".to_string()],
        };
        assert_eq!(
            summary(&stopped),
            "2 tagged, 1 with no artist tag, 1 failed, stopped early, the rest are left for next time"
        );
    }
}
