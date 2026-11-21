use std::fs;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::StreamExt;
use tauri::AppHandle;
use ytdown::{CollectionKind, Container, MediaInfo, VideoInfo, Ytdown};
use ytdown::extractor::{Extractor, ExtractorContext, youtube::YoutubeExtractor};
use ytdown::transport::{HttpClient, HttpRequest, HttpResponse, ReqwestClient};

use crate::download::{self, Fetched, Job};
use crate::import::ImportOutcome;
use crate::import_source::{self, ImportPlan, Kind, Link};
use crate::progress::{Output, Reporter};
use crate::source::TrackMeta;
use crate::youtube::{folder_name, youtube_url};

const LIMIT: usize = 500;
const LOOKUPS: usize = 4;
const SEARCH_HITS: usize = 12;
const SEARCH_MATCHES: usize = 4;
const CHECKED_FOR: Duration = Duration::from_secs(600);
type CheckedLink = (Instant, String, Link);
static CHECKED_LINK: Mutex<Option<CheckedLink>> = Mutex::new(None);

const VISION_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

struct YoutubeTransport(ReqwestClient);

#[async_trait::async_trait]
impl HttpClient for YoutubeTransport {
    async fn execute(&self, mut request: HttpRequest) -> ytdown::Result<HttpResponse> {
        adapt_request(&mut request);
        self.0.execute(request).await
    }
}

fn adapt_request(request: &mut HttpRequest) {
    if !request.url.contains("/youtubei/v1/player?") && !request.url.contains("/youtubei/v1/search?") {
        return;
    }
    let Some(body) = request.body.as_ref() else { return; };
    let Ok(mut body) = serde_json::from_slice::<serde_json::Value>(body) else { return; };
    if request.url.contains("/youtubei/v1/search?") {
        if let Some(query) = body.get_mut("query") {
            if let Some(text) = query.as_str() {
                *query = percent_encoding::percent_decode_str(text).decode_utf8_lossy().into_owned().into();
            }
        }
    } else if body.pointer("/context/client/clientName").and_then(|name| name.as_str()) == Some("ANDROID_VR") {
        // The Android VR client can return capped streams, so prefer visionOS.
        let Some(client) = body.pointer_mut("/context/client").and_then(|client| client.as_object_mut()) else { return; };
        client.remove("androidSdkVersion");
        for (key, value) in [
            ("clientName", "VISIONOS"), ("clientVersion", "1.02"),
            ("deviceMake", "Apple"), ("deviceModel", "RealityDevice17,1"),
            ("osName", "visionOS"), ("osVersion", "26.5.23O471"),
            ("userAgent", VISION_AGENT),
        ] {
            client.insert(key.into(), value.into());
        }
        for (name, value) in &mut request.headers {
            if name.eq_ignore_ascii_case("User-Agent") {
                *value = VISION_AGENT.into();
            } else if name.eq_ignore_ascii_case("X-YouTube-Client-Name") {
                *value = "101".into();
            } else if name.eq_ignore_ascii_case("X-YouTube-Client-Version") {
                *value = "1.02".into();
            }
        }
    }
    if let Ok(encoded) = serde_json::to_vec(&body) {
        request.body = Some(encoded);
    }
}

pub(crate) struct PhoneYoutube {
    downloader: Ytdown,
    extractor: YoutubeExtractor,
    context: ExtractorContext,
}

impl PhoneYoutube {
    async fn resolve(&self, url: &str) -> ytdown::Result<MediaInfo> {
        let input = match url.strip_prefix("ytsearch:") {
            Some(query) => format!("ytsearch:{}", query.replace('%', "%25")),
            None => url.to_string(),
        };
        let url = reqwest::Url::parse(&input).map_err(|_| ytdown::Error::UnsupportedUrl(url.into()))?;
        self.extractor.extract(&self.context, &url).await
    }
}

pub(crate) fn extractor() -> Result<PhoneYoutube, String> {
    let client = reqwest12::Client::builder().connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(90))
        .build().map_err(|error| format!("Could not start the YouTube downloader: {error}"))?;
    let downloader = Ytdown::builder()
        .client(client.clone())
        .clear_extractors()
        .extractor(Box::new(YoutubeExtractor::new()))
        .build()
        .map_err(|error| format!("Could not start the YouTube downloader: {error}"))?;
    Ok(PhoneYoutube {
        downloader,
        extractor: YoutubeExtractor::new(),
        context: ExtractorContext::new(Arc::new(YoutubeTransport(ReqwestClient::new(client)))),
    })
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

fn resolve(yt: &PhoneYoutube, url: &str, report: &mut Reporter) -> Result<Link, String> {
    resolve_with_limit(yt, url, report, LIMIT)
}

fn resolve_with_limit(yt: &PhoneYoutube, url: &str, report: &mut Reporter, limit: usize) -> Result<Link, String> {
    if crate::youtube_mix::is_mix(url) {
        return crate::youtube_mix::resolve(url, report, limit);
    }
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
            _ => return Err("Paste a YouTube video, playlist or mix link.".to_string()),
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

async fn search_matches(yt: &PhoneYoutube, meta: &TrackMeta) -> Result<Vec<VideoInfo>, String> {
    let artist = meta.artists.first().map(|name| name.split([',', ';']).next().unwrap_or(name)).unwrap_or("");
    let query = format!("ytsearch:{artist} {} audio", meta.title);
    let media = yt.resolve(&query).await
        .map_err(|error| format!("Could not search YouTube: {error}"))?;
    let MediaInfo::Collection(collection) = media else {
        return Err("YouTube did not return search results.".to_string());
    };
    let mut entries = collection.entries.take(SEARCH_HITS);
    let mut matches = Vec::new();
    while let Some(entry) = entries.next().await {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) if !matches.is_empty() => break,
            Err(error) => return Err(format!("Could not read YouTube search results: {error}")),
        };
        if entry.id.len() != 11
            || !entry.id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            || !entry.title.as_deref().is_some_and(|title| download::phone_search_title(meta, title))
        {
            continue;
        }
        let url = format!("https://www.youtube.com/watch?v={}", entry.id);
        let Ok(MediaInfo::Single(video)) = yt.resolve(&url).await else {
            continue;
        };
        let score = download::phone_match_score(
            meta,
            &video.title,
            video.uploader.as_deref().unwrap_or_default(),
            video.duration.map(|duration| duration.as_millis() as u64),
            video.is_live,
        );
        if let Some(score) = score {
            let close = video.duration.map(|duration| duration.as_millis() as u64)
                .zip(meta.duration_ms.filter(|length| *length > 0))
                .is_some_and(|(found, wanted)| found.abs_diff(wanted) <= 2_000);
            matches.push((score, video));
            if matches.len() >= SEARCH_MATCHES || (score >= 17 && close) {
                break;
            }
        }
    }
    matches.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
    if matches.is_empty() {
        return Err("No matching YouTube audio was found.".to_string());
    }
    Ok(matches.into_iter().map(|(_, video)| video).collect())
}

pub(crate) fn fetch_matching(yt: &PhoneYoutube, job: &Job<'_>) -> Result<PathBuf, String> {
    let matches = tauri::async_runtime::block_on(search_matches(yt, job.meta))?;
    let cover = job.cover.as_deref().and_then(|path| fs::read(path).ok())
        .or_else(|| crate::cover_fetch::look_up(
            &job.meta.artists.join(", "), &job.meta.title, &job.meta.album,
        ));
    let mut failure = None;
    for video in matches {
        let artwork = cover.clone().or_else(|| {
            let url = video.thumbnails.iter().max_by_key(|image| image.width.unwrap_or(0))
                .map(|image| image.url.as_str());
            download::fetch_cover(url)
        });
        match fetch_video(yt, job, &video, artwork) {
            Ok(path) => return Ok(path),
            Err(error) => {
                let _ = fs::remove_file(job.dir.join("audio.m4a"));
                failure = Some(error);
            }
        }
    }
    Err(failure.unwrap_or_else(|| "No matching YouTube audio was found.".to_string()))
}

fn fetch_video(yt: &PhoneYoutube, job: &Job<'_>, video: &VideoInfo, cover: Option<Vec<u8>>) -> Result<PathBuf, String> {
    let path = job.dir.join("audio.m4a");
    fs::create_dir_all(&job.dir).map_err(|error| format!("Could not create the download folder: {error}"))?;
    let format = video.formats().audio_only().container(&Container::M4a).best_audio()
        .map_err(|_| "YouTube did not provide a compatible audio stream.".to_string())?;
    tauri::async_runtime::block_on(async {
        yt.downloader.download(format, &path).resume(false).chunk_size(200 * 1024).await
            .map_err(download_error)
    })?;
    download::landed(&path, job.meta)?;
    download::tag(&path, job.meta, cover)?;
    Ok(path)
}

fn download_error(error: ytdown::Error) -> String {
    let message = error.to_string();
    let message = message.split(" for url").next().unwrap_or(&message);
    format!("Could not download the audio: {message}")
}

fn fetch(yt: &PhoneYoutube, job: &Job<'_>) -> Result<PathBuf, String> {
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
        yt.downloader.download(format, &path).resume(false).chunk_size(200 * 1024).await
            .map_err(download_error)?;
        Ok::<(), String>(())
    })?;
    download::landed(&path, job.meta)?;
    download::tag(&path, job.meta, download::fetch_cover(job.meta.cover_url.as_deref()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_request_uses_visionos_without_changing_the_visitor() {
        let mut request = HttpRequest::post("innertube", "https://www.youtube.com/youtubei/v1/player?key=public")
            .header("User-Agent", "old")
            .header("X-YouTube-Client-Name", "28")
            .header("X-YouTube-Client-Version", "old")
            .body(serde_json::to_vec(&serde_json::json!({
                "videoId": "abcdefghijk",
                "context": { "client": { "clientName": "ANDROID_VR", "visitorData": "visitor", "androidSdkVersion": 32 } }
            })).unwrap());
        adapt_request(&mut request);
        let body: serde_json::Value = serde_json::from_slice(request.body.as_ref().unwrap()).unwrap();
        assert_eq!(body["videoId"], "abcdefghijk");
        assert_eq!(body["context"]["client"]["clientName"], "VISIONOS");
        assert_eq!(body["context"]["client"]["visitorData"], "visitor");
        assert!(body["context"]["client"].get("androidSdkVersion").is_none());
        assert!(request.headers.iter().any(|(name, value)| name == "X-YouTube-Client-Name" && value == "101"));
        assert!(request.headers.iter().any(|(name, value)| name == "User-Agent" && value == VISION_AGENT));
    }

    #[test]
    fn search_request_decodes_unicode_and_keeps_literal_percent_signs() {
        let mut request = HttpRequest::post("innertube", "https://www.youtube.com/youtubei/v1/search?key=public")
            .body(serde_json::to_vec(&serde_json::json!({ "query": "Beyonc%C3%A9 100%25" })).unwrap());
        adapt_request(&mut request);
        let body: serde_json::Value = serde_json::from_slice(request.body.as_ref().unwrap()).unwrap();
        assert_eq!(body["query"], "Beyoncé 100%");
    }

    #[test]
    fn player_fallback_requests_are_unchanged() {
        let body = serde_json::to_vec(&serde_json::json!({
            "context": { "client": { "clientName": "IOS" } }
        })).unwrap();
        let mut request = HttpRequest::post("innertube", "https://www.youtube.com/youtubei/v1/player?key=public")
            .header("X-YouTube-Client-Name", "5")
            .body(body.clone());
        adapt_request(&mut request);
        assert_eq!(request.body.unwrap(), body);
        assert_eq!(request.headers[0].1, "5");
    }

    #[test]
    fn download_errors_do_not_expose_stream_urls() {
        let error = ytdown::Error::Network {
            stage: "download",
            message: "HTTP status 403 for url (https://example.test/?secret=value)".into(),
        };
        let message = download_error(error);
        assert!(message.contains("403"));
        assert!(!message.contains("https://"));
    }

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
    fn searches_and_downloads_a_real_matching_song() {
        #[cfg(target_os = "android")]
        crate::install_tls_provider();
        let yt = extractor().unwrap();
        let meta = TrackMeta {
            title: "Never Gonna Give You Up".into(),
            artists: vec!["Rick Astley".into()],
            duration_ms: Some(213_000),
            ..TrackMeta::default()
        };
        let dir = std::env::temp_dir().join(format!("wave-youtube-match-{}", crate::identity::new_id()));
        let job = Job { key: 0, meta: &meta, dir: dir.clone(), cover: None };
        let path = fetch_matching(&yt, &job).unwrap();
        assert!(fs::metadata(&path).unwrap().len() > 10_000);
        let tags = lofty::read_from_path(&path).unwrap();
        use lofty::prelude::{Accessor, TaggedFileExt};
        assert_eq!(tags.primary_tag().and_then(|tag| tag.title()).as_deref(), Some(meta.title.as_str()));
        assert!(tags.primary_tag().is_some_and(|tag| !tag.pictures().is_empty()));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[ignore = "requires YouTube network access"]
    fn reads_a_real_youtube_playlist_in_order() {
        #[cfg(target_os = "android")]
        crate::install_tls_provider();
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
    fn downloads_a_real_youtube_mix_entry() {
        #[cfg(target_os = "android")]
        crate::install_tls_provider();
        let yt = extractor().unwrap();
        let mut report = Reporter::quiet();
        let link = resolve_with_limit(
            &yt,
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ",
            &mut report,
            1,
        ).unwrap();
        assert_eq!(link.kind, Kind::Collection);
        assert_eq!(link.tracks.len(), 1);
        let dir = std::env::temp_dir().join(format!("wave-youtube-mix-{}", crate::identity::new_id()));
        let job = Job { key: 0, meta: &link.tracks[0], dir: dir.clone(), cover: None };
        let path = fetch(&yt, &job).unwrap();
        assert!(fs::metadata(&path).unwrap().len() > 10_000);
        let tags = lofty::read_from_path(&path).unwrap();
        use lofty::prelude::{Accessor, TaggedFileExt};
        assert_eq!(tags.primary_tag().and_then(|tag| tag.title()).as_deref(), Some(link.tracks[0].title.as_str()));
        assert!(tags.primary_tag().is_some_and(|tag| !tag.pictures().is_empty()));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[ignore = "requires YouTube network access"]
    fn downloads_a_real_youtube_video_as_tagged_m4a() {
        #[cfg(target_os = "android")]
        crate::install_tls_provider();
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
