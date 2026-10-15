use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::{Accessor, TagExt};
use lofty::tag::{ItemKey, Tag, TagType};

use crate::source::{client, Env, TrackMeta};
use crate::tools::{find_yt_dlp, hide_console, tool_path, YtDlp};

const AUDIO_STEM: &str = "audio";

/// The external programs the download needs. Neither is a Rust library.
pub struct Tools {
    pub yt_dlp: YtDlp,
    pub ffmpeg: Option<PathBuf>,
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

/// `false` means the file was already there, so a re-run picks up where the last
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

    let query = search_query(meta);
    let template = output_template(&target);

    let mut command = yt_dlp_command(&tools.yt_dlp);
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
        .arg("--extractor-args")
        .arg("youtube:player_client=android,ios,web_safari")
        .arg("--print")
        .arg("after_move:filepath")
        .arg("-o")
        .arg(&template);

    if let Some(dir) = tools.ffmpeg_dir() {
        command.arg("--ffmpeg-location").arg(dir);
    }

    command.arg(&query);
    hide_console(&mut command);

    let output = command
        .output()
        .map_err(|e| format!("could not run yt-dlp: {e}"))?;

    let produced = produced_path(&output.stdout).filter(|path| path.is_file());
    let path = match produced {
        Some(path) => path,
        None if target.is_file() => target.clone(),
        None => {
            let reason = last_line(&output.stderr).unwrap_or_else(|| "no file was produced".to_string());
            return Err(reason);
        }
    };

    // yt-dlp can settle on a different name.
    let path = if path == target {
        path
    } else {
        fs::rename(&path, &target).map(|_| target.clone()).unwrap_or(path)
    };

    tag(&path, meta, cover_bytes(cover, meta.cover_url.as_deref()))
        .map_err(|e| format!("downloaded, but could not tag it: {e}"))?;

    Ok(true)
}

/// yt-dlp is handed a search rather than a link: `ytsearch1:` takes the first
/// hit, which is the whole point of matching a song to a YouTube result.
fn search_query(meta: &TrackMeta) -> String {
    format!(
        "ytsearch1:{} - {} (audio)",
        meta.artists.join(", "),
        meta.title
    )
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
        let meta = TrackMeta {
            title: "Hey Jude".to_string(),
            artists: vec!["The Beatles".to_string()],
            ..TrackMeta::default()
        };
        // Without the `ytsearch1:` prefix yt-dlp reads it as a URL and refuses.
        assert_eq!(search_query(&meta), "ytsearch1:The Beatles - Hey Jude (audio)");
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
