use std::fs;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures::StreamExt;
use tauri::AppHandle;
use ytdown::{CollectionKind, Container, MediaInfo, VideoInfo, Ytdown};

use crate::download::{self, Fetched, Job};
use crate::import::ImportOutcome;
use crate::import_source::{self, ImportPlan, Kind, Link};
use crate::progress::{Output, Reporter};
use crate::source::TrackMeta;
use crate::youtube::{folder_name, youtube_url};

const LIMIT: usize = 500;
const LOOKUPS: usize = 4;
const CHECKED_FOR: Duration = Duration::from_secs(600);
type CheckedLink = (Instant, String, Link);
static CHECKED_LINK: Mutex<Option<CheckedLink>> = Mutex::new(None);

fn extractor() -> Result<Ytdown, String> {
    Ytdown::builder()
        .clear_extractors()
        .extractor(Box::new(ytdown::extractor::youtube::YoutubeExtractor::new()))
        .build()
        .map_err(|error| format!("Could not start the YouTube downloader: {error}"))
}

fn playlist_title(url: &str) -> Option<String> {
    let response = crate::source::client()
        .get("https://www.youtube.com/oembed")
        .query(&[("url", url), ("format", "json")])
        .timeout(std::time::Duration::from_secs(10))
        .send().ok()?.error_for_status().ok()?;
    let value: serde_json::Value = response.json().ok()?;
    value.get("title")?.as_str().map(str::trim).filter(|name| !name.is_empty()).map(str::to_string)
}

pub(crate) fn plan(app: &AppHandle, url: &str) -> Result<ImportPlan, String> {
    let url = youtube_url(url)?;
    let yt = extractor()?;
    *CHECKED_LINK.lock().unwrap_or_else(|error| error.into_inner()) = None;
    let mut checked = None;
    let plan = import_source::plan(app, Output::Events, |report| {
        let link = resolve(&yt, &url, report)?;
        checked = Some(link.clone());
        Ok(link)
    })?;
    *CHECKED_LINK.lock().unwrap_or_else(|error| error.into_inner()) =
        checked.map(|link| (Instant::now(), url, link));
    Ok(plan)
}

pub(crate) fn run(app: &AppHandle, url: &str, duplicates: bool) -> Result<ImportOutcome, String> {
    let url = youtube_url(url)?;
    let yt = extractor()?;
    let checked = take_checked(
        &mut CHECKED_LINK.lock().unwrap_or_else(|error| error.into_inner()),
        &url,
        Instant::now(),
    );
    import_source::run_phone(app, duplicates, |report| {
        if let Some(link) = checked {
            report.phase("resolving", "Using the checked YouTube link.");
            Ok(link)
        } else {
            resolve(&yt, &url, report)
        }
    }, |jobs, keep| {
        for job in jobs {
            keep(Fetched { key: job.key, file: fetch(&yt, job) });
            let _ = fs::remove_dir_all(&job.dir);
        }
    })
}

fn take_checked(slot: &mut Option<CheckedLink>, url: &str, now: Instant) -> Option<Link> {
    let (created, checked_url, link) = slot.take()?;
    (checked_url == url && now.saturating_duration_since(created) <= CHECKED_FOR).then_some(link)
}

async fn playlist_tracks<F, Fut>(
    entries: ytdown::EntryStream,
    lookup: F,
    report: &mut Reporter,
    limit: usize,
) -> Result<Vec<TrackMeta>, String>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Option<TrackMeta>>,
{
    let mut resolved = entries.take(limit).map(|entry| {
        let lookup = &lookup;
        async move {
            let entry = entry.map_err(|error| format!("Could not read the YouTube playlist: {error}"))?;
            if entry.id.len() != 11 || !entry.id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') {
                return Err("The YouTube playlist contains an invalid video ID.".to_string());
            }
            let source_url = format!("https://www.youtube.com/watch?v={}", entry.id);
            let fallback_title = entry.title.unwrap_or(entry.id);
            let (title, artists) = download::credit(&fallback_title, "", "");
            let fallback = TrackMeta {
                title,
                artists,
                duration_ms: entry.duration.map(|duration| duration.as_millis() as u64),
                source_url: Some(source_url.clone()),
                ..TrackMeta::default()
            };
            Ok(lookup(source_url).await.unwrap_or(fallback))
        }
    }).buffered(LOOKUPS);
    let mut tracks = Vec::new();
    while let Some(meta) = resolved.next().await {
        let meta = meta?;
        report.at(tracks.len() + 1, &meta.title);
        tracks.push(meta);
    }
    Ok(tracks)
}

fn resolve(yt: &Ytdown, url: &str, report: &mut Reporter) -> Result<Link, String> {
    resolve_with_limit(yt, url, report, LIMIT)
}

fn resolve_with_limit(yt: &Ytdown, url: &str, report: &mut Reporter, limit: usize) -> Result<Link, String> {
    report.phase("resolving", "Reading the YouTube link.");
    let playlist_title = if url.contains("/playlist?") { playlist_title(url) } else { None };
    tauri::async_runtime::block_on(async {
        let media = yt.resolve(url).await.map_err(|error| format!("Could not read the YouTube link: {error}"))?;
        let (kind, name, tracks) = match media {
            MediaInfo::Single(video) => {
                let meta = video_meta(&video);
                (Kind::Single, meta.title.clone(), vec![meta])
            }
            MediaInfo::Collection(collection) if collection.kind == CollectionKind::Playlist => {
                let name = collection.title.or(playlist_title).unwrap_or_else(|| "YouTube playlist".to_string());
                let tracks = playlist_tracks(collection.entries, |source_url| async move {
                    match yt.resolve(&source_url).await {
                        Ok(MediaInfo::Single(video)) => Some(video_meta(&video)),
                        _ => None,
                    }
                }, report, limit).await?;
                (Kind::Collection, name, tracks)
            }
            _ => return Err("Paste a YouTube video or playlist link.".to_string()),
        };
        if tracks.is_empty() {
            return Err("That YouTube link has no videos to download.".to_string());
        }
        Ok(Link { kind, id: folder_name(url), name, tracks })
    })
}

fn video_meta(video: &VideoInfo) -> TrackMeta {
    let (title, artists) = download::credit(&video.title, "", video.uploader.as_deref().unwrap_or(""));
    TrackMeta {
        title,
        artists,
        cover_url: video.thumbnails.iter().max_by_key(|image| image.width.unwrap_or(0)).map(|image| image.url.clone()),
        duration_ms: video.duration.map(|duration| duration.as_millis() as u64),
        source_url: Some(format!("https://www.youtube.com/watch?v={}", video.id)),
        ..TrackMeta::default()
    }
}

fn fetch(yt: &Ytdown, job: &Job<'_>) -> Result<PathBuf, String> {
    let url = job.meta.source_url.as_deref().ok_or("The YouTube video has no link.")?;
    let path = job.dir.join("audio.m4a");
    fs::create_dir_all(&job.dir).map_err(|error| format!("Could not create the download folder: {error}"))?;
    tauri::async_runtime::block_on(async {
        let video = match yt.resolve(url).await.map_err(|error| format!("Could not read the video: {error}"))? {
            MediaInfo::Single(video) => video,
            _ => return Err("The YouTube link did not point to a video.".to_string()),
        };
        if video.is_live {
            return Err("Live streams cannot be downloaded.".to_string());
        }
        let format = video.formats().audio_only().container(&Container::M4a).best_audio()
            .map_err(|_| "YouTube did not provide a compatible audio stream.".to_string())?;
        yt.download(format, &path).resume(false).await
            .map_err(|error| format!("Could not download the audio: {error}"))?;
        Ok::<(), String>(())
    })?;
    download::landed(&path, job.meta)?;
    download::tag(&path, job.meta, download::fetch_cover(job.meta.cover_url.as_deref()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, title: &str) -> ytdown::Entry {
        let mut entry = ytdown::Entry::default();
        entry.id = id.into();
        entry.title = Some(title.into());
        entry.duration = Some(Duration::from_secs(60));
        entry
    }

    #[test]
    fn playlist_entries_remain_ordered_and_unavailable_videos_are_retried() {
        let entries = vec![
            Ok(entry("aaaaaaaaaaa", "First")),
            Ok(entry("bbbbbbbbbbb", "Unavailable")),
            Ok(entry("ccccccccccc", "Last")),
        ];
        let mut report = Reporter::quiet();
        let tracks = tauri::async_runtime::block_on(playlist_tracks(
            Box::pin(futures::stream::iter(entries)),
            |url| async move {
                if url.ends_with("bbbbbbbbbbb") { return None; }
                Some(TrackMeta { title: url.clone(), source_url: Some(url), ..TrackMeta::default() })
            },
            &mut report,
            3,
        )).unwrap();
        assert_eq!(tracks.len(), 3);
        assert!(tracks[0].title.ends_with("aaaaaaaaaaa"));
        assert_eq!(tracks[1].title, "Unavailable");
        assert_eq!(tracks[1].duration_ms, Some(60_000));
        assert!(tracks[1].source_url.as_deref().unwrap().ends_with("bbbbbbbbbbb"));
        assert!(tracks[2].title.ends_with("ccccccccccc"));
    }

    #[test]
    fn playlist_errors_are_reported_and_the_limit_is_respected() {
        let mut report = Reporter::quiet();
        let make_stream = || Box::pin(futures::stream::iter(vec![
            Ok(entry("aaaaaaaaaaa", "First")),
            Ok(entry("bad", "Bad ID")),
        ])) as ytdown::EntryStream;
        let tracks = tauri::async_runtime::block_on(playlist_tracks(
            make_stream(), |_| async { None }, &mut report, 1,
        )).unwrap();
        assert_eq!(tracks.len(), 1);
        let error = tauri::async_runtime::block_on(playlist_tracks(
            make_stream(), |_| async { None }, &mut report, 2,
        )).unwrap_err();
        assert!(error.contains("invalid video ID"));
        let error = tauri::async_runtime::block_on(playlist_tracks(
            Box::pin(futures::stream::iter(vec![Err(ytdown::Error::Network {
                stage: "playlist", message: "offline".into(),
            })])),
            |_| async { None }, &mut report, 1,
        )).unwrap_err();
        assert!(error.contains("offline"));
    }

    #[test]
    fn checked_links_are_used_once_only_for_the_same_recent_url() {
        let now = Instant::now();
        let link = Link { kind: Kind::Collection, id: "id".into(), name: "list".into(), tracks: vec![] };
        let mut slot = Some((now, "url".into(), link.clone()));
        assert_eq!(take_checked(&mut slot, "url", now).unwrap().name, "list");
        assert!(take_checked(&mut slot, "url", now).is_none());
        slot = Some((now, "url".into(), link.clone()));
        assert!(take_checked(&mut slot, "other", now).is_none());
        slot = Some((now, "url".into(), link));
        assert!(take_checked(&mut slot, "url", now + CHECKED_FOR + Duration::from_secs(1)).is_none());
    }

    #[test]
    #[ignore = "requires YouTube network access"]
    fn reads_a_real_youtube_playlist_in_order() {
        let yt = extractor().unwrap();
        let mut report = Reporter::quiet();
        let link = resolve_with_limit(
            &yt,
            "https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf",
            &mut report,
            3,
        ).unwrap();
        assert_eq!(link.kind, Kind::Collection);
        assert_eq!(link.name, "Select Lectures");
        assert_eq!(
            link.tracks.iter().map(|track| track.source_url.as_deref()).collect::<Vec<_>>(),
            vec![
                Some("https://www.youtube.com/watch?v=0VH1Lim8gL8"),
                Some("https://www.youtube.com/watch?v=O5xeyoRL95U"),
            ],
        );
    }

    #[test]
    #[ignore = "requires YouTube network access"]
    fn downloads_a_real_youtube_video_as_tagged_m4a() {
        let yt = extractor().unwrap();
        let mut report = Reporter::quiet();
        let link = resolve(&yt, "https://www.youtube.com/watch?v=jNQXAC9IVRw", &mut report).unwrap();
        assert_eq!(link.kind, Kind::Single);
        let dir = std::env::temp_dir().join(format!("wave-youtube-test-{}", crate::identity::new_id()));
        let job = Job { key: 0, meta: &link.tracks[0], dir: dir.clone(), cover: None };
        let path = fetch(&yt, &job).unwrap();
        assert!(fs::metadata(&path).unwrap().len() > 10_000);
        let tags = lofty::read_from_path(&path).unwrap();
        use lofty::prelude::{Accessor, TaggedFileExt};
        assert_eq!(tags.primary_tag().and_then(|tag| tag.title()).as_deref(), Some(link.tracks[0].title.as_str()));
        fs::remove_dir_all(dir).unwrap();
    }
}
