use std::collections::HashSet;
use std::time::Duration;

use serde_json::{Value, json};

use crate::download;
use crate::import_source::{Kind, Link};
use crate::progress::Reporter;
use crate::source::{TrackMeta, client};
use crate::youtube::folder_name;

pub(crate) const LIMIT: usize = 50;

pub(crate) fn is_mix(url: &str) -> bool {
    reqwest::Url::parse(url).ok().is_some_and(|parsed| {
        parsed
            .query_pairs()
            .any(|(key, value)| key == "list" && value.starts_with("RD"))
    })
}

pub(crate) fn resolve(url: &str, report: &mut Reporter, limit: usize) -> Result<Link, String> {
    report.phase("resolving", "Reading the YouTube mix.");
    read_mix(url, limit.min(LIMIT), |body| {
        client()
            .post("https://www.youtube.com/youtubei/v1/next?prettyPrint=false")
            .header("Origin", "https://www.youtube.com")
            .header("User-Agent", "Mozilla/5.0")
            .timeout(Duration::from_secs(20))
            .json(body)
            .send()
            .and_then(|response| response.error_for_status())
            .and_then(|response| response.json())
            .map_err(|error| format!("Could not read the YouTube mix: {}", error.without_url()))
    })
}

fn read_mix(
    url: &str,
    limit: usize,
    mut fetch: impl FnMut(&Value) -> Result<Value, String>,
) -> Result<Link, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "Invalid YouTube mix link.".to_string())?;
    let list = parsed
        .query_pairs()
        .find(|(key, _)| key == "list")
        .map(|(_, value)| value.into_owned())
        .ok_or_else(|| "The YouTube mix has no list ID.".to_string())?;
    let video = parsed
        .query_pairs()
        .find(|(key, _)| key == "v")
        .map(|(_, value)| value.into_owned());
    let mut body = json!({
        "context": { "client": {
            "clientName": "WEB",
            "clientVersion": "2.20240620.05.00",
            "hl": "en",
            "gl": "US"
        }},
        "playlistId": list
    });
    if let Some(video) = video {
        body["videoId"] = video.into();
    }

    let mut tracks = Vec::new();
    let mut seen = HashSet::new();
    let mut previous: Option<String> = None;
    let mut name = None;

    while tracks.len() < limit {
        let response = fetch(&body)?;
        let panel = response
            .pointer("/contents/twoColumnWatchNextResults/playlist/playlist")
            .ok_or_else(|| {
                "YouTube could not open this mix. It may require signing in.".to_string()
            })?;
        if name.is_none() {
            name = panel["title"]
                .as_str()
                .filter(|title| !title.trim().is_empty())
                .map(str::to_string);
        }
        let entries = panel["contents"]
            .as_array()
            .ok_or_else(|| "The YouTube mix has no videos to download.".to_string())?;
        let videos: Vec<&Value> = entries
            .iter()
            .filter_map(|entry| entry.get("playlistPanelVideoRenderer"))
            .collect();
        let start = previous
            .as_deref()
            .and_then(|id| {
                videos
                    .iter()
                    .rposition(|video| video["videoId"].as_str() == Some(id))
            })
            .map_or(0, |index| index + 1);
        let before = tracks.len();
        for video in &videos[start..] {
            let Some(id) = video["videoId"].as_str().filter(|id| valid_video_id(id)) else {
                continue;
            };
            if !seen.insert(id.to_string()) {
                continue;
            }
            let title = text(&video["title"]).unwrap_or_else(|| id.to_string());
            let channel = text(&video["shortBylineText"]).unwrap_or_default();
            let (title, artists) = download::credit(&title, "", &channel);
            tracks.push(TrackMeta {
                title,
                artists,
                duration_ms: text(&video["lengthText"]).and_then(|length| duration_ms(&length)),
                cover_url: video["thumbnail"]["thumbnails"]
                    .as_array()
                    .and_then(|images| {
                        images
                            .iter()
                            .max_by_key(|image| image["width"].as_u64().unwrap_or(0))
                    })
                    .and_then(|image| image["url"].as_str())
                    .map(str::to_string),
                source_url: Some(format!("https://www.youtube.com/watch?v={id}")),
                ..TrackMeta::default()
            });
            if tracks.len() == limit {
                break;
            }
        }
        let Some(last) = videos.last().filter(|_| tracks.len() > before) else {
            break;
        };
        let Some(id) = last["videoId"].as_str().filter(|id| valid_video_id(id)) else {
            break;
        };
        previous = Some(id.to_string());
        let endpoint = &last["navigationEndpoint"]["watchEndpoint"];
        body["videoId"] = id.into();
        if let Some(index) = endpoint.get("index") {
            body["index"] = index.clone();
        }
        body["params"] = endpoint["params"].as_str().unwrap_or("OAE%3D").into();
    }

    if tracks.is_empty() {
        return Err("The YouTube mix has no videos to download.".to_string());
    }
    Ok(Link {
        kind: Kind::Collection,
        id: folder_name(url),
        name: name.unwrap_or_else(|| "YouTube mix".to_string()),
        tracks,
    })
}

fn valid_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn text(value: &Value) -> Option<String> {
    let text = value["simpleText"]
        .as_str()
        .map(str::to_string)
        .or_else(|| {
            value["runs"].as_array().map(|runs| {
                runs.iter()
                    .filter_map(|run| run["text"].as_str())
                    .collect::<String>()
            })
        })?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn duration_ms(value: &str) -> Option<u64> {
    let mut count = 0;
    let seconds = value.split(':').try_fold(0u64, |total, part| {
        count += 1;
        total
            .checked_mul(60)?
            .checked_add(part.parse::<u64>().ok()?)
    })?;
    (count >= 2).then(|| seconds.saturating_mul(1000))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video(id: &str, title: &str, index: u64) -> Value {
        json!({ "playlistPanelVideoRenderer": {
            "videoId": id,
            "title": { "simpleText": title },
            "shortBylineText": { "runs": [{ "text": "Artist - Topic" }] },
            "lengthText": { "simpleText": "3:34" },
            "thumbnail": { "thumbnails": [
                { "url": "https://i.ytimg.com/small.jpg", "width": 120 },
                { "url": "https://i.ytimg.com/large.jpg", "width": 480 }
            ] },
            "navigationEndpoint": { "watchEndpoint": { "videoId": id, "index": index, "params": "OAE%3D" } }
        }})
    }

    fn page(videos: Vec<Value>) -> Value {
        json!({ "contents": { "twoColumnWatchNextResults": { "playlist": { "playlist": {
            "title": "Test mix", "contents": videos
        }}}}})
    }

    #[test]
    fn reads_seeded_mix_pages_in_order_without_overlap() {
        let url = "https://www.youtube.com/watch?v=aaaaaaaaaaa&list=RDaaaaaaaaaaa";
        let mut calls = 0;
        let link = read_mix(url, 3, |body| {
            calls += 1;
            assert_eq!(body["playlistId"], "RDaaaaaaaaaaa");
            match calls {
                1 => {
                    assert_eq!(body["videoId"], "aaaaaaaaaaa");
                    Ok(page(vec![
                        video("aaaaaaaaaaa", "Artist - First", 0),
                        video("bbbbbbbbbbb", "Second", 1),
                    ]))
                }
                2 => {
                    assert_eq!(body["videoId"], "bbbbbbbbbbb");
                    assert_eq!(body["index"], 1);
                    assert_eq!(body["params"], "OAE%3D");
                    Ok(page(vec![
                        video("aaaaaaaaaaa", "First", 0),
                        video("bbbbbbbbbbb", "Second", 1),
                        video("ccccccccccc", "Third", 2),
                    ]))
                }
                _ => panic!("requested too many pages"),
            }
        })
        .unwrap();
        assert_eq!(link.kind, Kind::Collection);
        assert_eq!(link.name, "Test mix");
        assert_eq!(link.id, "RDaaaaaaaaaaa");
        assert_eq!(calls, 2);
        assert_eq!(
            link.tracks
                .iter()
                .map(|track| track.source_url.as_deref().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "https://www.youtube.com/watch?v=aaaaaaaaaaa",
                "https://www.youtube.com/watch?v=bbbbbbbbbbb",
                "https://www.youtube.com/watch?v=ccccccccccc",
            ]
        );
        assert_eq!(link.tracks[0].title, "First");
        assert_eq!(link.tracks[0].artists, vec!["Artist"]);
        assert_eq!(link.tracks[0].duration_ms, Some(214_000));
        assert_eq!(
            link.tracks[0].cover_url.as_deref(),
            Some("https://i.ytimg.com/large.jpg")
        );
        assert_eq!(link.tracks[1].artists, vec!["Artist"]);
    }

    #[test]
    fn reads_unseeded_mixes_and_stops_when_the_queue_repeats() {
        let mut calls = 0;
        let link = read_mix("https://www.youtube.com/playlist?list=RDMM", 50, |body| {
            calls += 1;
            if calls == 1 {
                assert!(body.get("videoId").is_none());
            }
            Ok(page(vec![video("aaaaaaaaaaa", "First", 0)]))
        })
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(link.tracks.len(), 1);
        assert_eq!(link.kind, Kind::Collection);
    }

    #[test]
    fn respects_the_requested_limit_and_reports_empty_or_failed_queues() {
        let link = read_mix("https://www.youtube.com/playlist?list=RDMM", 1, |_| {
            Ok(page(vec![
                video("aaaaaaaaaaa", "First", 0),
                video("bbbbbbbbbbb", "Second", 1),
            ]))
        })
        .unwrap();
        assert_eq!(link.tracks.len(), 1);
        let error = read_mix("https://www.youtube.com/playlist?list=RDMM", 2, |_| {
            Ok(page(vec![]))
        })
        .unwrap_err();
        assert!(error.contains("no videos"));
        let error = read_mix("https://www.youtube.com/playlist?list=RDMM", 2, |_| {
            Ok(json!({}))
        })
        .unwrap_err();
        assert!(error.contains("signing in"));
        let error = read_mix("https://www.youtube.com/playlist?list=RDMM", 2, |_| {
            Err("offline".into())
        })
        .unwrap_err();
        assert_eq!(error, "offline");
        assert_eq!(duration_ms("1:02:03"), Some(3_723_000));
        assert_eq!(duration_ms("LIVE"), None);
    }

    #[test]
    #[ignore = "requires YouTube network access"]
    fn reads_a_real_youtube_mix() {
        #[cfg(target_os = "android")]
        crate::install_tls_provider();
        let mut report = Reporter::quiet();
        let link = resolve(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ",
            &mut report,
            30,
        )
        .unwrap();
        assert_eq!(link.kind, Kind::Collection);
        assert_eq!(link.tracks.len(), 30);
        assert_eq!(
            link.tracks[0].source_url.as_deref(),
            Some("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        );
        let ids: HashSet<_> = link
            .tracks
            .iter()
            .map(|track| track.source_url.as_deref())
            .collect();
        assert_eq!(ids.len(), 30);
    }
}
