use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;

use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::{Accessor, AudioFile, TagExt};
use lofty::tag::{ItemKey, Tag, TagType};
use serde_json::Value;

use crate::download_log::{self, Log, Ran};
use crate::import_source::{fold, track_label};
use crate::source::{client, encode, Env, TrackMeta};
use crate::tools::{find_yt_dlp, hide_console, tool_path, YtDlp};

const AUDIO_STEM: &str = "audio";

/// How many hits a search is read for, and how many of the hits that turn out
/// not to be the song are looked past before it is given up on. A look-up is a
/// request of its own, so a search full of wrong answers stops early.
const HITS: usize = 12;
const LOOK_PAST: usize = 5;

/// How far a hit's length may sit from the source's and still be the same
/// recording. Two services rarely agree to the second, and an upload can carry
/// silence at either end, so the window has to be wider than the two seconds
/// the lyrics are matched in.
const LENGTH_WINDOW_MS: u64 = 10_000;

/// A hit this close to the source's length is the recording, so there is
/// nothing to gain by looking at any more of them.
const CLOSE_ENOUGH_MS: u64 = 2_000;

/// What the mp3 encoder can add to the length of what it was given.
const FILE_SLACK_MS: u64 = 1_000;

/// How many hits that answer to the song are kept as fallbacks before the
/// search is called off. Each one is a look-up of its own.
const FALLBACKS: usize = 4;

/// The points a hit needs before it is taken without looking at any more of
/// them. It takes the artist's own upload, or a catalogue song, to reach this
/// on the name and the length alone.
const GOOD_ENOUGH: i32 = 17;

/// The fields a look-up asks for, in the order they are read back.
const FIELDS: &str = "%(duration)s\t%(title)s\t%(channel,uploader)s\t%(artist)s\t%(album)s\t%(is_live)s\t%(channel_is_verified)s";

/// The words that mark a hit as another recording of the song, or as something
/// that is not the song at all. A song whose own title carries the word is not
/// held to this, so a live album is still a live album.
const STRAYS: [&str; 16] = [
    "live",
    "cover",
    "remix",
    "instrumental",
    "karaoke",
    "nightcore",
    "sped",
    "slowed",
    "reverb",
    "loop",
    "mashup",
    "reaction",
    "acoustic",
    "demo",
    "tutorial",
    "8d",
];

/// The words that name an edition or a credit of the song, which a hit is free
/// to leave out of its title. Every word in `STRAYS` counts as one of these
/// too, so a hit that is another take is set aside before it is judged.
const EDITIONS: [&str; 18] = [
    "feat",
    "ft",
    "featuring",
    "remaster",
    "remastered",
    "version",
    "edit",
    "mix",
    "deluxe",
    "edition",
    "bonus",
    "mono",
    "stereo",
    "anniversary",
    "expanded",
    "single",
    "album",
    "reissue",
];

const EDITED: [&str; 10] = [
    "clean",
    "censored",
    "bleeped",
    "bleep",
    "edited",
    "swearing",
    "profanity",
    "family",
    "friendly",
    "kidz",
];

const PARTS: [&str; 5] = ["part", "pt", "vol", "volume", "chapter"];

/// The words that say where a song was taken from. They sit in brackets or
/// after a dash without saying anything about the song itself, so a hit is
/// free to leave them out.
const DESCRIPTORS: [&str; 9] = [
    "from",
    "ost",
    "soundtrack",
    "theme",
    "movie",
    "film",
    "show",
    "series",
    "game",
];

pub struct Tools {
    pub yt_dlp: YtDlp,
    pub ffmpeg: Option<PathBuf>,
    pub deno: Option<PathBuf>,
    pub cookies: Option<PathBuf>,
    pub browser: Option<String>,
    /// Where every yt-dlp run is written, when an import asked for a log.
    pub log: Option<Arc<Log>>,
}

impl Tools {
    /// The folder yt-dlp should look in for ffmpeg, when it is not on PATH.
    fn ffmpeg_dir(&self) -> Option<PathBuf> {
        self.ffmpeg
            .as_ref()
            .and_then(|path| path.parent().map(Path::to_path_buf))
    }
}

pub fn resolve_tools(env: &Env, bundled: Option<&Path>) -> Result<Tools, String> {
    let yt_dlp = find_yt_dlp(env.yt_dlp.as_ref(), bundled).ok_or_else(|| {
        "yt-dlp was not found. Install it, or set YTDLP_PATH in the config .env.".to_string()
    })?;

    Ok(Tools {
        yt_dlp,
        ffmpeg: tool_path(env.ffmpeg.as_ref(), "ffmpeg", bundled),
        deno: tool_path(env.deno.as_ref(), "deno", bundled),
        // A cookies path that is not there is ignored, like the tool overrides.
        cookies: env
            .cookies
            .as_deref()
            .map(PathBuf::from)
            .filter(|path| path.is_file()),
        browser: env
            .browser
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string),
        // The import underway owns the log, whichever service it came from.
        log: download_log::current(),
    })
}

/// Records one yt-dlp run, when the import asked for a log.
fn note(tools: &Tools, kind: &str, label: &str, command: &Command, output: &Output) {
    if let Some(log) = &tools.log {
        log.run(kind, label, command, &Ran::of(output));
    }
}

/// The line the import will report, so the log ends on what the user was shown.
fn fail(tools: &Tools, meta: &TrackMeta, reason: &str) {
    if let Some(log) = &tools.log {
        log.failure(&format!("{} - {reason}", track_label(meta)));
    }
}

/// The downloader, whether that is the executable or the Python module.
fn yt_dlp_command(yt_dlp: &YtDlp) -> Command {
    match yt_dlp {
        YtDlp::Exe(path) => Command::new(path),
        YtDlp::Python(python) => {
            let mut command = Command::new(python);
            command.arg("-m").arg("yt_dlp");
            command
        }
    }
}

fn cookie_args(tools: &Tools) -> Vec<String> {
    match (&tools.cookies, &tools.browser) {
        (Some(path), _) => vec!["--cookies".to_string(), path.to_string_lossy().into_owned()],
        (None, Some(browser)) => vec!["--cookies-from-browser".to_string(), browser.clone()],
        (None, None) => Vec::new(),
    }
}

fn js_args(tools: &Tools) -> Vec<String> {
    match &tools.deno {
        Some(path) => vec![
            "--js-runtimes".to_string(),
            format!("deno:{}", path.display()),
        ],
        None => Vec::new(),
    }
}

/// The clients that get round what YouTube puts in front of some videos. They
/// are kept off the searches, which want the client the catalogue answers to.
fn player_args() -> [&'static str; 2] {
    ["--extractor-args", "youtube:player_client=android,ios,web_safari"]
}

/// One search hit: the video it points at, and what it calls itself.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Candidate {
    id: String,
    title: String,
    channel: String,
    duration_ms: Option<u64>,
    url: Option<String>,
    /// A catalogue song rather than a video somebody made.
    song: bool,
}

impl Candidate {
    fn target(&self) -> String {
        match &self.url {
            Some(url) => url.clone(),
            None => format!("https://www.youtube.com/watch?v={}", self.id),
        }
    }
}

/// A hit as a full look-up describes it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Found {
    duration_ms: u64,
    title: String,
    channel: String,
    artist: String,
    album: String,
    live: bool,
    verified: bool,
}

/// The file it wrote, which is the one to file into the library. A file that was
/// already there is left as it stands, so a re-run picks up where the last one
/// left off.
pub fn download(
    tools: &Tools,
    meta: &TrackMeta,
    out_dir: &Path,
    cover: Option<&Path>,
) -> Result<PathBuf, String> {
    let target = out_dir.join(format!("{AUDIO_STEM}.mp3"));

    if target.is_file() {
        if landed(&target, meta).is_ok() {
            return Ok(target);
        }
        let _ = fs::remove_file(&target);
    }

    fs::create_dir_all(out_dir).map_err(|e| format!("could not create {}: {e}", out_dir.display()))?;

    let path = match fetch(tools, meta, out_dir, &target) {
        Ok(path) => path,
        Err(error) => {
            let _ = fs::remove_dir_all(out_dir);
            fail(tools, meta, &error);
            return Err(error);
        }
    };

    tag(&path, meta, cover_bytes(cover, meta.cover_url.as_deref())).map_err(|e| {
        let message = format!("downloaded, but could not tag it: {e}");
        fail(tools, meta, &message);
        message
    })?;

    Ok(path)
}

const CONCURRENCY: usize = 4;

/// One song waiting to be fetched.
pub struct Job<'a> {
    /// Handed back with the result, so the caller knows which song it was.
    pub key: usize,
    pub meta: &'a TrackMeta,
    /// The folder the audio is put in, which is the song's own staging folder.
    pub dir: PathBuf,
    pub cover: Option<PathBuf>,
}

/// What one job produced, and the key it was given.
pub struct Fetched {
    pub key: usize,
    pub file: Result<PathBuf, String>,
}

fn in_parallel<T: Send>(total: usize, work: impl Fn(usize) -> T + Sync, mut keep: impl FnMut(T)) {
    let next = AtomicUsize::new(0);
    let workers = CONCURRENCY.min(total).max(1);
    let (sender, results) = mpsc::channel();

    std::thread::scope(|scope| {
        for _ in 0..workers {
            let sender = sender.clone();
            let next = &next;
            let work = &work;
            scope.spawn(move || {
                loop {
                    let position = next.fetch_add(1, Ordering::Relaxed);
                    if position >= total {
                        break;
                    }

                    if sender.send(work(position)).is_err() {
                        break;
                    }
                }
            });
        }
        // This thread's own handle has to go, or the loop below never ends.
        drop(sender);

        while let Ok(outcome) = results.recv() {
            keep(outcome);
        }
    });
}

pub fn fetch_all(tools: &Tools, jobs: &[Job<'_>], keep: impl FnMut(Fetched)) {
    in_parallel(
        jobs.len(),
        |position| {
            let job = &jobs[position];
            let file = download(tools, job.meta, &job.dir, job.cover.as_deref());
            Fetched { key: job.key, file }
        },
        keep,
    );
}

fn fetch(tools: &Tools, meta: &TrackMeta, out_dir: &Path, target: &Path) -> Result<PathBuf, String> {
    let mut failures: Vec<String> = Vec::new();

    for candidate in candidates(tools, meta)? {
        clear(out_dir, target);

        match pull(tools, &candidate, target) {
            Ok(path) => match landed(&path, meta) {
                Ok(()) => return Ok(path),
                Err(error) => {
                    let _ = fs::remove_file(&path);
                    failures.push(error);
                }
            },
            Err(error) => failures.push(error),
        }
    }

    Err(failures
        .into_iter()
        .next()
        .unwrap_or_else(|| "the download produced nothing".to_string()))
}

fn candidates(tools: &Tools, meta: &TrackMeta) -> Result<Vec<Candidate>, String> {
    let Some(url) = &meta.source_url else {
        return choose(tools, meta);
    };

    Ok(vec![Candidate {
        id: url.clone(),
        title: meta.title.clone(),
        channel: meta.artists.join(", "),
        duration_ms: meta.duration_ms,
        url: Some(url.clone()),
        song: false,
    }])
}

fn choose(tools: &Tools, meta: &TrackMeta) -> Result<Vec<Candidate>, String> {
    let mut passed: Vec<(i32, usize, Candidate)> = Vec::new();
    let mut closest: Option<u64> = None;
    let mut wrong = 0usize;

    for (order, candidate) in search(tools, meta)?.into_iter().enumerate() {
        if wrong >= LOOK_PAST || passed.len() >= FALLBACKS {
            break;
        }

        if settled(meta, &candidate) {
            return Ok(vec![candidate]);
        }

        let Some(seen) = look_up(tools, &candidate) else {
            wrong += 1;
            continue;
        };
        if seen.live || !answers(meta, &candidate, &seen) {
            wrong += 1;
            continue;
        }

        let gap = gap_of(meta, &seen);
        // Another take of the song, or another thing entirely.
        if let Some(gap) = gap.filter(|gap| *gap > LENGTH_WINDOW_MS) {
            if seen.duration_ms > 0 {
                closest = Some(closest.map_or(gap, |best| best.min(gap)));
            }
            continue;
        }

        let points = points(meta, &candidate, &seen);
        if gap.is_some_and(|gap| gap <= CLOSE_ENOUGH_MS) && points >= GOOD_ENOUGH {
            return Ok(vec![candidate]);
        }
        passed.push((points, order, candidate));
    }

    if passed.is_empty() {
        return Err(match closest {
            Some(gap) => format!("no YouTube match; the closest was {} off", seconds(gap)),
            None => "no YouTube match".to_string(),
        });
    }

    passed.sort_by_key(|(points, order, _)| (std::cmp::Reverse(*points), *order));
    Ok(passed.into_iter().map(|(_, _, candidate)| candidate).collect())
}

/// What both searches are read for. YouTube Music first, because what it
/// answers with is the song as the catalogue lists it rather than a video
/// somebody made of it, and the plain search for what the catalogue does not
/// carry.
fn search(tools: &Tools, meta: &TrackMeta) -> Result<Vec<Candidate>, String> {
    let catalogue = song_hits(tools, meta);
    let videos = youtube_hits(tools, meta);

    let mut hits = Vec::new();
    if let Ok(found) = &catalogue {
        hits.extend(usable(found.clone(), meta));
    }
    if let Ok(found) = &videos {
        hits.extend(usable(found.clone(), meta));
    }

    if hits.is_empty() {
        return Err(match (catalogue, videos) {
            (_, Err(error)) => error,
            (Err(error), _) => error,
            _ => "no YouTube match".to_string(),
        });
    }

    let mut seen = HashSet::new();
    hits.retain(|hit| seen.insert(hit.id.clone()));

    hits.sort_by_key(|hit| std::cmp::Reverse(rank(meta, hit)));
    Ok(hits)
}

/// The hits that could be the song: a video, named the way the song is, that
/// does not say of itself that it is another take.
fn usable(hits: Vec<Candidate>, meta: &TrackMeta) -> Vec<Candidate> {
    hits.into_iter()
        .filter(|hit| {
            video_id(&hit.id)
                && carries(&meta.title, &hit.title)
                && !stray_aside(&hit.title, &meta.title)
                && !stray_name(&hit.channel)
        })
        .collect()
}

/// Whether an id names a video. A search can also answer with a channel or a
/// playlist, which is not something a song can be downloaded from.
fn video_id(id: &str) -> bool {
    let usable = |character: char| {
        character.is_ascii_alphanumeric() || character == '-' || character == '_'
    };

    id.len() == 11 && id.chars().all(usable)
}

/// YouTube Music, restricted to its songs section: what comes back is the song
/// as the catalogue lists it, not a video somebody made.
fn song_hits(tools: &Tools, meta: &TrackMeta) -> Result<Vec<Candidate>, String> {
    let query = encode(&music_query(meta));
    let target = format!("https://music.youtube.com/search?q={query}#songs");

    Ok(parse_hits(&run_search(tools, &target)?, true))
}

/// A plain YouTube search, for the songs the catalogue does not carry.
fn youtube_hits(tools: &Tools, meta: &TrackMeta) -> Result<Vec<Candidate>, String> {
    let target = format!("ytsearch{HITS}:{} (audio)", video_query(meta));

    Ok(parse_hits(&run_search(tools, &target)?, false))
}

/// The name comes first, which is the order a music catalogue answers best in.
/// The other way round buries a song under whatever else the artist is known
/// for, which is how a cover of the right name wins over the right song.
fn music_query(meta: &TrackMeta) -> String {
    format!("{} - {}", meta.title, meta.artists.join(", "))
}

/// The artist comes first, which is the order a video search answers best in.
fn video_query(meta: &TrackMeta) -> String {
    format!("{} - {}", meta.artists.join(", "), meta.title)
}

/// A search, which reads the results rather than downloading anything.
fn run_search(tools: &Tools, target: &str) -> Result<Vec<u8>, String> {
    let mut command = yt_dlp_command(&tools.yt_dlp);
    command.args(cookie_args(tools));
    command.args(js_args(tools));
    command
        .arg("--flat-playlist")
        .arg("--dump-json")
        .arg("--skip-download")
        .arg("--no-warnings")
        .arg("--ignore-errors")
        .arg("--playlist-end")
        .arg(HITS.to_string())
        .arg(target);
    hide_console(&mut command);

    let output = command
        .output()
        .map_err(|e| format!("could not run yt-dlp: {e}"))?;
    note(tools, "search", "", &command, &output);

    if output.stdout.iter().all(u8::is_ascii_whitespace) {
        let reason = failure_reason(&output.stderr, &output.stdout)
            .map(|line| friendly(&line, tools))
            .unwrap_or_else(|| "the search found nothing".to_string());
        return Err(reason);
    }

    Ok(output.stdout)
}

/// One hit per line of JSON. A line that is not a hit, or that carries no id or
/// no name, is passed over rather than guessed at.
fn parse_hits(stdout: &[u8], song: bool) -> Vec<Candidate> {
    json_lines(stdout)
        .iter()
        .filter_map(|entry| candidate_of(entry, song))
        .collect()
}

/// yt-dlp prints one object per line, and anything that is not one is skipped.
fn json_lines(stdout: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(stdout)
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('{'))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn candidate_of(entry: &Value, song: bool) -> Option<Candidate> {
    let id = entry["id"].as_str().filter(|id| !id.is_empty())?;
    let title = entry["title"].as_str().unwrap_or_default().trim().to_string();
    if title.is_empty() {
        return None;
    }

    Some(Candidate {
        id: id.to_string(),
        title,
        channel: text_of(entry, &["channel", "uploader"]),
        duration_ms: seconds_of(entry),
        url: None,
        song,
    })
}

/// One song a link the user pasted points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkEntry {
    /// The upload itself, which is what gets downloaded.
    pub url: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub duration_ms: Option<u64>,
}

/// Reads a link the user pasted: one video, or a playlist of them. The name is
/// the playlist's when there is one, so an album keeps the name it was given.
pub fn read_link(tools: &Tools, url: &str, limit: usize) -> Result<(String, Vec<LinkEntry>), String> {
    let mut command = yt_dlp_command(&tools.yt_dlp);
    command.args(cookie_args(tools));
    command.args(js_args(tools));
    command
        .arg("--flat-playlist")
        .arg("--dump-json")
        .arg("--skip-download")
        .arg("--no-warnings")
        .arg("--ignore-errors")
        .arg("--playlist-end")
        .arg(limit.to_string())
        .arg(url);
    hide_console(&mut command);

    let output = command
        .output()
        .map_err(|e| format!("could not run yt-dlp: {e}"))?;
    note(tools, "link", "", &command, &output);

    let printed = json_lines(&output.stdout);
    let songs: Vec<LinkEntry> = printed.iter().filter_map(link_entry).collect();
    if songs.is_empty() {
        let reason = failure_reason(&output.stderr, &output.stdout)
            .map(|line| friendly(&line, tools))
            .unwrap_or_else(|| "that link has nothing to download".to_string());
        return Err(reason);
    }

    let name = playlist_name(&printed).unwrap_or_else(|| songs[0].title.clone());
    Ok((name, songs))
}

/// The playlist a pasted link points at, when it points at one.
fn playlist_name(printed: &[Value]) -> Option<String> {
    printed
        .iter()
        .find_map(|entry| entry["playlist_title"].as_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

fn link_entry(entry: &Value) -> Option<LinkEntry> {
    let id = entry["id"].as_str().filter(|id| !id.is_empty())?;
    let title = entry["title"].as_str().unwrap_or_default().trim().to_string();
    if title.is_empty() {
        return None;
    }

    let url = entry["webpage_url"]
        .as_str()
        .map(str::trim)
        .filter(|url| url.starts_with("http"))
        .map(str::to_string)
        .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={id}"));

    let (title, artists) = credit(
        &title,
        &text_of(entry, &["artist"]),
        &text_of(entry, &["channel", "uploader"]),
    );

    Some(LinkEntry {
        url,
        title,
        artists,
        album: text_of(entry, &["album"]),
        duration_ms: seconds_of(entry),
    })
}

fn credit(title: &str, credited: &str, channel: &str) -> (String, Vec<String>) {
    let credited = credited.trim();
    if !credited.is_empty() {
        return (title.to_string(), vec![credited.to_string()]);
    }

    match title.split_once(" - ") {
        Some((artist, song)) if !artist.trim().is_empty() && !song.trim().is_empty() => {
            (song.trim().to_string(), vec![artist.trim().to_string()])
        }
        _ => (title.to_string(), channel_artist(channel)),
    }
}

fn channel_artist(channel: &str) -> Vec<String> {
    let name = channel.trim();
    let name = name.strip_suffix(" - Topic").unwrap_or(name).trim();
    if name.is_empty() {
        Vec::new()
    } else {
        vec![name.to_string()]
    }
}

/// How long an entry runs, as yt-dlp reports it.
fn seconds_of(entry: &Value) -> Option<u64> {
    let seconds = entry["duration"].as_f64().or_else(|| {
        entry["duration"]
            .as_str()
            .and_then(|value| value.trim().parse().ok())
    })?;
    Some((seconds * 1000.0) as u64)
}

/// The first of these fields the entry carries.
fn text_of(entry: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| entry[*key].as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// What a hit really is: how long it runs, who it is by, and whether it is a
/// live stream rather than a song.
fn look_up(tools: &Tools, candidate: &Candidate) -> Option<Found> {
    let mut command = yt_dlp_command(&tools.yt_dlp);
    command.args(cookie_args(tools));
    command.args(js_args(tools));
    command
        .arg("--skip-download")
        .arg("--no-warnings")
        .args(player_args())
        .arg("--print")
        .arg(FIELDS)
        .arg(candidate.target());
    hide_console(&mut command);

    let output = command.output().ok()?;
    note(tools, "lookup", &candidate.title, &command, &output);
    found_in(&String::from_utf8_lossy(&output.stdout))
}

/// The one line the look-up prints, in the order `FIELDS` asks for.
fn found_in(stdout: &str) -> Option<Found> {
    let line = stdout
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())?;
    let fields: Vec<&str> = line.split('\t').map(str::trim).collect();

    // yt-dlp prints `NA` for anything the video does not carry.
    let field = |index: usize| -> String {
        match fields.get(index).copied().unwrap_or_default() {
            "NA" => String::new(),
            value => value.to_string(),
        }
    };

    let seconds = field(0).parse::<f64>().unwrap_or(0.0);

    Some(Found {
        duration_ms: (seconds * 1000.0) as u64,
        title: field(1),
        channel: field(2),
        artist: field(3),
        album: field(4),
        live: field(5).eq_ignore_ascii_case("true"),
        verified: field(6).eq_ignore_ascii_case("true"),
    })
}

/// What a hit calls itself: the name the look-up found, and the one the search
/// gave when the look-up has none.
fn title_of<'a>(candidate: &'a Candidate, seen: &'a Found) -> &'a str {
    match seen.title.trim() {
        "" => candidate.title.as_str(),
        named => named,
    }
}

/// Whether a hit answers to the song: the same name, the artist named
/// somewhere, and nothing about it that says it is another take.
fn answers(meta: &TrackMeta, candidate: &Candidate, seen: &Found) -> bool {
    let title = title_of(candidate, seen);
    if !carries(&meta.title, title)
        || stray_aside(title, &meta.title)
        || stray_name(&seen.channel)
        || stray_name(&seen.artist)
        || stray_name(&candidate.channel)
    {
        return false;
    }

    artist_named(meta, candidate, seen)
}

/// Whether one of the song's artists is named by the hit, in its title, its
/// channel, or the artist the catalogue credits it to.
fn artist_named(meta: &TrackMeta, candidate: &Candidate, seen: &Found) -> bool {
    meta.artists.is_empty()
        || artist_here(meta, &seen.artist)
        || artist_here(meta, &seen.channel)
        || artist_here(meta, &candidate.channel)
        || artist_here(meta, title_of(candidate, seen))
}

/// How well a hit answers to the song, from everything the look-up found. The
/// name and the artist are what it has to agree on; the rest decides between
/// the hits that do.
fn points(meta: &TrackMeta, candidate: &Candidate, seen: &Found) -> i32 {
    let mut score = 0;

    if in_one_piece(&meta.title, title_of(candidate, seen)) {
        score += 4;
    } else if carries(&meta.title, title_of(candidate, seen)) {
        score += 2;
    }
    if artist_named(meta, candidate, seen) {
        score += 4;
    }
    if own_upload(meta, candidate, seen) {
        score += 4;
    }
    if album_here(meta, &seen.album) {
        score += 2;
    }
    // A catalogue song is the recording itself rather than a video made of it.
    if candidate.song {
        score += 1;
    }
    // An upload that says it is the edited version comes last of all.
    if edited_upload(meta, candidate, seen) {
        score -= 10;
    }
    // And one that leaves out the take the song names waits behind the rest.
    if other_take(title_of(candidate, seen), &meta.title) {
        score -= 6;
    }

    score + length_points(gap_of(meta, seen))
}

/// The points a hit earns for running to the song's length.
fn length_points(gap: Option<u64>) -> i32 {
    match gap {
        // Nothing to judge it by, so it neither gains nor loses much.
        None => 2,
        Some(gap) if gap <= CLOSE_ENOUGH_MS => 6,
        Some(gap) => (6 - (gap / 2_500) as i32).max(1),
    }
}

/// Whether the album the hit sits on is the one the song came out on.
fn album_here(meta: &TrackMeta, album: &str) -> bool {
    let wanted = words(&meta.album).join(" ");
    let found = words(album).join(" ");

    !wanted.is_empty()
        && !found.is_empty()
        && (wanted == found || wanted.contains(&found) || found.contains(&wanted))
}

/// How far a hit's length sits from the source's. `None` when the source does
/// not say how long the song is, which is nothing to judge a hit by.
fn gap_of(meta: &TrackMeta, seen: &Found) -> Option<u64> {
    meta.duration_ms
        .map(|wanted| seen.duration_ms.abs_diff(wanted))
}

/// Whether a title carries the song's name.
fn carries(title: &str, hit: &str) -> bool {
    let name = name_words(title);
    let hit = words(hit);

    !name.is_empty()
        && name.iter().all(|word| hit.contains(word))
        && !part_of_something(&name, &hit)
}

/// Whether a hit is one part of a longer thing when the song's own name does
/// not say it is: "Song Part Two" is not "Song".
fn part_of_something(name: &[String], hit: &[String]) -> bool {
    hit.iter()
        .any(|word| PARTS.contains(&word.as_str()) && !name.contains(word))
}

/// Whether a title says it is another take of the song, when the song's own
/// title does not say the same of itself. A song called "Cover Me" keeps the
/// word in its own name, so the name is what the aside is weighed against.
fn stray_aside(title: &str, song: &str) -> bool {
    let mine = words(song);

    asides(title)
        .into_iter()
        .any(|word| STRAYS.contains(&word.as_str()) && !mine.contains(&word))
}

/// The take the song's own name names: a live album names a live take.
fn take_words(song: &str) -> HashSet<String> {
    asides(song)
        .into_iter()
        .filter(|word| STRAYS.contains(&word.as_str()))
        .collect()
}

/// Whether a title leaves out the take the song's own name names, which is
/// how the studio recording of a live album's song gives itself away.
fn other_take(title: &str, song: &str) -> bool {
    let mine = take_words(song);
    let hit = words(title);

    mine.iter().any(|word| !hit.contains(word))
}

/// Whether a name that only says who made the upload, a channel or an artist,
/// carries a word marking it as something other than the song.
fn stray_name(text: &str) -> bool {
    words(text)
        .iter()
        .any(|word| STRAYS.contains(&word.as_str()))
}

fn edited_upload(meta: &TrackMeta, candidate: &Candidate, seen: &Found) -> bool {
    let title = title_of(candidate, seen);

    edited_aside(title, &meta.title)
        || edited_name(&seen.channel)
        || edited_name(&seen.artist)
        || edited_name(&candidate.channel)
}

fn edited_aside(title: &str, song: &str) -> bool {
    let mine = edited_words(song);

    edited_words(title)
        .into_iter()
        .any(|word| !mine.contains(&word))
}

fn edited_words(title: &str) -> HashSet<String> {
    groups(title)
        .into_iter()
        .flat_map(|group| words(&group))
        .filter(|word| EDITED.contains(&word.as_str()))
        .collect()
}

fn edited_name(text: &str) -> bool {
    words(text)
        .iter()
        .any(|word| EDITED.contains(&word.as_str()))
}

/// The artist a topic channel is named after, when it is one.
fn topic_channel(channel: &str) -> Option<&str> {
    const TOPIC: &str = " - topic";
    let name = channel.trim();

    if name.len() > TOPIC.len() && name.to_lowercase().ends_with(TOPIC) {
        Some(&name[..name.len() - TOPIC.len()])
    } else {
        None
    }
}

/// Whether a channel is the artist's own, or the one YouTube makes for them.
/// A topic channel is only theirs when it is named after them, which is how a
/// tribute album filed under somebody else's name is told apart.
fn official_channel(meta: &TrackMeta, channel: &str) -> bool {
    match topic_channel(channel) {
        Some(artist) => same_artist(meta, artist),
        None => same_artist(meta, channel.trim()),
    }
}

/// Whether a name is one of the song's artists.
fn same_artist(meta: &TrackMeta, name: &str) -> bool {
    let name = fold(name.trim());

    !name.is_empty() && meta.artists.iter().any(|artist| fold(artist.trim()) == name)
}

fn settled(meta: &TrackMeta, candidate: &Candidate) -> bool {
    let Some(gap) = meta
        .duration_ms
        .zip(candidate.duration_ms)
        .map(|(wanted, found)| found.abs_diff(wanted))
    else {
        return false;
    };

    gap <= CLOSE_ENOUGH_MS
        && (artist_here(meta, &candidate.title) || artist_here(meta, &candidate.channel))
        && official_channel(meta, &candidate.channel)
        && !edited_aside(&candidate.title, &meta.title)
        && !edited_name(&candidate.channel)
}

/// Whether the hit is the artist's own upload, or one YouTube itself vouches
/// for, rather than somebody else's copy of the song. A topic channel named
/// after somebody else is that somebody's, however well YouTube thinks of it,
/// so an eight-bit emulation filed under its own name is not the artist's.
fn own_upload(meta: &TrackMeta, candidate: &Candidate, seen: &Found) -> bool {
    official_channel(meta, &seen.channel)
        || official_channel(meta, &candidate.channel)
        || (seen.verified && topic_channel(&seen.channel).is_none())
}

/// The words of the song's own name. The parts that name an edition or a credit
/// are set aside, because a hit is free to leave them out.
fn name_words(title: &str) -> Vec<String> {
    let aside = asides(title);

    words(title)
        .into_iter()
        .filter(|word| !aside.contains(word))
        .collect()
}

/// The words in the parts of a title that name an edition of the song: what
/// sits in brackets, and a trailing part after a dash. A group that runs on
/// like a description of where the song came from is set aside too, which is
/// how "Song - From the Film" is still "Song".
fn asides(title: &str) -> HashSet<String> {
    let mut found = HashSet::new();

    for group in groups(title) {
        let inside = words(&group);
        // A group that runs on this long, or that names an edition, a year or
        // where the song came from, is a description rather than the name.
        let described = inside.len() > 3
            || inside.iter().any(|word| {
                is_edition(word) || is_year(word) || DESCRIPTORS.contains(&word.as_str())
            });
        if described {
            found.extend(inside);
        }
    }

    found
}

fn is_edition(word: &str) -> bool {
    EDITIONS.contains(&word) || STRAYS.contains(&word)
}

/// Every bracketed group in a title, and a trailing part after a dash.
fn groups(title: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = title;

    while let Some(at) = rest.find(['(', '[']) {
        let close = if rest.as_bytes()[at] == b'(' { ')' } else { ']' };
        let tail = &rest[at + 1..];
        let end = tail.find(close).unwrap_or(tail.len());
        found.push(tail[..end].to_string());
        rest = &tail[end..];
    }

    if let Some(at) = title.rfind(" - ") {
        found.push(title[at + 3..].to_string());
    }

    found
}

/// Whether one of the song's artists is named in the text, which is what a hit
/// that is not on the artist's own channel still tends to do.
fn artist_here(meta: &TrackMeta, text: &str) -> bool {
    let hit = words(text);
    if hit.is_empty() {
        return false;
    }

    meta.artists.iter().any(|artist| {
        let name = words(artist);
        !name.is_empty() && name.iter().all(|word| hit.contains(word))
    })
}

/// How good a hit looks before it is looked up, which is all the words of its
/// title can say: the name in one piece, and the artist somewhere in it.
fn rank(meta: &TrackMeta, candidate: &Candidate) -> i32 {
    let mut score = 0;

    if in_one_piece(&meta.title, &candidate.title) {
        score += 3;
    } else if carries(&meta.title, &candidate.title) {
        score += 1;
    }
    if artist_here(meta, &candidate.title) {
        score += 2;
    }
    // The artist's own upload is the album version rather than a re-upload.
    if official_channel(meta, &candidate.channel) {
        score += 3;
    }
    // A hit that leaves out the take the song names waits behind the rest.
    if other_take(&candidate.title, &meta.title) {
        score -= 6;
    }
    // A catalogue song is the recording itself, and the catalogue is the
    // better judge of which recording a name points at than a video is.
    if candidate.song {
        score += 3;
    }
    // A hit that says it is the edited version waits behind the rest.
    if edited_aside(&candidate.title, &meta.title) || edited_name(&candidate.channel) {
        score -= 6;
    }

    score
}

/// Whether a title carries the song's name as one run of words, which is how a
/// hit that is the song tends to name it.
fn in_one_piece(title: &str, hit: &str) -> bool {
    let name = name_words(title);
    let hit = words(hit);

    !name.is_empty() && hit.windows(name.len()).any(|window| window == name)
}

/// The words of a name, folded so two spellings of it agree, with everything
/// that is not a letter or a digit between them. An apostrophe is dropped
/// rather than split on, so a title that leaves one out still agrees.
fn words(text: &str) -> Vec<String> {
    fold(text)
        .replace(['\'', '\u{2019}'], "")
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

fn is_year(word: &str) -> bool {
    word.len() == 4 && word.bytes().all(|byte| byte.is_ascii_digit())
}

/// Downloads one hit to where the song is going.
fn pull(tools: &Tools, candidate: &Candidate, target: &Path) -> Result<PathBuf, String> {
    let template = output_template(target);

    let mut command = yt_dlp_command(&tools.yt_dlp);
    command.args(cookie_args(tools));
    command.args(js_args(tools));
    command
        .arg("-x")
        .arg("--audio-format")
        .arg("mp3")
        .arg("--audio-quality")
        .arg("192")
        .arg("--no-playlist")
        .arg("--no-simulate")
        .arg("--no-warnings")
        .arg("--newline")
        .arg("--retries")
        .arg("5")
        .arg("--fragment-retries")
        .arg("5")
        .arg("--concurrent-fragments")
        .arg("4")
        .args(player_args())
        .arg("--print")
        .arg("after_move:filepath")
        .arg("-o")
        .arg(&template);

    if let Some(dir) = tools.ffmpeg_dir() {
        command.arg("--ffmpeg-location").arg(dir);
    }

    command.arg(candidate.target());
    hide_console(&mut command);

    let output = command
        .output()
        .map_err(|e| format!("could not run yt-dlp: {e}"))?;
    note(tools, "download", &candidate.title, &command, &output);

    let produced = produced_path(&output.stdout).filter(|path| path.is_file());
    let path = match produced {
        Some(path) => path,
        None if target.is_file() => target.to_path_buf(),
        None => {
            let reason = failure_reason(&output.stderr, &output.stdout)
                .map(|line| friendly(&line, tools))
                .unwrap_or_else(|| "no file was produced".to_string());
            return Err(reason);
        }
    };

    // yt-dlp can settle on a different name.
    if path == target {
        return Ok(path);
    }
    Ok(fs::rename(&path, target)
        .map(|_| target.to_path_buf())
        .unwrap_or(path))
}

fn landed(path: &Path, meta: &TrackMeta) -> Result<(), String> {
    let tagged =
        lofty::read_from_path(path).map_err(|e| format!("what came back is not audio: {e}"))?;
    let length = tagged.properties().duration().as_millis() as u64;

    let Some(wanted) = meta.duration_ms else {
        return Ok(());
    };
    if length == 0 {
        return Ok(());
    }

    let gap = length.abs_diff(wanted);
    if gap > LENGTH_WINDOW_MS + FILE_SLACK_MS {
        return Err(format!(
            "the file that came back runs {} off the song",
            seconds(gap)
        ));
    }

    Ok(())
}

fn clear(dir: &Path, keep: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for path in entries.flatten().map(|entry| entry.path()) {
        if path == keep {
            continue;
        }
        let _ = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
    }
}

/// A length said the way a person would.
fn seconds(ms: u64) -> String {
    let whole = ms as f64 / 1000.0;
    if whole < 10.0 {
        return format!("{whole:.1}s");
    }
    format!("{whole:.0}s")
}

/// Any `%` is doubled: yt-dlp reads it as a template, so a path containing one
/// would otherwise swallow the `%(ext)s` that fills in the format.
fn output_template(target: &Path) -> String {
    let stem = escape(
        &target
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| "track".to_string()),
    );
    let file = format!("{stem}.%(ext)s");

    match target.parent() {
        Some(dir) => format!(
            "{}{}{file}",
            escape(&dir.to_string_lossy()),
            std::path::MAIN_SEPARATOR
        ),
        None => file,
    }
}

/// A literal `%`, for a string that is about to be read as a template.
fn escape(text: &str) -> String {
    text.replace('%', "%%")
}

/// The path yt-dlp printed for the finished file.
fn produced_path(stdout: &[u8]) -> Option<PathBuf> {
    let text = String::from_utf8_lossy(stdout);
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .next_back()
        .map(PathBuf::from)
}

fn last_line(bytes: &[u8]) -> Option<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .next_back()
        .map(str::to_string)
}

fn failure_reason(stderr: &[u8], stdout: &[u8]) -> Option<String> {
    last_line(stderr).or_else(|| {
        String::from_utf8_lossy(stdout)
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with("ERROR"))
            .next_back()
            .map(str::to_string)
    })
}

fn friendly(reason: &str, tools: &Tools) -> String {
    let walled = reason.contains("Sign in to confirm your age")
        || reason.contains("cookies for the authentication");
    if !walled || tools.cookies.is_some() || tools.browser.is_some() {
        return reason.to_string();
    }
    "YouTube wants a sign-in for this one. Set YTDLP_COOKIES_FROM_BROWSER or YTDLP_COOKIES in the \
     config .env, then download it again."
        .to_string()
}

fn cover_bytes(local: Option<&Path>, url: Option<&str>) -> Option<Vec<u8>> {
    local
        .and_then(|path| fs::read(path).ok())
        .or_else(|| fetch_cover(url))
}

/// The source's cover art, or `None` when it cannot be read.
pub fn fetch_cover(url: Option<&str>) -> Option<Vec<u8>> {
    let url = url?;
    let response = client().get(url).send().ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.bytes().ok().map(|bytes| bytes.to_vec())
}

/// Writes the ID3 tags, and the cover when one was fetched.
fn tag(path: &Path, meta: &TrackMeta, cover: Option<Vec<u8>>) -> Result<(), String> {
    let mut tag = Tag::new(TagType::Id3v2);

    tag.set_title(meta.title.clone());
    tag.set_artist(meta.artists.join(", "));
    if !meta.album.is_empty() {
        tag.set_album(meta.album.clone());
    }
    if !meta.album_artist.is_empty() {
        tag.insert_text(ItemKey::AlbumArtist, meta.album_artist.clone());
    }

    let year: String = meta.release_date.chars().take(4).collect();
    if year.len() == 4 {
        tag.insert_text(ItemKey::RecordingDate, year);
    }

    if let Some(number) = meta.track_number {
        tag.set_track(number);
    }
    if let Some(total) = meta.track_total {
        tag.set_track_total(total);
    }
    if let Some(disc) = meta.disc_number {
        tag.set_disk(disc);
    }
    if !meta.genres.is_empty() {
        tag.set_genre(meta.genres.join("; "));
    }
    if !meta.isrc.is_empty() {
        tag.insert_text(ItemKey::Isrc, meta.isrc.clone());
    }

    if let Some(length) = meta.duration_ms {
        tag.insert_text(ItemKey::Length, length.to_string());
    }

    if let Some(data) = cover {
        let mime = if crate::cover_fetch::is_png(&data) {
            MimeType::Png
        } else {
            MimeType::Jpeg
        };
        tag.push_picture(
            Picture::unchecked(data)
                .pic_type(PictureType::CoverFront)
                .mime_type(mime)
                .build(),
        );
    }

    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("could not write tags to {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Mutex;

    use lofty::prelude::TaggedFileExt;

    fn meta(title: &str, artists: &[&str], length: u64) -> TrackMeta {
        TrackMeta {
            title: title.to_string(),
            artists: artists.iter().map(|name| name.to_string()).collect(),
            duration_ms: Some(length * 1000),
            ..TrackMeta::default()
        }
    }

    fn hit(id: &str, title: &str) -> Candidate {
        Candidate {
            id: id.to_string(),
            title: title.to_string(),
            channel: String::new(),
            duration_ms: None,
            url: None,
            song: false,
        }
    }

    fn seen(length: u64, artist: &str) -> Found {
        Found {
            duration_ms: length * 1000,
            artist: artist.to_string(),
            ..Found::default()
        }
    }

    #[test]
    fn every_job_is_handed_back_once() {
        let done = Mutex::new(Vec::new());
        in_parallel(
            20,
            |position| position * 2,
            |value| done.lock().unwrap().push(value),
        );

        let mut done = done.into_inner().unwrap();
        done.sort();
        assert_eq!(done, (0..20).map(|position| position * 2).collect::<Vec<_>>());
    }

    #[test]
    fn nothing_to_fetch_does_not_hang() {
        let mut ran = 0;
        in_parallel(0, |position| position, |_| ran += 1);
        assert_eq!(ran, 0);
    }

    #[test]
    fn takes_the_last_path_yt_dlp_printed() {
        let stdout = b"[youtube] Extracting URL\n/path/to/Hey Jude.mp3\n";
        assert_eq!(
            produced_path(stdout),
            Some(PathBuf::from("/path/to/Hey Jude.mp3"))
        );
        assert_eq!(produced_path(b""), None);
    }

    #[test]
    fn asks_for_a_search_rather_than_a_link() {
        let song = meta("Hey Jude", &["The Beatles"], 431);
        // Without the `ytsearch` prefix yt-dlp reads it as a URL and refuses.
        assert_eq!(
            format!("ytsearch{HITS}:{} (audio)", video_query(&song)),
            "ytsearch12:The Beatles - Hey Jude (audio)"
        );
        assert_eq!(video_query(&song), "The Beatles - Hey Jude");

        // The music search is handed a link, which is how its own shelf is
        // read, and the name goes first because that is the order the
        // catalogue answers best in.
        assert_eq!(music_query(&song), "Hey Jude - The Beatles");
    }

    #[test]
    fn reads_the_hits_a_search_printed() {
        let stdout = br#"
            {"id": "one", "title": "The Beatles - Hey Jude", "channel": "The Beatles"}
            {"id": "two", "title": "Hey Jude (Remastered)", "uploader": "Someone"}
            not json at all
        "#;

        let hits = parse_hits(stdout, false);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id, "one");
        assert_eq!(hits[0].channel, "The Beatles");
        // The uploader stands in for the channel when there is none.
        assert_eq!(hits[1].channel, "Someone");
        assert!(!hits[0].song);

        // What the catalogue answered with is a song rather than a video.
        assert!(parse_hits(stdout, true).iter().all(|hit| hit.song));
    }

    #[test]
    fn passes_over_a_hit_with_nothing_to_go_on() {
        // A hit with no id, or no name, is not one that can be downloaded.
        assert!(parse_hits(br#"{"title": "Hey Jude"}"#, false).is_empty());
        assert!(parse_hits(br#"{"id": "one"}"#, false).is_empty());
        // A look-up that printed nothing said nothing.
        assert!(found_in("").is_none());
    }

    #[test]
    fn reads_the_fields_a_look_up_printed() {
        let found = found_in("252.5\tDuality\tSlipknot - Topic\tSlipknot\tVol. 3\tFalse").unwrap();

        assert_eq!(found.duration_ms, 252_500);
        assert_eq!(found.title, "Duality");
        assert_eq!(found.channel, "Slipknot - Topic");
        assert_eq!(found.artist, "Slipknot");
        assert_eq!(found.album, "Vol. 3");
        assert!(!found.live);

        // A live stream says how long it is by not saying at all.
        let live = found_in("NA\tA stream\tSomeone\t\t\tTrue").unwrap();
        assert!(live.live);
        assert_eq!(live.duration_ms, 0);
    }

    #[test]
    fn a_hit_of_another_song_is_not_the_song() {
        let song = meta("Hey Jude", &["The Beatles"], 431);

        assert!(carries(&song.title, "The Beatles - Hey Jude (Official Audio)"));
        assert!(!carries(&song.title, "Hey Bulldog"));
        assert!(!carries(&song.title, "Hey Jude Part Two"));
    }

    #[test]
    fn an_edition_of_a_song_is_still_that_song() {
        // A hit is free to leave out what names the edition.
        assert!(carries("Hey Jude - Remastered 2009", "The Beatles - Hey Jude"));
        assert!(carries("Hey Jude (feat. Someone)", "Hey Jude"));
        assert!(carries("Hey Jude (Live)", "Hey Jude"));

        // A part of a name is part of the name.
        assert!(!carries("Movement - Part 1", "Movement"));
        assert!(!carries("Movement (Part 2)", "Movement"));
    }

    #[test]
    fn a_live_or_covered_take_is_not_the_song() {
        assert!(stray_aside("Hey Jude (Live at Wembley)", "Hey Jude"));
        assert!(stray_aside("Hey Jude (Cover)", "Hey Jude"));
        assert!(stray_aside("Hey Jude - Sped Up", "Hey Jude"));

        // A song that is itself live is not held to it.
        assert!(!stray_aside("Hey Jude (Live at Wembley)", "Hey Jude (Live)"));
        // And a word in the name is not an aside.
        assert!(!stray_aside("Live and Let Die", "Live and Let Die"));
    }

    #[test]
    fn a_live_song_prefers_a_live_take() {
        // The name says which take the song is, so a hit that leaves the word
        // out is another take of it.
        assert!(other_take("Duality", "Duality (Live)"));
        assert!(!other_take("Duality (Live)", "Duality (Live)"));
        assert!(!other_take("Slipknot - Duality LIVE (Audio)", "Duality (Live)"));

        // A song that names no take is not held to one.
        assert!(!other_take("Duality", "Duality"));
        assert!(!other_take("Duality (Remastered 2011)", "Duality"));
    }

    #[test]
    fn a_song_is_named_the_way_the_catalogue_names_it() {
        // A soundtrack title says where the song was taken from, which a hit
        // is free to leave out. Only the song's own name has to be there.
        let song = "Sunflower - Spider-Man: Into the Spider-Verse";
        assert_eq!(name_words(song), vec!["sunflower".to_string()]);
        assert!(carries(song, "Post Malone, Swae Lee - Sunflower"));
        assert!(carries(song, "Sunflower (Spider-Man: Into the Spider-Verse)"));

        assert!(carries("Song - From the Film Barbie", "Artist - Song"));
        assert!(carries("Song (From the Film Barbie)", "Artist - Song"));

        // The name itself is still required.
        assert!(!carries("Song - From the Film Barbie", "Artist - Something Else"));
    }

    #[test]
    fn a_word_the_song_is_named_after_is_not_a_stray() {
        // The song's own name carries the word, so a hit that repeats it is
        // not another take of the song.
        assert!(!stray_aside("Artist - Cover Me", "Cover Me"));
        assert!(!stray_aside("Artist - Live and Let Die", "Live and Let Die"));
        // A word the name does not carry still gives it away.
        assert!(stray_aside("Artist - Cover Me (Live)", "Cover Me"));
    }

    #[test]
    fn an_apostrophe_does_not_stand_in_for_a_different_word() {
        assert_eq!(words("God's Plan"), vec!["gods".to_string(), "plan".to_string()]);
        assert!(carries("God's Plan", "Drake - Gods Plan"));
        assert!(carries("God's Plan", "Drake - God's Plan"));
    }

    #[test]
    fn a_length_that_agrees_is_worth_more_than_one_that_does_not() {
        assert!(length_points(Some(0)) > length_points(Some(4_000)));
        assert!(length_points(Some(4_000)) > length_points(Some(9_000)));
        // Nothing to judge it by is neither a gain nor a loss.
        assert_eq!(length_points(None), 2);
    }

    #[test]
    fn keeps_only_the_hits_that_could_be_the_song() {
        let song = meta("Duality", &["Slipknot"], 252);

        let hits = usable(
            vec![
                hit("3GWwohI5h1w", "Duality"),
                hit("mexXOdAF50g", "Toxicity"),
                hit("XleS8FUQnuw", "Duality (Nightcore)"),
                // A search can answer with a channel or a playlist, which is
                // not something a song can be downloaded from.
                hit("UClYV6hHlupm_S_ObS1W-DYw", "Duality"),
            ],
            &song,
        );

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "3GWwohI5h1w");

        assert!(video_id("3GWwohI5h1w"));
        assert!(video_id("kPa7bsKwL-c"));
        assert!(!video_id("UClYV6hHlupm_S_ObS1W-DYw"));
        assert!(!video_id("PL123"));
        assert!(!video_id(""));
    }

    #[test]
    fn a_karaoke_channel_is_not_the_song() {
        // The song's name is in the title and the length is close enough, so
        // what the channel calls itself is what gives it away.
        assert!(stray_name("Ameritz Karaoke Band - Topic"));
        assert!(stray_name("Some Cover Channel"));
        assert!(!stray_name("Slipknot"));
        assert!(!stray_name("Slipknot - Topic"));

        let song = meta("Duality", &["Slipknot"], 252);
        let karaoke = Found {
            title: "Duality (In The Style Of Slipknot)".to_string(),
            channel: "Ameritz Karaoke Band - Topic".to_string(),
            artist: "Ameritz Audio Karaoke".to_string(),
            ..seen(255, "")
        };
        assert!(!answers(
            &song,
            &hit("k", "Duality (In The Style Of Slipknot)"),
            &karaoke
        ));
    }

    #[test]
    fn a_hit_answers_to_the_artist_as_well_as_the_name() {
        let song = meta("Duality", &["Slipknot"], 252);

        let mine = Found {
            title: "Duality".to_string(),
            channel: "Slipknot - Topic".to_string(),
            ..seen(252, "")
        };
        assert!(answers(&song, &hit("one", "Duality"), &mine));

        let theirs = Found {
            title: "Duality".to_string(),
            channel: "Some Cover Channel".to_string(),
            ..seen(252, "")
        };
        assert!(!answers(&song, &hit("two", "Duality"), &theirs));

        // The artist named in the hit's own title is enough.
        let titled = seen(252, "Slipknot");
        assert!(answers(&song, &hit("three", "Slipknot - Duality"), &titled));
    }

    #[test]
    fn a_song_of_another_length_is_not_the_song() {
        let song = meta("Duality", &["Slipknot"], 252);

        assert_eq!(gap_of(&song, &seen(252, "Slipknot")), Some(0));
        assert_eq!(gap_of(&song, &seen(253, "Slipknot")), Some(1000));
        assert_eq!(gap_of(&song, &seen(0, "Slipknot")), Some(252_000));
        assert_eq!(gap_of(&TrackMeta::default(), &seen(252, "Slipknot")), None);
    }

    #[test]
    fn says_how_far_off_the_closest_was() {
        assert_eq!(seconds(1200), "1.2s");
        assert_eq!(seconds(45_000), "45s");
    }

    #[test]
    fn prefers_the_hit_that_names_the_artist() {
        let song = meta("Hey Jude", &["The Beatles"], 431);

        let mine = hit("one", "The Beatles - Hey Jude");
        let theirs = hit("two", "Hey Jude (Official Audio)");
        assert!(rank(&song, &mine) > rank(&song, &theirs));
    }

    #[test]
    fn an_edited_upload_is_recognised_by_its_title() {
        assert!(edited_aside("Hey Jude (Clean)", "Hey Jude"));
        assert!(edited_aside("Hey Jude [Clean Version]", "Hey Jude"));
        assert!(edited_aside("Hey Jude - Censored", "Hey Jude"));
        assert!(edited_aside("Hey Jude (No Swearing)", "Hey Jude"));

        // A song that says it of itself is not held to it.
        assert!(!edited_aside("Hey Jude (Clean)", "Hey Jude (Clean)"));
        // And an ordinary title says nothing of the sort.
        assert!(!edited_aside("The Beatles - Hey Jude (Remastered)", "Hey Jude"));
    }

    #[test]
    fn a_channel_that_only_posts_clean_audio_is_recognised() {
        assert!(edited_name("Kidz Bop Kids"));
        assert!(edited_name("Clean Radio Hits"));
        assert!(!edited_name("The Beatles"));
        assert!(!edited_name("Radiohead - Topic"));
    }

    #[test]
    fn the_artists_own_upload_is_recognised() {
        let song = meta("Duality", &["Slipknot"], 252);

        assert!(official_channel(&song, "Slipknot - Topic"));
        assert!(official_channel(&song, "Slipknot"));
        assert!(!official_channel(&song, "Some Lyric Channel"));
        assert!(!official_channel(&TrackMeta::default(), "Slipknot"));

        // A topic channel is only the artist's when it is named after them,
        // or a tribute album filed under another name would count as theirs.
        assert!(!official_channel(&song, "Release - Topic"));
        assert!(!official_channel(&song, "Frank Rivers - Topic"));
        assert!(official_channel(&song, "Slipknot - topic"));

        // The spelling a catalogue decorates a name with is not another name.
        let korn = meta("Freak On a Leash", &["Ko\u{042f}n"], 256);
        assert!(official_channel(&korn, "Korn - Topic"));
    }

    #[test]
    fn an_edited_upload_ranks_below_the_song_itself() {
        let song = meta("Duality", &["Slipknot"], 252);

        let edited = hit("one", "Slipknot - Duality (Clean)");
        let song_hit = hit("two", "Slipknot - Duality");
        assert!(rank(&song, &song_hit) > rank(&song, &edited));

        // Even when the edited one names the artist and the other does not.
        let plain = hit("three", "Duality (Official Audio)");
        assert!(rank(&song, &plain) > rank(&song, &edited));
    }

    #[test]
    fn the_artists_own_upload_is_told_from_somebody_elses() {
        let song = meta("Duality", &["Slipknot"], 252);

        let own = Found {
            channel: "Slipknot - Topic".to_string(),
            ..seen(252, "Slipknot")
        };
        assert!(own_upload(&song, &hit("one", "Duality"), &own));

        // YouTube vouching for the channel is enough on its own.
        let vouched = Found {
            channel: "Some Channel".to_string(),
            verified: true,
            ..seen(252, "Slipknot")
        };
        assert!(own_upload(&song, &hit("two", "Duality"), &vouched));

        let theirs = Found {
            channel: "Lyrics Videos".to_string(),
            ..seen(252, "Slipknot")
        };
        assert!(!own_upload(&song, &hit("three", "Duality"), &theirs));
    }

    #[test]
    fn the_search_alone_can_settle_a_hit() {
        let song = meta("Duality", &["Slipknot"], 252);

        let own = Candidate {
            id: "one".to_string(),
            title: "Duality".to_string(),
            channel: "Slipknot - Topic".to_string(),
            duration_ms: Some(252_000),
            url: None,
            song: false,
        };
        assert!(settled(&song, &own));

        // Somebody else's upload is not settled, however close it runs.
        let theirs = Candidate {
            channel: "Lyrics Videos".to_string(),
            ..own.clone()
        };
        assert!(!settled(&song, &theirs));

        // Nor is one that runs to another length.
        let off = Candidate {
            duration_ms: Some(270_000),
            ..own.clone()
        };
        assert!(!settled(&song, &off));

        // Nor an edited one, and a length alone is not enough either.
        let edited = Candidate {
            title: "Duality (Clean)".to_string(),
            ..own.clone()
        };
        assert!(!settled(&song, &edited));

        let unmeasured = Candidate {
            duration_ms: None,
            ..own.clone()
        };
        assert!(!settled(&song, &unmeasured));
    }

    #[test]
    fn a_pasted_link_is_downloaded_as_it_stands() {
        let song = TrackMeta {
            title: "Song".to_string(),
            artists: vec!["Artist".to_string()],
            source_url: Some("https://www.youtube.com/watch?v=abc".to_string()),
            ..TrackMeta::default()
        };

        let chosen = candidates(&tools(None, None), &song).unwrap();
        assert_eq!(chosen.len(), 1);
        assert_eq!(chosen[0].target(), "https://www.youtube.com/watch?v=abc");
    }

    #[test]
    fn reads_the_songs_a_pasted_link_points_at() {
        let printed = br#"
            {"id": "one", "title": "Artist - Song (Official Video)", "channel": "Artist", "duration": 252.5, "webpage_url": "https://www.youtube.com/watch?v=one", "playlist_title": "An album"}
            {"id": "two", "title": "Other", "uploader": "Other", "duration": 100}
        "#;

        let entries = json_lines(printed);
        assert_eq!(playlist_name(&entries).as_deref(), Some("An album"));

        let songs: Vec<LinkEntry> = entries.iter().filter_map(link_entry).collect();
        assert_eq!(songs.len(), 2);
        // The artist comes off the title when the video carries none of its own.
        assert_eq!(songs[0].title, "Song (Official Video)");
        assert_eq!(songs[0].artists, vec!["Artist"]);
        assert_eq!(songs[0].duration_ms, Some(252_500));
        // A line with no link of its own is still the video it names.
        assert_eq!(songs[1].url, "https://www.youtube.com/watch?v=two");
        assert_eq!(songs[1].artists, vec!["Other"]);
    }

    #[test]
    fn takes_the_catalogues_own_credit_when_a_video_carries_one() {
        let entry = serde_json::json!({
            "id": "one",
            "title": "Freak On a Leash",
            "channel": "KoRn - Topic",
            "artist": "Korn",
            "album": "Follow The Leader",
            "duration": 256
        });

        let song = link_entry(&entry).unwrap();
        assert_eq!(song.title, "Freak On a Leash");
        assert_eq!(song.artists, vec!["Korn"]);
        assert_eq!(song.album, "Follow The Leader");

        // A topic channel names the artist behind it.
        assert_eq!(channel_artist("KoRn - Topic"), vec!["KoRn"]);
        assert_eq!(channel_artist(" KoRn "), vec!["KoRn"]);
        assert!(channel_artist("   ").is_empty());
    }

    #[test]
    fn the_name_in_one_piece_ranks_above_the_name_in_bits() {
        assert!(in_one_piece("Hey Jude", "The Beatles - Hey Jude"));
        assert!(in_one_piece("Hey Jude", "Hey Jude (Official Audio)"));
        assert!(!in_one_piece("Hey Jude", "Jude Hey (Official Audio)"));
        assert!(in_one_piece("Hey Jude (Live)", "Hey Jude"));
    }

    #[test]
    fn keeps_the_extension_placeholder_intact() {
        let template = output_template(Path::new(r"C:\songs\Hey Jude.mp3"));
        assert!(template.ends_with(r"Hey Jude.%(ext)s"), "{template}");
        // The doubled percent is for a literal one in the title, not this.
        assert!(!template.contains("%%(ext)"), "{template}");
    }

    #[test]
    fn escapes_a_percent_in_the_title() {
        let template = output_template(Path::new(r"C:\songs\100% Pure.mp3"));
        assert!(template.ends_with(r"100%% Pure.%(ext)s"), "{template}");
    }

    #[test]
    fn reports_the_last_line_of_a_failure() {
        let stderr = b"WARNING: something\nERROR: Video unavailable\n";
        assert_eq!(last_line(stderr).as_deref(), Some("ERROR: Video unavailable"));
    }

    fn tools(cookies: Option<&str>, browser: Option<&str>) -> Tools {
        Tools {
            yt_dlp: YtDlp::Exe(PathBuf::from("yt-dlp")),
            ffmpeg: None,
            deno: None,
            cookies: cookies.map(PathBuf::from),
            browser: browser.map(str::to_string),
            log: None,
        }
    }

    #[test]
    fn points_yt_dlp_at_the_runtime_that_shipped() {
        // Without one, yt-dlp is left to find a runtime of its own.
        assert!(js_args(&tools(None, None)).is_empty());

        let mut shipped = tools(None, None);
        shipped.deno = Some(PathBuf::from("/opt/wave/tools/deno"));
        assert_eq!(
            js_args(&shipped),
            vec!["--js-runtimes", "deno:/opt/wave/tools/deno"]
        );
    }

    #[test]
    fn asks_for_the_cookies_a_signed_in_download_needs() {
        assert!(cookie_args(&tools(None, None)).is_empty());
        assert_eq!(
            cookie_args(&tools(None, Some("firefox"))),
            vec!["--cookies-from-browser", "firefox"]
        );
        // An exported file wins over the browser it may have come from.
        assert_eq!(
            cookie_args(&tools(Some("cookies.txt"), Some("firefox"))),
            vec!["--cookies", "cookies.txt"]
        );
    }

    #[test]
    fn says_what_to_do_about_the_age_wall() {
        let wall = "ERROR: [youtube] XhFzKhTFY3I: Sign in to confirm your age. Use --cookies-from-browser";
        let advice = friendly(wall, &tools(None, None));
        assert!(advice.contains("YTDLP_COOKIES_FROM_BROWSER"), "{advice}");

        // Anything else is left as yt-dlp said it.
        assert_eq!(friendly("ERROR: Video unavailable", &tools(None, None)), "ERROR: Video unavailable");

        // With cookies set, the refusal is passed through so it can be read.
        assert_eq!(friendly(wall, &tools(None, Some("firefox"))), wall);
    }

    #[test]
    fn reads_a_failure_from_either_stream() {
        assert_eq!(
            failure_reason(b"ERROR: Video unavailable\n", b"").as_deref(),
            Some("ERROR: Video unavailable")
        );
        assert_eq!(
            failure_reason(b"", b"/tmp/a.mp3\nERROR: Sign in to confirm your age\n").as_deref(),
            Some("ERROR: Sign in to confirm your age")
        );
        // A printed path is not a reason.
        assert_eq!(failure_reason(b"", b"/tmp/a.mp3\n"), None);
    }

    #[test]
    fn clears_what_an_earlier_attempt_left() {
        let dir = std::env::temp_dir().join("wave-download-clear");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let keep = dir.join("audio.mp3");
        fs::write(&keep, b"the song").unwrap();
        fs::write(dir.join("audio.webm"), b"half a download").unwrap();
        fs::create_dir_all(dir.join("nested")).unwrap();

        clear(&dir, &keep);

        assert!(keep.is_file());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    }

    /// A few frames of silence, so a tag has something real to be written into.
    /// A reader needs a second frame after the first to believe the sync.
    fn silent_mp3(dir: &Path) -> PathBuf {
        let path = dir.join("silence.mp3");
        let mut frame = vec![0xFF, 0xFB, 0x90, 0x00];
        frame.resize(417, 0);
        let mut file = Vec::new();
        for _ in 0..8 {
            file.extend_from_slice(&frame);
        }
        fs::write(&path, file).unwrap();
        path
    }

    #[test]
    fn writes_the_length_the_source_gave() {
        let dir = std::env::temp_dir().join("wave-download-length");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = silent_mp3(&dir);

        tag(&path, &meta("Duality", &["Slipknot"], 252), None).unwrap();

        // The length is the one the lyrics are looked up with later, so it has
        // to survive the round trip through the file.
        let tagged = lofty::read_from_path(&path).unwrap();
        let written = tagged
            .primary_tag()
            .and_then(|tag| tag.get_string(ItemKey::Length));
        assert_eq!(written, Some("252000"));
    }

    #[test]
    fn keeps_the_cover_the_playlist_already_fetched() {
        let dir = std::env::temp_dir().join("wave-download-cover");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cover.jpg");
        fs::write(&path, b"the cover bytes").unwrap();

        // The file on disk wins, so a download never loses a cover it has.
        assert_eq!(
            cover_bytes(Some(&path), Some("http://127.0.0.1:1/nowhere.jpg")).as_deref(),
            Some(&b"the cover bytes"[..])
        );
        assert_eq!(cover_bytes(None, None), None);
        assert_eq!(cover_bytes(Some(&dir.join("absent.jpg")), None), None);
    }
}
