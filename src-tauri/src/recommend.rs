use std::collections::{HashMap, HashSet};
use std::thread::sleep;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::analytics::{Affinity, Analytics, RecommendationSeeds, TrackAffinity};
use crate::catalog::Catalog;
use crate::deezer;
use crate::import_source;
use crate::playlists;
use crate::progress::Reporter;
use crate::source::TrackMeta;
use crate::state::{PendingTrack, PersistedState, Store};

/// Follows one generation, phase by phase.
pub const PROGRESS_EVENT: &str = "playlist-generate";

/// Where the waiting songs say they came from.
const SOURCE: &str = "deezer";

/// How many songs a generated playlist holds.
const KEEP: usize = 50;

/// The Wave Swell marks, which decide whether there is enough to go on.
const MIN_STREAMS: i64 = 20;
const MIN_MS: i64 = 30 * 60_000;

/// How much of the listening record is read.
const SEEDS: usize = 50;

/// The loved artists a playlist is built from, and how many songs each offers.
const TOP_ARTISTS: usize = 5;
const ARTIST_TRACKS: usize = 20;

/// The artists beside the loved ones, which is where new music comes from.
const RELATED_ARTISTS: usize = 3;
const RELATED_TRACKS: usize = 10;

/// How many of the record's genres are charted.
const TOP_GENRES: usize = 3;

/// The pause between Deezer calls, so a run of them does not read as a flood.
const PACE_MS: u64 = 150;

/// What a song from a loved artist, or from the chart the user asked for, is
/// worth.
const WANTED: f64 = 1.0;
/// And one from an artist beside a loved one, or a genre the record leans on.
const BESIDE: f64 = 0.5;

/// A genre says less about one song than the artist does.
const GENRE_WEIGHT: f64 = 0.6;

/// A song the library already holds is still a song, but a new one is worth
/// more.
const HELD_PENALTY: f64 = 0.4;
/// A song the library holds and was liked is worth keeping.
const LIKED_BONUS: f64 = 0.3;

const MAX_PER_ARTIST: usize = 3;
const MAX_PER_ALBUM: usize = 2;
const MAX_HELD: usize = 5;

/// Whether the sheet offers generation at all, and how far off it is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendStatus {
    pub enough: bool,
    pub plays: i64,
    pub artists: i64,
    /// The one line the sheet shows while generation is not offered.
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateOutcome {
    pub playlist_id: String,
    pub state: PersistedState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Taste,
    Genre,
}

impl Mode {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "taste" => Ok(Mode::Taste),
            "genre" => Ok(Mode::Genre),
            other => Err(format!("{other} is not a way to build a playlist")),
        }
    }
}

struct Taste {
    /// The artists the record leans on, most first.
    artists: Vec<(String, f64)>,
    genres: Vec<(String, f64)>,
    /// Songs abandoned early, by title and artist.
    skipped: HashSet<String>,
    /// Liked songs, by title and artist.
    liked: HashSet<String>,
}

impl Taste {
    fn of(seeds: &RecommendationSeeds) -> Self {
        let by_id: HashMap<&str, &TrackAffinity> = seeds
            .tracks
            .iter()
            .map(|track| (track.track_id.as_str(), track))
            .collect();

        let keys = |ids: &[String]| -> HashSet<String> {
            ids.iter()
                .filter_map(|id| by_id.get(id.as_str()))
                .map(|track| song_key(&track.title, track.artist.as_deref().unwrap_or_default()))
                .collect()
        };

        Self {
            artists: affinity(&seeds.artists),
            genres: affinity(&seeds.genres),
            skipped: keys(&seeds.skipped),
            liked: keys(&seeds.liked),
        }
    }

    fn artist(&self, name: &str) -> f64 {
        score_of(&self.artists, name)
    }

    fn genre(&self, genres: &[String]) -> f64 {
        genres
            .iter()
            .map(|name| score_of(&self.genres, name))
            .fold(0.0, f64::max)
    }
}

/// One Deezer song, with what the ranking needs to judge it.
#[derive(Debug, Clone)]
struct Candidate {
    id: String,
    title: String,
    artists: Vec<String>,
    album: String,
    genres: Vec<String>,
    cover_url: Option<String>,
    isrc: String,
    release_date: String,
    track_number: Option<u32>,
    disc_number: Option<u32>,
    /// What the pool it came from is worth.
    weight: f64,
    /// The library already holds this song.
    held: bool,
}

impl Candidate {
    fn artist(&self) -> String {
        self.artists.first().cloned().unwrap_or_default()
    }

    fn key(&self) -> String {
        song_key(&self.title, &self.artist())
    }

    fn meta(&self) -> TrackMeta {
        TrackMeta {
            title: self.title.clone(),
            artists: self.artists.clone(),
            album: self.album.clone(),
            genres: self.genres.clone(),
            isrc: self.isrc.clone(),
            cover_url: self.cover_url.clone(),
            release_date: self.release_date.clone(),
            track_number: self.track_number,
            disc_number: self.disc_number,
            ..TrackMeta::default()
        }
    }

    fn score(&self, taste: &Taste) -> f64 {
        let affinity = taste.artist(&self.artist()) + GENRE_WEIGHT * taste.genre(&self.genres);
        let mut score = self.weight * (1.0 + affinity);
        if taste.liked.contains(&self.key()) {
            score += LIKED_BONUS;
        }
        if self.held {
            score -= HELD_PENALTY;
        }
        score
    }
}

fn rank(taste: &Taste, candidates: Vec<Candidate>) -> Vec<Candidate> {
    let mut scored: Vec<(f64, Candidate)> = dedupe(candidates)
        .into_iter()
        .filter(|candidate| !taste.skipped.contains(&candidate.key()))
        .map(|candidate| (candidate.score(taste), candidate))
        .collect();

    // Ties are broken by name, so the same record always picks the same songs.
    scored.sort_by(|(left, a), (right, b)| {
        right
            .partial_cmp(left)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| fold(&a.artist()).cmp(&fold(&b.artist())))
            .then_with(|| fold(&a.title).cmp(&fold(&b.title)))
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut artists: HashMap<String, usize> = HashMap::new();
    let mut albums: HashMap<String, usize> = HashMap::new();
    let mut held = 0usize;
    let mut kept = Vec::new();

    for (_, candidate) in scored {
        if kept.len() >= KEEP {
            break;
        }
        if candidate.held && held >= MAX_HELD {
            continue;
        }

        let artist = fold(&candidate.artist());
        let album = format!("{}\u{1}{}", artist, fold(&candidate.album));
        if artists.get(&artist).copied().unwrap_or(0) >= MAX_PER_ARTIST {
            continue;
        }
        if albums.get(&album).copied().unwrap_or(0) >= MAX_PER_ALBUM {
            continue;
        }

        *artists.entry(artist).or_default() += 1;
        *albums.entry(album).or_default() += 1;
        if candidate.held {
            held += 1;
        }
        kept.push(candidate);
    }

    kept
}

/// The same song offered by two pools counts once, at the higher weight.
fn dedupe(candidates: Vec<Candidate>) -> Vec<Candidate> {
    let mut best: HashMap<String, Candidate> = HashMap::new();

    for candidate in candidates {
        match best.get(&candidate.id) {
            Some(saved) if saved.weight >= candidate.weight => {}
            _ => {
                best.insert(candidate.id.clone(), candidate);
            }
        }
    }

    let mut found: Vec<Candidate> = best.into_values().collect();
    found.sort_by(|a, b| a.id.cmp(&b.id));
    found
}

fn affinity(rows: &[Affinity]) -> Vec<(String, f64)> {
    let top = rows.first().map(|row| row.score).unwrap_or(0.0);
    if top <= 0.0 {
        return Vec::new();
    }
    rows.iter()
        .map(|row| (row.name.clone(), row.score / top))
        .collect()
}

fn score_of(rows: &[(String, f64)], name: &str) -> f64 {
    let wanted = fold(name);
    rows.iter()
        .find(|(saved, _)| fold(saved) == wanted)
        .map(|(_, score)| *score)
        .unwrap_or(0.0)
}

fn fold(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn song_key(title: &str, artist: &str) -> String {
    import_source::track_key(title, artist, "")
}

/// How the listening record stands against the Wave Swell marks.
fn marks(app: &AppHandle) -> (i64, i64, i64) {
    let analytics = app.state::<Analytics>();
    match analytics.swell(0, crate::identity::now_ms(), "month") {
        Ok(summary) => (summary.plays, summary.ms_listened, summary.unique_artists),
        Err(_) => (0, 0, 0),
    }
}

/// How far off the marks the record is, said the way the Swell pane says it.
fn short_of(plays: i64, ms: i64) -> String {
    let by_plays = plays as f64 / MIN_STREAMS as f64;
    let by_time = ms as f64 / MIN_MS as f64;
    if by_plays >= by_time {
        format!("{plays} of {MIN_STREAMS} plays")
    } else {
        format!("{} of 30 minutes", (ms as f64 / 60_000.0).round() as i64)
    }
}

#[tauri::command(async)]
pub fn recommend_status(app: AppHandle) -> RecommendStatus {
    let (plays, ms, artists) = marks(&app);
    let enough = plays >= MIN_STREAMS || ms >= MIN_MS;

    RecommendStatus {
        enough,
        plays,
        artists,
        note: if enough {
            String::new()
        } else {
            short_of(plays, ms)
        },
    }
}

#[tauri::command]
pub async fn generate_playlist(
    app: AppHandle,
    mode: String,
    genre: Option<String>,
) -> Result<GenerateOutcome, String> {
    let mode = Mode::parse(&mode)?;
    let genre = genre
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if mode == Mode::Genre && genre.is_none() {
        return Err("a genre playlist needs a genre".to_string());
    }

    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || generate(&handle, mode, genre))
        .await
        .map_err(|e| format!("the generation stopped unexpectedly: {e}"))?
}

fn generate(app: &AppHandle, mode: Mode, genre: Option<String>) -> Result<GenerateOutcome, String> {
    let mut report = Reporter::new(app, PROGRESS_EVENT);

    match generate_inner(app, mode, genre.as_deref(), &mut report) {
        Ok(outcome) => Ok(outcome),
        Err(error) => {
            report.phase("failed", &error);
            Err(error)
        }
    }
}

fn generate_inner(
    app: &AppHandle,
    mode: Mode,
    genre: Option<&str>,
    report: &mut Reporter,
) -> Result<GenerateOutcome, String> {
    report.phase("taste", "Reading your listening record.");

    if mode == Mode::Taste {
        let (plays, ms, _) = marks(app);
        if plays < MIN_STREAMS && ms < MIN_MS {
            return Err("there is not enough listening to build a playlist from yet".to_string());
        }
    }

    let seeds = app.state::<Analytics>().recommendation_seeds(SEEDS)?;
    let taste = Taste::of(&seeds);

    report.phase("catalogue", "Looking for songs on Deezer.");
    let catalog = app.state::<Catalog>();
    let held = import_source::catalog_index(&catalog)?;
    let genres = ask(report, "catalogue", "Reading Deezer's genres.", deezer::genres)
        .unwrap_or_default();

    let pool = pool(mode, genre, &taste, &genres, &held, report);
    if pool.is_empty() {
        return Err(match genre {
            Some(genre) => format!("Deezer has nothing for {genre}"),
            None => "Deezer had nothing to offer for your listening".to_string(),
        });
    }

    report.phase("ranking", "Choosing the songs.");
    let chosen = rank(&taste, pool);
    if chosen.is_empty() {
        return Err("nothing in Deezer's catalogue matched your listening".to_string());
    }

    // A song the library already holds takes its own id; the rest wait.
    let mut entries = Vec::new();
    let mut pending = Vec::new();
    for candidate in &chosen {
        let key = import_source::track_key(&candidate.title, &candidate.artist(), &candidate.album);
        match held.get(&key) {
            Some(id) => entries.push(id.clone()),
            None => {
                let track = PendingTrack::from_meta(&candidate.meta(), SOURCE, &candidate.id);
                entries.push(track.id.clone());
                pending.push(track);
            }
        }
    }

    let name = unique_name(&catalog, &playlist_name(mode, genre));
    let playlist_id = catalog.create_generated_playlist(&name, &entries, &pending)?;

    let store = app.state::<Store>();
    let state = playlists::refresh(app, &store);

    report.phase("done", &format!("Added {} songs to {name}.", entries.len()));

    Ok(GenerateOutcome {
        playlist_id,
        state,
    })
}

fn playlist_name(mode: Mode, genre: Option<&str>) -> String {
    match (mode, genre) {
        (Mode::Genre, Some(genre)) => format!("{genre} picks"),
        _ => "Made for you".to_string(),
    }
}

/// Names are not identities, but two playlists nobody can tell apart are still
/// worth avoiding.
fn unique_name(catalog: &Catalog, base: &str) -> String {
    if !catalog.playlist_name_taken(base, None) {
        return base.to_string();
    }
    for number in 2..100 {
        let candidate = format!("{base} {number}");
        if !catalog.playlist_name_taken(&candidate, None) {
            return candidate;
        }
    }
    base.to_string()
}

/// Everything Deezer offers that could go in the playlist, with what each pool
/// is worth.
fn pool(
    mode: Mode,
    genre: Option<&str>,
    taste: &Taste,
    genres: &[deezer::Genre],
    held: &HashMap<String, String>,
    report: &mut Reporter,
) -> Vec<Candidate> {
    let mut found = Vec::new();

    if let Some(genre) = genre {
        found.extend(genre_pool(genre, genres, WANTED, held, report));
    }

    if mode == Mode::Taste {
        found.extend(artist_pool(taste, WANTED, held, report));
        for (name, _) in taste.genres.iter().take(TOP_GENRES) {
            found.extend(chart_pool(name, genres, BESIDE, held, report));
        }
    } else {
        found.extend(artist_pool(taste, BESIDE, held, report));
    }

    found
}

/// The loved artists and the artists beside them.
fn artist_pool(
    taste: &Taste,
    weight: f64,
    held: &HashMap<String, String>,
    report: &mut Reporter,
) -> Vec<Candidate> {
    let wanted: Vec<&(String, f64)> = taste.artists.iter().take(TOP_ARTISTS).collect();
    report.count(wanted.len());

    let mut found = Vec::new();
    for (position, (name, _)) in wanted.iter().enumerate() {
        report.at(position + 1, name);

        let Some(artist) = ask(report, "catalogue", &format!("Looking for {name}."), || {
            deezer::artist(name)
        })
        .flatten() else {
            continue;
        };

        found.extend(entries_pool(
            ask(report, "catalogue", &format!("Reading the top songs of {name}."), || {
                deezer::top_tracks(&artist.id, ARTIST_TRACKS)
            })
            .unwrap_or_default(),
            weight,
            None,
            held,
        ));

        let related = ask(
            report,
            "catalogue",
            &format!("Looking for artists like {name}."),
            || deezer::related_artists(&artist.id),
        )
        .unwrap_or_default();

        for other in related.into_iter().take(RELATED_ARTISTS) {
            found.extend(entries_pool(
                ask(
                    report,
                    "catalogue",
                    &format!("Reading the top songs of {}.", other.name),
                    || deezer::top_tracks(&other.id, RELATED_TRACKS),
                )
                .unwrap_or_default(),
                weight * BESIDE,
                None,
                held,
            ));
        }
    }

    found
}

/// The songs charting in a genre the record leans on. A genre Deezer keeps no
/// chart for is simply left out here.
fn chart_pool(
    genre: &str,
    genres: &[deezer::Genre],
    weight: f64,
    held: &HashMap<String, String>,
    report: &mut Reporter,
) -> Vec<Candidate> {
    let Some(id) = genre_id(genres, genre) else {
        return Vec::new();
    };

    entries_pool(
        ask(report, "catalogue", &format!("Reading the {genre} chart."), || {
            deezer::genre_chart(&id)
        })
        .unwrap_or_default(),
        weight,
        Some(genre),
        held,
    )
}

/// The songs for the genre the user asked for. A genre Deezer has no chart for
/// becomes a plain search, which the sheet is told about.
fn genre_pool(
    genre: &str,
    genres: &[deezer::Genre],
    weight: f64,
    held: &HashMap<String, String>,
    report: &mut Reporter,
) -> Vec<Candidate> {
    match genre_id(genres, genre) {
        Some(id) => entries_pool(
            ask(report, "catalogue", &format!("Reading the {genre} chart."), || {
                deezer::genre_chart(&id)
            })
            .unwrap_or_default(),
            weight,
            Some(genre),
            held,
        ),
        None => {
            report.fail(format!(
                "Deezer keeps no {genre} chart, so this is a loose match."
            ));
            entries_pool(
                ask(
                    report,
                    "catalogue",
                    &format!("Searching Deezer for {genre}."),
                    || deezer::search_tracks(genre, KEEP),
                )
                .unwrap_or_default(),
                weight,
                Some(genre),
                held,
            )
        }
    }
}

/// The Deezer genre a library's free text answers to, if any does.
fn genre_id(genres: &[deezer::Genre], wanted: &str) -> Option<String> {
    let wanted = fold(wanted);
    genres
        .iter()
        .find(|genre| fold(&genre.name) == wanted)
        .or_else(|| {
            genres.iter().find(|genre| {
                let name = fold(&genre.name);
                name.contains(&wanted) || wanted.contains(&name)
            })
        })
        .map(|genre| genre.id.clone())
}

fn entries_pool(
    entries: Vec<deezer::Entry>,
    weight: f64,
    genre: Option<&str>,
    held: &HashMap<String, String>,
) -> Vec<Candidate> {
    entries
        .into_iter()
        .map(|entry| {
            let meta = entry.meta;
            let known = held.contains_key(&import_source::meta_key(&meta));
            let mut genres = meta.genres.clone();
            // A listing carries no genres, so the chart's own genre stands in
            // for them.
            if let Some(genre) = genre {
                if !genres.iter().any(|name| name.eq_ignore_ascii_case(genre)) {
                    genres.push(genre.to_string());
                }
            }

            Candidate {
                id: entry.id,
                title: meta.title,
                artists: meta.artists,
                album: meta.album,
                genres,
                cover_url: meta.cover_url,
                isrc: meta.isrc,
                release_date: meta.release_date,
                track_number: meta.track_number,
                disc_number: meta.disc_number,
                weight,
                held: known,
            }
        })
        .collect()
}

/// One Deezer call. A failure is reported and the pool carries on, because one
/// artist that will not answer is no reason to refuse the playlist.
fn ask<T>(
    report: &mut Reporter,
    phase: &str,
    what: &str,
    call: impl FnOnce() -> Result<T, String>,
) -> Option<T> {
    report.phase(phase, what);
    let answer = call();
    sleep(Duration::from_millis(PACE_MS));

    match answer {
        Ok(value) => Some(value),
        Err(error) => {
            report.fail(error);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn taste() -> Taste {
        Taste {
            artists: vec![("The Beatles".to_string(), 1.0), ("Other".to_string(), 0.5)],
            genres: vec![("Rock".to_string(), 1.0)],
            skipped: HashSet::new(),
            liked: HashSet::new(),
        }
    }

    fn song(id: &str, title: &str, artist: &str, album: &str, weight: f64) -> Candidate {
        Candidate {
            id: id.to_string(),
            title: title.to_string(),
            artists: vec![artist.to_string()],
            album: album.to_string(),
            genres: vec!["Rock".to_string()],
            cover_url: None,
            isrc: String::new(),
            release_date: String::new(),
            track_number: None,
            disc_number: None,
            weight,
            held: false,
        }
    }

    fn ids(kept: &[Candidate]) -> Vec<String> {
        kept.iter().map(|candidate| candidate.id.clone()).collect()
    }

    #[test]
    fn caps_one_artist_at_three_songs() {
        let pool: Vec<Candidate> = (0..6)
            .map(|n| {
                song(
                    &format!("a{n}"),
                    &format!("Song {n}"),
                    "The Beatles",
                    &format!("Album {n}"),
                    1.0,
                )
            })
            .collect();

        assert_eq!(rank(&taste(), pool).len(), MAX_PER_ARTIST);
    }

    #[test]
    fn caps_one_album_at_two_songs() {
        let pool: Vec<Candidate> = (0..4)
            .map(|n| {
                song(
                    &format!("a{n}"),
                    &format!("Song {n}"),
                    "The Beatles",
                    "One Album",
                    1.0,
                )
            })
            .collect();

        assert_eq!(rank(&taste(), pool).len(), MAX_PER_ALBUM);
    }

    #[test]
    fn keeps_affinity_first() {
        let pool = vec![
            song("low", "Nothing", "Nobody", "Somewhere", BESIDE),
            song("high", "Hey Jude", "The Beatles", "Past Masters", WANTED),
        ];

        assert_eq!(ids(&rank(&taste(), pool)), vec!["high", "low"]);
    }

    #[test]
    fn drops_songs_that_were_skipped() {
        let mut taste = taste();
        taste.skipped.insert(song_key("Hey Jude", "The Beatles"));

        let pool = vec![
            song("one", "Hey Jude", "The Beatles", "Past Masters", WANTED),
            song("two", "Let It Be", "The Beatles", "Let It Be", WANTED),
        ];

        assert_eq!(ids(&rank(&taste, pool)), vec!["two"]);
    }

    #[test]
    fn keeps_only_five_songs_the_library_already_holds() {
        let pool: Vec<Candidate> = (0..10)
            .map(|n| {
                let mut candidate = song(
                    &format!("h{n}"),
                    &format!("Held {n}"),
                    &format!("Artist {n}"),
                    &format!("Album {n}"),
                    WANTED,
                );
                candidate.held = true;
                candidate
            })
            .collect();

        assert_eq!(rank(&taste(), pool).len(), MAX_HELD);
    }

    #[test]
    fn fills_the_list_up_to_fifty() {
        let pool: Vec<Candidate> = (0..80)
            .map(|n| {
                song(
                    &format!("s{n}"),
                    &format!("Song {n}"),
                    &format!("Artist {n}"),
                    &format!("Album {n}"),
                    WANTED,
                )
            })
            .collect();

        assert_eq!(rank(&taste(), pool).len(), KEEP);
    }

    #[test]
    fn a_liked_song_the_library_holds_beats_one_it_does_not() {
        let mut taste = taste();
        taste.liked.insert(song_key("Liked", "Artist"));

        let pool = vec![
            song("plain", "Plain", "Artist", "Album", WANTED),
            song("liked", "Liked", "Artist", "Other Album", WANTED),
        ];

        assert_eq!(ids(&rank(&taste, pool))[0], "liked");
    }

    #[test]
    fn the_same_record_always_picks_the_same_songs() {
        let pool: Vec<Candidate> = (0..40)
            .map(|n| {
                song(
                    &format!("s{n}"),
                    &format!("Song {n}"),
                    &format!("Artist {}", n % 7),
                    &format!("Album {}", n % 11),
                    WANTED,
                )
            })
            .collect();

        let once = rank(&taste(), pool.clone());
        let twice = rank(&taste(), pool);
        assert_eq!(ids(&once), ids(&twice));
    }

    #[test]
    fn says_how_far_off_the_marks_the_record_is() {
        assert_eq!(short_of(12, 0), "12 of 20 plays");
        assert_eq!(short_of(0, 10 * 60_000), "10 of 30 minutes");
        assert_eq!(short_of(5, 25 * 60_000), "25 of 30 minutes");
    }

    #[test]
    fn matches_a_library_genre_to_a_deezer_one() {
        let genres = vec![
            deezer::Genre {
                id: "132".to_string(),
                name: "Pop".to_string(),
            },
            deezer::Genre {
                id: "152".to_string(),
                name: "Rock".to_string(),
            },
        ];

        assert_eq!(genre_id(&genres, " rock ").as_deref(), Some("152"));
        assert_eq!(genre_id(&genres, "Trip-Hop"), None);
    }
}
