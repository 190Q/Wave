use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::{Accessor, AudioFile, TagExt};
use lofty::tag::{ItemKey, Tag, TagType};
use serde_json::Value;

use crate::import_source::fold;
use crate::source::{client, encode, Env, TrackMeta};
use crate::tools::{find_yt_dlp, hide_console, tool_path, YtDlp};

const AUDIO_STEM: &str = "audio";

/// How many hits a search is read for, and how many of the hits that turn out
/// not to be the song are looked past before it is given up on. A look-up is a
/// request of its own, so a search full of wrong answers stops early.
const HITS: usize = 12;
const LOOK_PAST: usize = 4;

/// How far a hit's length may sit from the source's and still be the same
/// recording. LRCLIB, which the lyrics come from, allows two seconds.
const LENGTH_WINDOW_MS: u64 = 5_000;

/// A hit this close to the source's length is the recording, so there is
/// nothing to gain by looking at any more of them.
const CLOSE_ENOUGH_MS: u64 = 1_500;

/// What the mp3 encoder can add to the length of what it was given.
const FILE_SLACK_MS: u64 = 1_000;

/// The fields a look-up asks for, in the order they are read back.
const FIELDS: &str =
    "%(duration)s\t%(title)s\t%(channel,uploader)s\t%(artist)s\t%(album)s\t%(is_live)s";

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

const PARTS: [&str; 5] = ["part", "pt", "vol", "volume", "chapter"];
pub struct Tools {
    pub yt_dlp: YtDlp,
    pub ffmpeg: Option<PathBuf>,
    pub cookies: Option<PathBuf>,
    pub browser: Option<String>,
}

impl Tools {
    /// The folder yt-dlp should look in for ffmpeg, when it is not on PATH.
    fn ffmpeg_dir(&self) -> Option<PathBuf> {
        self.ffmpeg
            .as_ref()
            .and_then(|path| path.parent().map(Path::to_path_buf))
    }
}

pub fn resolve_tools(env: &Env) -> Result<Tools, String> {
    let yt_dlp = find_yt_dlp(env.yt_dlp.as_ref()).ok_or_else(|| {
        "yt-dlp was not found. Install it, or set YTDLP_PATH in the config .env.".to_string()
    })?;

    Ok(Tools {
        yt_dlp,
        ffmpeg: tool_path(env.ffmpeg.as_ref(), "ffmpeg"),
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
    })
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
}

impl Candidate {
    fn url(&self) -> String {
        format!("https://www.youtube.com/watch?v={}", self.id)
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
}

/// `false` means the file was already there, so a re-run picks up where the last
/// left off.
pub fn download(
    tools: &Tools,
    meta: &TrackMeta,
    out_dir: &Path,
    cover: Option<&Path>,
) -> Result<bool, String> {
    let target = out_dir.join(format!("{AUDIO_STEM}.mp3"));

    if target.is_file() {
        return Ok(false);
    }

    fs::create_dir_all(out_dir).map_err(|e| format!("could not create {}: {e}", out_dir.display()))?;

    let path = match fetch(tools, meta, out_dir, &target) {
        Ok(path) => path,
        Err(error) => {
            let _ = fs::remove_dir_all(out_dir);
            return Err(error);
        }
    };

    tag(&path, meta, cover_bytes(cover, meta.cover_url.as_deref()))
        .map_err(|e| format!("downloaded, but could not tag it: {e}"))?;

    Ok(true)
}

fn fetch(tools: &Tools, meta: &TrackMeta, out_dir: &Path, target: &Path) -> Result<PathBuf, String> {
    let mut failures: Vec<String> = Vec::new();

    for candidate in choose(tools, meta)? {
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

fn choose(tools: &Tools, meta: &TrackMeta) -> Result<Vec<Candidate>, String> {
    let mut passed: Vec<(u64, usize, Candidate)> = Vec::new();
    let mut closest: Option<u64> = None;
    let mut wrong = 0usize;

    for (order, candidate) in search(tools, meta)?.into_iter().enumerate() {
        if wrong >= LOOK_PAST {
            break;
        }
        let Some(seen) = look_up(tools, &candidate) else {
            wrong += 1;
            continue;
        };
        if seen.live || !answers(meta, &candidate, &seen) {
            wrong += 1;
            continue;
        }

        match gap_of(meta, &seen) {
            // Another take of the song, or another thing entirely.
            Some(gap) if gap > LENGTH_WINDOW_MS => {
                if seen.duration_ms > 0 {
                    closest = Some(closest.map_or(gap, |best| best.min(gap)));
                }
            }
            Some(gap) if gap <= CLOSE_ENOUGH_MS => return Ok(vec![candidate]),
            gap => passed.push((gap.unwrap_or(0), order, candidate)),
        }
    }

    if passed.is_empty() {
        return Err(match closest {
            Some(gap) => format!("no YouTube match; the closest was {} off", seconds(gap)),
            None => "no YouTube match".to_string(),
        });
    }

    passed.sort_by_key(|(gap, order, _)| (*gap, *order));
    Ok(passed.into_iter().map(|(_, _, candidate)| candidate).collect())
}

fn search(tools: &Tools, meta: &TrackMeta) -> Result<Vec<Candidate>, String> {
    let mut hits = usable(music_hits(tools, meta).unwrap_or_default(), meta);
    if hits.is_empty() {
        hits = usable(youtube_hits(tools, meta)?, meta);
    }

    let mut seen = HashSet::new();
    hits.retain(|hit| seen.insert(hit.id.clone()));

    hits.sort_by_key(|hit| std::cmp::Reverse(rank(meta, hit)));
    Ok(hits)
}

fn usable(hits: Vec<Candidate>, meta: &TrackMeta) -> Vec<Candidate> {
    hits.into_iter()
        .filter(|hit| {
            carries(&meta.title, &hit.title)
                && !stray_aside(&hit.title, &meta.title)
                && !stray_name(&hit.channel)
        })
        .collect()
}

/// YouTube Music, restricted to its songs section: what comes back is the song
/// as the catalogue lists it, not a video somebody made.
fn music_hits(tools: &Tools, meta: &TrackMeta) -> Result<Vec<Candidate>, String> {
    let query = encode(&query_text(meta));
    let target = format!("https://music.youtube.com/search?q={query}#songs");

    Ok(parse_hits(&run_search(tools, &target)?))
}

/// A plain YouTube search, for the songs YouTube Music does not carry.
fn youtube_hits(tools: &Tools, meta: &TrackMeta) -> Result<Vec<Candidate>, String> {
    let target = format!("ytsearch{HITS}:{} (audio)", query_text(meta));

    Ok(parse_hits(&run_search(tools, &target)?))
}

/// What both sources are asked for. The artists come first, which is how a
/// music catalogue expects a song to be named.
fn query_text(meta: &TrackMeta) -> String {
    format!("{} - {}", meta.artists.join(", "), meta.title)
}

/// A search, which reads the results rather than downloading anything.
fn run_search(tools: &Tools, target: &str) -> Result<Vec<u8>, String> {
    let mut command = yt_dlp_command(&tools.yt_dlp);
    command.args(cookie_args(tools));
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
fn parse_hits(stdout: &[u8]) -> Vec<Candidate> {
    String::from_utf8_lossy(stdout)
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('{'))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|entry| candidate_of(&entry))
        .collect()
}

fn candidate_of(entry: &Value) -> Option<Candidate> {
    let id = entry["id"].as_str().filter(|id| !id.is_empty())?;
    let title = entry["title"].as_str().unwrap_or_default().trim().to_string();
    if title.is_empty() {
        return None;
    }

    Some(Candidate {
        id: id.to_string(),
        title,
        channel: text_of(entry, &["channel", "uploader"]),
    })
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
    command
        .arg("--skip-download")
        .arg("--no-warnings")
        .args(player_args())
        .arg("--print")
        .arg(FIELDS)
        .arg(candidate.url());
    hide_console(&mut command);

    let output = command.output().ok()?;
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
    })
}

/// Whether a hit answers to the song: the same name, the artist named
/// somewhere, and nothing about it that says it is another take.
fn answers(meta: &TrackMeta, candidate: &Candidate, seen: &Found) -> bool {
    let title = match seen.title.trim() {
        "" => candidate.title.as_str(),
        named => named,
    };
    if !carries(&meta.title, title)
        || stray_aside(title, &meta.title)
        || stray_name(&seen.channel)
        || stray_name(&seen.artist)
        || stray_name(&candidate.channel)
    {
        return false;
    }

    meta.artists.is_empty()
        || artist_here(meta, &seen.artist)
        || artist_here(meta, &seen.channel)
        || artist_here(meta, &candidate.channel)
        || artist_here(meta, title)
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
/// title does not say the same of itself.
fn stray_aside(title: &str, song: &str) -> bool {
    let mine = asides(song);

    asides(title)
        .into_iter()
        .any(|word| STRAYS.contains(&word.as_str()) && !mine.contains(&word))
}

/// Whether a name that only says who made the upload, a channel or an artist,
/// carries a word marking it as something other than the song.
fn stray_name(text: &str) -> bool {
    words(text)
        .iter()
        .any(|word| STRAYS.contains(&word.as_str()))
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
/// sits in brackets, and a trailing part after a dash.
fn asides(title: &str) -> HashSet<String> {
    let mut found = HashSet::new();

    for group in groups(title) {
        let inside = words(&group);
        if inside.iter().any(|word| is_edition(word) || is_year(word)) {
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
        score += 2;
    }
    if artist_here(meta, &candidate.title) || artist_here(meta, &candidate.channel) {
        score += 1;
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
/// that is not a letter or a digit between them.
fn words(text: &str) -> Vec<String> {
    fold(text)
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
        .args(player_args())
        .arg("--print")
        .arg("after_move:filepath")
        .arg("-o")
        .arg(&template);

    if let Some(dir) = tools.ffmpeg_dir() {
        command.arg("--ffmpeg-location").arg(dir);
    }

    command.arg(candidate.url());
    hide_console(&mut command);

    let output = command
        .output()
        .map_err(|e| format!("could not run yt-dlp: {e}"))?;

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
            format!("ytsearch{HITS}:{} (audio)", query_text(&song)),
            "ytsearch12:The Beatles - Hey Jude (audio)"
        );
        // The music search is handed a link, which is how its own shelf is read.
        assert_eq!(query_text(&song), "The Beatles - Hey Jude");
    }

    #[test]
    fn reads_the_hits_a_search_printed() {
        let stdout = br#"
            {"id": "one", "title": "The Beatles - Hey Jude", "channel": "The Beatles"}
            {"id": "two", "title": "Hey Jude (Remastered)", "uploader": "Someone"}
            not json at all
        "#;

        let hits = parse_hits(stdout);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id, "one");
        assert_eq!(hits[0].channel, "The Beatles");
        // The uploader stands in for the channel when there is none.
        assert_eq!(hits[1].channel, "Someone");
    }

    #[test]
    fn passes_over_a_hit_with_nothing_to_go_on() {
        // A hit with no id, or no name, is not one that can be downloaded.
        assert!(parse_hits(br#"{"title": "Hey Jude"}"#).is_empty());
        assert!(parse_hits(br#"{"id": "one"}"#).is_empty());
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
    fn keeps_only_the_hits_that_could_be_the_song() {
        let song = meta("Duality", &["Slipknot"], 252);

        let hits = usable(
            vec![
                hit("one", "Duality"),
                hit("two", "Toxicity"),
                hit("three", "Duality (Nightcore)"),
            ],
            &song,
        );

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "one");
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
            cookies: cookies.map(PathBuf::from),
            browser: browser.map(str::to_string),
        }
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
