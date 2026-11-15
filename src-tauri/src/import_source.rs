use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::catalog::{Catalog, TrackRow};
use crate::download;
use crate::download_log;
use crate::import::{self, ImportOutcome};
use crate::playlists;
use crate::progress::{Output, Reporter};
use crate::source::{read_env, TrackMeta};
use crate::state::{PersistedState, Store};
use crate::tools;

/// Follows one import, track by track.
pub const PROGRESS_EVENT: &str = "source-import";

/// What a link import answers with on a platform that cannot download.
///
/// yt-dlp, ffmpeg and Deno all have to run as separate programs, and none of
/// them has an Android build, so there is nothing on a phone to fetch a link's
/// audio with. Saying so is better than a download that fails obscurely.
#[cfg(not(desktop))]
pub const NOT_ON_ANDROID: &str =
    "link imports are not available on Android: yt-dlp, ffmpeg and Deno cannot run there. \
     Import the music from the phone's own storage instead.";

/// The services a pasted link can belong to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Service {
    Spotify,
    Deezer,
    Youtube,
}

impl Service {
    /// The name the import history and the log use.
    pub fn name(self) -> &'static str {
        match self {
            Service::Spotify => "spotify",
            Service::Deezer => "deezer",
            Service::Youtube => "youtube",
        }
    }

    /// The service a link belongs to, read the way the import dialog reads it.
    pub fn of(link: &str) -> Self {
        let value = link.trim().to_lowercase();
        if value.contains("deezer.") || value.starts_with("deezer:") {
            return Service::Deezer;
        }
        if value.contains("youtube.") || value.contains("youtu.be") {
            return Service::Youtube;
        }
        Service::Spotify
    }

    /// The service a name asks for, for a caller that says so outright.
    pub fn parse(name: &str) -> Result<Self, String> {
        match name.trim().to_lowercase().as_str() {
            "spotify" => Ok(Service::Spotify),
            "deezer" => Ok(Service::Deezer),
            "youtube" => Ok(Service::Youtube),
            other => Err(format!("{other} is not a service; use spotify, deezer or youtube")),
        }
    }
}

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

/// Downloads a link of the given service, which is what the app's own import
/// commands and the command line both go through.
pub fn run_link(
    app: &AppHandle,
    service: Service,
    url: &str,
    download_duplicates: bool,
    output: Output,
) -> Result<ImportOutcome, String> {
    run(app, service.name(), download_duplicates, output, |report| {
        resolve_link(app, service, url, true, report)
    })
}

/// Reads a link of the given service and reports what it holds, so a caller can
/// ask about the duplicates before downloading anything.
pub fn plan_link(
    app: &AppHandle,
    service: Service,
    url: &str,
    output: Output,
) -> Result<ImportPlan, String> {
    plan(app, service.name(), output, |report| {
        resolve_link(app, service, url, false, report)
    })
}

/// Asks the service what its link points at. A Deezer playlist is filled in
/// from its albums only for an import, where the extra detail is worth the
/// requests; a plan takes the listing as it stands.
pub fn resolve_link(
    app: &AppHandle,
    service: Service,
    url: &str,
    enrich: bool,
    report: &mut Reporter,
) -> Result<Link, String> {
    match service {
        Service::Spotify => crate::spotify_import::resolve(app, url, report),
        Service::Deezer => crate::deezer_import::resolve(url, report, enrich),
        Service::Youtube => crate::youtube::resolve(app, url, report),
    }
}

pub fn run(
    app: &AppHandle,
    source: &str,
    download_duplicates: bool,
    output: Output,
    resolve: impl FnOnce(&mut Reporter) -> Result<Link, String>,
) -> Result<ImportOutcome, String> {
    let mut report = Reporter::new(app, PROGRESS_EVENT, output);
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
    let bundled = tools::bundled_dir(app);
    // Everything yt-dlp says while this import runs is written to the log, so a
    // download that goes wrong can be read back afterwards.
    download_log::begin(app, source);
    let tools = download::resolve_tools(&read_env(app), bundled.as_deref())?;
    let link = resolve(report)?;
    if let Some(log) = &tools.log {
        log.link(&link.name, link.tracks.len());
    }
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
                dir: staging.path().join(index.to_string()),
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
        track_ids: Vec::new(),
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
    if outcome.errors.is_empty() {
        staging.cleanup();
    }
    outcome.refresh_state(app, &app.state::<Store>());
    Ok(outcome)
}

fn download_message(todo: usize, duplicates: usize) -> String {
    if duplicates == 0 {
        return format!("Downloading {todo} tracks.");
    }
    format!("Downloading {todo} tracks. {duplicates} already in your library.")
}

#[derive(Default)]
pub(crate) struct TrackIndex {
    candidates: HashMap<String, Vec<TrackRow>>,
}

fn library_index(app: &AppHandle) -> TrackIndex {
    let catalog = app.state::<Catalog>();
    catalog_index(&catalog).unwrap_or_default()
}

pub(crate) fn catalog_index(catalog: &Catalog) -> Result<TrackIndex, String> {
    let mut index = TrackIndex::default();

    for row in catalog.tracks()? {
        remember(&mut index, row);
    }

    Ok(index)
}

fn remember(index: &mut TrackIndex, row: TrackRow) {
    let artist = row.artist.as_deref().unwrap_or_default();
    if fold(&row.title).is_empty() || fold(main_artist(artist)).is_empty() {
        return;
    }
    index.candidates.entry(loose_key(&row.title, artist)).or_default().push(row);
}

#[cfg(test)]
fn meta_key(meta: &TrackMeta) -> String {
    track_key(&meta.title, &meta.artists.join(", "), &meta.album)
}

/// The library song this track answers to, if the library holds one.
pub(crate) fn held<'a>(index: &'a TrackIndex, meta: &TrackMeta) -> Option<&'a String> {
    let artist = meta.artists.join(", ");
    if fold(&meta.title).is_empty() || fold(main_artist(&artist)).is_empty() {
        return None;
    }
    let mut matches = index.candidates.get(&loose_key(&meta.title, &artist))?
        .iter().filter(|row| compatible(row, meta));
    let first = matches.next()?;
    if matches.next().is_some() { None } else { Some(&first.id) }
}

fn compatible(row: &TrackRow, meta: &TrackMeta) -> bool {
    fn same_if_known(left: &str, right: &str) -> bool {
        let left = fold(left);
        let right = fold(right);
        left.is_empty() || right.is_empty() || left == right
    }
    fn number_if_known<T: Eq + Copy + Default>(left: Option<T>, right: Option<T>) -> bool {
        let left = left.filter(|value| *value != T::default());
        let right = right.filter(|value| *value != T::default());
        left.is_none() || right.is_none() || left == right
    }

    let credits = |value: &str| {
        let mut names: Vec<_> = value.split([',', ';']).map(fold).filter(|name| !name.is_empty()).collect();
        names.sort();
        names.dedup();
        names
    };
    let library_artists = credits(row.artist.as_deref().unwrap_or_default());
    let source_artists = credits(&meta.artists.join(", "));
    let year = meta.release_date.split('-').next().and_then(|value| value.parse::<u16>().ok());
    (library_artists.len() < 2 || source_artists.len() < 2 || library_artists == source_artists)
        && same_if_known(row.album.as_deref().unwrap_or_default(), &meta.album)
        && same_if_known(row.album_artist.as_deref().unwrap_or_default(), &meta.album_artist)
        && number_if_known(row.track_no, meta.track_number)
        && number_if_known(row.disc_no, meta.disc_number)
        && number_if_known(row.year, year)
        && (row.duration_ms == 0 || meta.duration_ms.filter(|value| *value > 0)
            .is_none_or(|duration| row.duration_ms.abs_diff(duration) <= 5_000))
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

pub(crate) struct DownloadStaging {
    dir: PathBuf,
}

impl DownloadStaging {
    pub(crate) fn path(&self) -> &Path {
        &self.dir
    }

    pub(crate) fn cleanup(self) {
        let _ = fs::remove_dir_all(self.dir);
    }
}

pub(crate) fn reserve_staging(parent: &Path) -> Result<DownloadStaging, String> {
    fs::create_dir_all(parent)
        .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    loop {
        let dir = parent.join(crate::identity::new_id());
        match fs::create_dir(&dir) {
            Ok(()) => return Ok(DownloadStaging { dir }),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("could not create {}: {error}", dir.display())),
        }
    }
}

fn staging_dir_at(root: &Path, source: &str, id: &str) -> Result<DownloadStaging, String> {
    reserve_staging(&root.join(source).join(id))
}

fn staging_dir(app: &AppHandle, source: &str, id: &str) -> Result<DownloadStaging, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data directory: {e}"))?;
    staging_dir_at(&root, source, id)
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
    source: &str,
    output: Output,
    resolve: impl FnOnce(&mut Reporter) -> Result<Link, String>,
) -> Result<ImportPlan, String> {
    let mut report = Reporter::new(app, PROGRESS_EVENT, output);
    // Reading the link runs yt-dlp for a pasted YouTube one, so it is logged
    // too; the import that follows rewrites the log from the start.
    download_log::begin(app, source);
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

    fn row(id: &str, title: &str, artist: &str, album: &str) -> TrackRow {
        TrackRow {
            id: id.into(),
            title: title.into(),
            artist: Some(artist.into()),
            album: Some(album.into()),
            ..TrackRow::default()
        }
    }

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
        let mut index = TrackIndex::default();
        remember(&mut index, row("id", "Eyeless", "Slipknot", "Slipknot"));

        let edition = TrackMeta {
            title: "Eyeless".to_string(),
            artists: vec!["Slipknot".to_string()],
            album: "Slipknot (10th Anniversary Edition)".to_string(),
            ..TrackMeta::default()
        };
        assert!(held(&index, &edition).is_none());

        // A credit that names one artist where the library names three.
        let mut credited = TrackIndex::default();
        remember(&mut credited, row(
            "j",
            "Joseph",
            "Falling In Reverse, Corey Taylor, Serj Tankian",
            "Joseph",
        ));
        let listed = TrackMeta {
            title: "Joseph".to_string(),
            artists: vec!["Falling In Reverse".to_string()],
            album: "Joseph".to_string(),
            ..TrackMeta::default()
        };
        assert_eq!(held(&credited, &listed).map(String::as_str), Some("j"));

        // The spelling a source uses for the artist.
        let mut spelled = TrackIndex::default();
        remember(&mut spelled, row("k", "Freak On a Leash", "Korn", "Follow The Leader"));
        let decorated = TrackMeta {
            title: "Freak On a Leash".to_string(),
            artists: vec!["KoЯn".to_string()],
            album: "Follow The Leader".to_string(),
            ..TrackMeta::default()
        };
        assert_eq!(held(&spelled, &decorated).map(String::as_str), Some("k"));

        // Another song with the same title is another song.
        let mut hostage = TrackIndex::default();
        remember(&mut hostage, row("h", "Hostage", "Chelsea Grin", "Eternal Nightmare"));
        let other = TrackMeta {
            title: "Hostage".to_string(),
            artists: vec!["Jane & The Boy".to_string()],
            album: "Turn It Up".to_string(),
            ..TrackMeta::default()
        };
        assert!(held(&hostage, &other).is_none());
    }

    #[test]
    fn rejects_conflicting_recording_details_even_when_title_and_album_match() {
        let mut indexed = row("one", "Song", "Artist, Guest", "Album");
        indexed.album_artist = Some("Artist".into());
        indexed.track_no = Some(3);
        indexed.disc_no = Some(1);
        indexed.year = Some(2020);
        indexed.duration_ms = 200_000;
        let mut index = TrackIndex::default();
        remember(&mut index, indexed);
        let base = TrackMeta {
            title: "Song".into(), artists: vec!["Artist".into()], album: "Album".into(),
            album_artist: "Artist".into(), track_number: Some(3), disc_number: Some(1),
            release_date: "2020-05-10".into(), duration_ms: Some(203_000),
            ..TrackMeta::default()
        };
        assert_eq!(held(&index, &base).map(String::as_str), Some("one"));
        for other in [
            TrackMeta { artists: vec!["Artist".into(), "Someone else".into()], ..base.clone() },
            TrackMeta { album: "Live".into(), ..base.clone() },
            TrackMeta { album_artist: "Someone else".into(), ..base.clone() },
            TrackMeta { track_number: Some(4), ..base.clone() },
            TrackMeta { disc_number: Some(2), ..base.clone() },
            TrackMeta { release_date: "2021".into(), ..base.clone() },
            TrackMeta { duration_ms: Some(230_000), ..base.clone() },
        ] {
            assert!(held(&index, &other).is_none());
        }
        assert_eq!(held(&index, &TrackMeta {
            artists: vec!["Artist".into(), "Guest".into()], ..base.clone()
        }).map(String::as_str), Some("one"));
    }

    #[test]
    fn missing_metadata_only_matches_when_the_candidate_is_unambiguous() {
        let mut index = TrackIndex::default();
        remember(&mut index, row("studio", "Song", "Artist", "Studio"));
        remember(&mut index, row("live", "Song", "Artist", "Live"));
        let mut meta = TrackMeta {
            title: "Song".into(), artists: vec!["Artist".into()], ..TrackMeta::default()
        };
        assert!(held(&index, &meta).is_none());
        meta.album = "Live".into();
        assert_eq!(held(&index, &meta).map(String::as_str), Some("live"));
        remember(&mut index, row("live-copy", "Song", "Artist", "Live"));
        assert!(held(&index, &meta).is_none());
        meta.artists.clear();
        assert!(held(&index, &meta).is_none());
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

    #[test]
    fn concurrent_source_imports_reserve_private_staging() {
        let root = std::env::temp_dir().join(format!("wave-source-staging-{}", crate::identity::new_id()));
        let parent = root.join("spotify").join("same-id");
        fs::create_dir_all(parent.join("0")).unwrap();
        fs::write(parent.join("0").join("audio.mp3"), b"old download").unwrap();
        let stages = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8).map(|_| {
                let root = &root;
                scope.spawn(move || staging_dir_at(root, "spotify", "same-id").unwrap())
            }).collect();
            handles.into_iter().map(|handle| handle.join().unwrap()).collect::<Vec<_>>()
        });
        let distinct: std::collections::HashSet<_> = stages.iter().map(|stage| stage.path().to_path_buf()).collect();
        assert_eq!(distinct.len(), 8);
        for (index, stage) in stages.iter().enumerate() {
            fs::create_dir(stage.path().join("0")).unwrap();
            fs::write(stage.path().join("0").join("audio.mp3"), index.to_string()).unwrap();
        }
        let mut stages = stages.into_iter();
        let first = stages.next().unwrap();
        let first_path = first.path().to_path_buf();
        first.cleanup();
        assert!(!first_path.exists());
        let retained = stages.next().unwrap();
        let retained_path = retained.path().to_path_buf();
        drop(retained);
        assert!(retained_path.join("0").join("audio.mp3").is_file());
        for stage in stages {
            assert!(stage.path().join("0").join("audio.mp3").is_file());
            stage.cleanup();
        }
        assert_eq!(fs::read(parent.join("0").join("audio.mp3")).unwrap(), b"old download");
        fs::remove_dir_all(root).unwrap();
    }
}
