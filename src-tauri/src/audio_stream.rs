use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
#[cfg(any(target_os = "android", target_os = "linux"))]
use std::sync::{Arc, Mutex};
use std::thread;
#[cfg(any(target_os = "android", target_os = "linux"))]
use std::thread::JoinHandle;

#[cfg(any(target_os = "android", target_os = "linux"))]
use tauri::{AppHandle, Manager};
#[cfg(any(target_os = "android", target_os = "linux"))]
use tiny_http::Request;
use tiny_http::{Header, Method, Response, ResponseBox, Server, StatusCode};

#[cfg(any(target_os = "android", target_os = "linux"))]
use crate::catalog::Catalog;
#[cfg(any(target_os = "android", target_os = "linux", test))]
use crate::library;

#[cfg(any(target_os = "android", target_os = "linux"))]
pub struct AudioStream {
    base: String,
    server: Arc<Server>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

fn authorized_request<'a>(
    url: &'a str,
    host: Option<&str>,
    method: &Method,
    token: &str,
    port: u16,
) -> Option<(&'a str, Option<&'a str>)> {
    let (path, file) = match url.split_once('?') {
        Some((path, query)) => {
            let file = query.strip_prefix("file=")?;
            if file.is_empty() || file.contains('&') {
                return None;
            }
            (path, Some(file))
        }
        None => (url, None),
    };
    Some((authorized_id(path, host, method, token, port)?, file))
}

#[cfg(any(target_os = "linux", test))]
fn resolve_staged_audio(base: &Path, id: &str) -> Option<PathBuf> {
    if !crate::identity::is_id(id) {
        return None;
    }
    let config = base.join(library::CONFIG_DIR).canonicalize().ok()?;
    for extension in library::AUDIO_EXTENSIONS {
        let path = config.join(format!(".song-editor-{id}.{extension}"));
        if let Ok(path) = path.canonicalize() {
            if path.parent() == Some(config.as_path()) && path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

#[cfg(any(target_os = "android", target_os = "linux"))]
impl AudioStream {
    pub fn start(app: &AppHandle) -> Result<Self, String> {
        let root = library::library_root(app)?
            .join(library::SONGS_DIR)
            .canonicalize()
            .map_err(|e| format!("could not resolve the songs directory: {e}"))?;
        let server = Arc::new(Server::http("127.0.0.1:0").map_err(|e| e.to_string())?);
        let port = server
            .server_addr()
            .to_ip()
            .ok_or_else(|| "audio stream has no loopback address".to_string())?
            .port();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let base = format!("http://127.0.0.1:{port}/{token}");
        let handle = app.clone();
        let listener = server.clone();
        let thread = thread::spawn(move || {
            for request in listener.incoming_requests() {
                let app = handle.clone();
                let root = root.clone();
                let token = token.clone();
                thread::spawn(move || serve(request, &app, &root, &token, port));
            }
        });

        Ok(Self {
            base,
            server,
            thread: Mutex::new(Some(thread)),
        })
    }

    pub fn shutdown(&self) {
        self.server.unblock();
        if let Some(thread) = self.thread.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = thread.join();
        }
    }
}

#[cfg(any(target_os = "android", target_os = "linux"))]
#[tauri::command]
pub fn audio_stream_base(app: AppHandle) -> Result<String, String> {
    app.try_state::<AudioStream>()
        .map(|stream| stream.base.clone())
        .ok_or_else(|| "the local audio stream could not start".to_string())
}

#[cfg(any(target_os = "android", target_os = "linux"))]
fn serve(request: Request, app: &AppHandle, root: &Path, token: &str, port: u16) {
    let host = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Host"))
        .map(|header| header.value.as_str());
    let Some((id, file)) = authorized_request(request.url(), host, request.method(), token, port) else {
        let _ = request.respond(empty(404));
        return;
    };

    if request.method() == &Method::Options {
        let _ = request.respond(preflight());
        return;
    }

    let catalog = app.state::<Catalog>();
    #[cfg(target_os = "linux")]
    let staged = id.strip_prefix("editor-").filter(|_| file.is_none()).and_then(|id| {
        library::library_root(app).ok().and_then(|base| resolve_staged_audio(&base, id))
    });
    #[cfg(not(target_os = "linux"))]
    let staged: Option<PathBuf> = None;
    let path = staged.or_else(|| {
        catalog.track(id).ok().flatten().filter(|row| !row.missing).and_then(|row| {
            library::library_root(app)
                .ok()
                .and_then(|base| resolve_track_audio(&base, root, &row.rel_path, file))
        })
    });
    let Some(path) = path else {
        let _ = request.respond(empty(404));
        return;
    };

    let range = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Range"))
        .map(|header| header.value.as_str());
    let response = file_response(&path, range, request.method() == &Method::Head)
        .unwrap_or_else(|_| empty(500));
    let _ = request.respond(response);
}

fn resolve_track_audio(base: &Path, root: &Path, relative: &str, file: Option<&str>) -> Option<PathBuf> {
    let Some(file) = file else {
        return resolve_audio(base, root, relative);
    };
    let name = percent_encoding::percent_decode_str(file).decode_utf8().ok()?;
    if name.is_empty() || name.contains(['/', '\\']) || Path::new(name.as_ref()).file_name()?.to_str()? != name {
        return None;
    }
    let dir = base.join(relative).parent()?.canonicalize().ok()?;
    if !dir.starts_with(root) {
        return None;
    }
    let path = dir.join(name.as_ref()).canonicalize().ok()?;
    (path.parent() == Some(dir.as_path()) && path.is_file() && library::has_extension(&path, library::AUDIO_EXTENSIONS))
        .then_some(path)
}

fn resolve_audio(base: &Path, root: &Path, relative: &str) -> Option<PathBuf> {
    base.join(relative)
        .canonicalize()
        .ok()
        .filter(|path| path.starts_with(root))
}

fn authorized_id<'a>(
    url: &'a str,
    host: Option<&str>,
    method: &Method,
    token: &str,
    port: u16,
) -> Option<&'a str> {
    let id = url.strip_prefix(&format!("/{token}/"))?;
    if host == Some(format!("127.0.0.1:{port}").as_str())
        && matches!(method, Method::Get | Method::Head | Method::Options)
        && !id.is_empty()
        && id
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == b'-' || ch == b'_')
    {
        Some(id)
    } else {
        None
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).expect("valid response header")
}

fn empty(status: u16) -> ResponseBox {
    Response::new(
        StatusCode(status),
        vec![],
        Box::new(io::empty()) as Box<dyn Read + Send>,
        Some(0),
        None,
    )
}

fn preflight() -> ResponseBox {
    empty(204)
        .with_header(header("Access-Control-Allow-Origin", "*"))
        .with_header(header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"))
        .with_header(header("Access-Control-Allow-Headers", "Range"))
}

fn file_response(path: &Path, range: Option<&str>, head: bool) -> io::Result<ResponseBox> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let (start, length, partial) = match byte_range(range, size) {
        Ok(range) => range,
        Err(()) => {
            return Ok(empty(416)
                .with_header(header("Content-Range", &format!("bytes */{size}")))
                .with_header(header("Access-Control-Allow-Origin", "*"))
                .with_header(header("Access-Control-Expose-Headers", "Content-Range")));
        }
    };
    file.seek(SeekFrom::Start(start))?;
    let count = usize::try_from(length)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "audio file is too large"))?;
    let mut headers = vec![
        header("Content-Type", content_type(path)),
        header("Accept-Ranges", "bytes"),
        header("Access-Control-Allow-Origin", "*"),
        header(
            "Access-Control-Expose-Headers",
            "Content-Range, Content-Length, Accept-Ranges",
        ),
        header("Cache-Control", "no-store"),
    ];
    if partial {
        headers.push(header(
            "Content-Range",
            &format!("bytes {start}-{}/{size}", start + length - 1),
        ));
    }
    let body: Box<dyn Read + Send> = if head {
        Box::new(io::empty())
    } else {
        Box::new(file.take(length))
    };
    Ok(Response::new(
        StatusCode(if partial { 206 } else { 200 }),
        headers,
        body,
        Some(count),
        None,
    )
    .with_chunked_threshold(usize::MAX))
}

fn byte_range(range: Option<&str>, size: u64) -> Result<(u64, u64, bool), ()> {
    let Some(range) = range else {
        return Ok((0, size, false));
    };
    let (first, last) = range
        .strip_prefix("bytes=")
        .ok_or(())?
        .split_once('-')
        .ok_or(())?;
    if size == 0 || last.contains(',') {
        return Err(());
    }
    if first.is_empty() {
        let suffix = last.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let length = suffix.min(size);
        return Ok((size - length, length, true));
    }
    let start = first.parse::<u64>().map_err(|_| ())?;
    if start >= size {
        return Err(());
    }
    let end = if last.is_empty() {
        size - 1
    } else {
        last.parse::<u64>().map_err(|_| ())?.min(size - 1)
    };
    if end < start {
        return Err(());
    }
    Ok((start, end - start + 1, true))
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" => "audio/mpeg",
        "m4a" | "m4b" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "aif" | "aiff" => "audio/aiff",
        "wma" => "audio/x-ms-wma",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpStream;

    #[test]
    fn requires_the_token_loopback_host_and_a_track_id() {
        let check = |url, host, method| authorized_id(url, host, method, "secret", 1234);
        assert_eq!(
            check("/secret/abc-123", Some("127.0.0.1:1234"), &Method::Get),
            Some("abc-123")
        );
        assert_eq!(
            check("/secret/abc-123", Some("127.0.0.1:1234"), &Method::Head),
            Some("abc-123")
        );
        assert_eq!(
            check("/secret/abc-123", Some("127.0.0.1:1234"), &Method::Options),
            Some("abc-123")
        );
        assert_eq!(
            check("/wrong/abc-123", Some("127.0.0.1:1234"), &Method::Get),
            None
        );
        assert_eq!(
            check("/wrong/abc-123", Some("127.0.0.1:1234"), &Method::Options),
            None
        );
        assert_eq!(
            check("/secret/../audio", Some("127.0.0.1:1234"), &Method::Get),
            None
        );
        assert_eq!(
            check("/secret/abc?x=1", Some("127.0.0.1:1234"), &Method::Get),
            None
        );
        assert_eq!(
            check("/secret/abc", Some("example.com:1234"), &Method::Get),
            None
        );
        assert_eq!(
            check("/secret/abc", Some("example.com:1234"), &Method::Options),
            None
        );
        assert_eq!(check("/secret/abc", None, &Method::Get), None);
        assert_eq!(
            check("/secret/abc", Some("127.0.0.1:1234"), &Method::Post),
            None
        );
    }

    #[test]
    fn refuses_audio_outside_the_songs_directory() {
        let base = std::env::temp_dir().join(format!("wave-stream-root-{}", uuid::Uuid::new_v4()));
        let songs = base.join("songs");
        std::fs::create_dir_all(&songs).unwrap();
        std::fs::write(songs.join("audio.mp3"), b"audio").unwrap();
        std::fs::write(base.join("private.txt"), b"private").unwrap();
        let root = songs.canonicalize().unwrap();
        assert!(resolve_audio(&base, &root, "songs/audio.mp3").is_some());
        assert!(resolve_audio(&base, &root, "private.txt").is_none());
        assert!(resolve_audio(&base, &root, "songs/../private.txt").is_none());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn requested_file_versions_stay_in_the_same_song_folder() {
        let base = std::env::temp_dir().join(format!("wave-stream-version-{}", uuid::Uuid::new_v4()));
        let songs = base.join("songs");
        let dir = songs.join("track");
        let other = songs.join("other");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(dir.join("old song.mp3"), b"original").unwrap();
        std::fs::write(dir.join("audio-new.mp3"), b"modified").unwrap();
        std::fs::write(other.join("private.mp3"), b"private").unwrap();
        std::fs::write(dir.join("private.txt"), b"private").unwrap();
        let root = songs.canonicalize().unwrap();
        let current = "songs/track/audio-new.mp3";
        let old = resolve_track_audio(&base, &root, current, Some("old%20song.mp3")).unwrap();
        assert_eq!(std::fs::read(old).unwrap(), b"original");
        assert_eq!(std::fs::read(resolve_track_audio(&base, &root, current, None).unwrap()).unwrap(), b"modified");
        for name in ["../other/private.mp3", "%2e%2e%2fother%2fprivate.mp3", "private.txt", "%5cprivate.mp3"] {
            assert!(resolve_track_audio(&base, &root, current, Some(name)).is_none(), "{name}");
        }
        assert_eq!(
            authorized_request("/secret/track?file=old%20song.mp3", Some("127.0.0.1:1234"), &Method::Get, "secret", 1234),
            Some(("track", Some("old%20song.mp3")))
        );
        assert!(authorized_request("/secret/track?file=a&file=b", Some("127.0.0.1:1234"), &Method::Get, "secret", 1234).is_none());
        assert!(authorized_request("/secret/track?file=a", Some("example.com:1234"), &Method::Get, "secret", 1234).is_none());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn staged_audio_requires_a_valid_id_and_editor_filename() {
        let base = std::env::temp_dir().join(format!("wave-stream-editor-{}", uuid::Uuid::new_v4()));
        let config = base.join(library::CONFIG_DIR);
        std::fs::create_dir_all(&config).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let staged = config.join(format!(".song-editor-{id}.wav"));
        std::fs::write(&staged, b"audio").unwrap();
        assert_eq!(resolve_staged_audio(&base, &id), staged.canonicalize().ok());
        assert!(resolve_staged_audio(&base, "../private").is_none());
        assert!(resolve_staged_audio(&base, &uuid::Uuid::new_v4().to_string()).is_none());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn ranges_cover_open_bounded_and_suffix_requests() {
        assert_eq!(byte_range(None, 100), Ok((0, 100, false)));
        assert_eq!(byte_range(Some("bytes=10-"), 100), Ok((10, 90, true)));
        assert_eq!(byte_range(Some("bytes=10-19"), 100), Ok((10, 10, true)));
        assert_eq!(byte_range(Some("bytes=95-200"), 100), Ok((95, 5, true)));
        assert_eq!(byte_range(Some("bytes=-10"), 100), Ok((90, 10, true)));
        assert_eq!(byte_range(Some("bytes=-200"), 100), Ok((0, 100, true)));
        for value in [
            "bytes=100-",
            "bytes=20-10",
            "bytes=-0",
            "bytes=1-2,3-4",
            "other=1-2",
        ] {
            assert_eq!(byte_range(Some(value), 100), Err(()));
        }
        assert_eq!(byte_range(Some("bytes=0-"), 0), Err(()));
    }

    #[test]
    fn preflight_permits_only_audio_methods_and_range_headers() {
        let response = preflight();
        assert_eq!(response.status_code(), StatusCode(204));
        for (name, value) in [
            ("Access-Control-Allow-Origin", "*"),
            ("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"),
            ("Access-Control-Allow-Headers", "Range"),
        ] {
            assert!(
                response
                    .headers()
                    .iter()
                    .any(|header| { header.field.equiv(name) && header.value.as_str() == value }),
                "{name}"
            );
        }
    }

    #[test]
    fn serves_the_entire_requested_range_without_a_one_megabyte_limit() {
        let path = std::env::temp_dir().join(format!("wave-stream-{}.mp3", uuid::Uuid::new_v4()));
        let contents = vec![42u8; 1_500_000];
        std::fs::write(&path, &contents).unwrap();
        let response = file_response(&path, Some("bytes=100-"), false).unwrap();
        assert_eq!(response.status_code(), StatusCode(206));
        assert!(response
            .headers()
            .iter()
            .any(|h| h.field.equiv("Content-Range")
                && h.value.as_str() == "bytes 100-1499999/1500000"));
        let mut received = Vec::new();
        response.into_reader().read_to_end(&mut received).unwrap();
        assert_eq!(received, contents[100..]);
        assert_eq!(
            file_response(&path, Some("bytes=1500000-"), false)
                .unwrap()
                .status_code(),
            StatusCode(416)
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn http_responses_have_correct_lengths_ranges_and_head_behavior() {
        let path = std::env::temp_dir().join(format!("wave-http-{}.mp3", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"0123456789").unwrap();

        for (method, range, status, length, content_range, body) in [
            ("GET", "", "200", "10", None, "0123456789"),
            (
                "GET",
                "Range: bytes=2-5\r\n",
                "206",
                "4",
                Some("bytes 2-5/10"),
                "2345",
            ),
            ("HEAD", "", "200", "10", None, ""),
            (
                "GET",
                "Range: bytes=10-\r\n",
                "416",
                "0",
                Some("bytes */10"),
                "",
            ),
        ] {
            let server = Server::http("127.0.0.1:0").unwrap();
            let address = server.server_addr().to_ip().unwrap();
            let file = path.clone();
            let worker = thread::spawn(move || {
                let request = server.recv().unwrap();
                let range = request
                    .headers()
                    .iter()
                    .find(|header| header.field.equiv("Range"))
                    .map(|header| header.value.as_str());
                let response =
                    file_response(&file, range, request.method() == &Method::Head).unwrap();
                request.respond(response).unwrap();
            });
            let mut stream = TcpStream::connect(address).unwrap();
            write!(
                stream,
                "{method} / HTTP/1.1\r\nHost: {address}\r\n{range}Connection: close\r\n\r\n"
            )
            .unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).unwrap();
            worker.join().unwrap();
            let response = String::from_utf8(bytes).unwrap();
            let (headers, received) = response.split_once("\r\n\r\n").unwrap();
            assert!(
                headers.starts_with(&format!("HTTP/1.1 {status} ")),
                "{headers}"
            );
            assert!(
                headers
                    .lines()
                    .any(|line| line.eq_ignore_ascii_case(&format!("Content-Length: {length}"))),
                "{headers}"
            );
            if let Some(value) = content_range {
                assert!(
                    headers
                        .lines()
                        .any(|line| line.eq_ignore_ascii_case(&format!("Content-Range: {value}"))),
                    "{headers}"
                );
            }
            assert!(
                headers
                    .lines()
                    .any(|line| line.eq_ignore_ascii_case("Access-Control-Allow-Origin: *")),
                "{headers}"
            );
            assert_eq!(received, body);
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn concurrent_http_range_requests_return_the_requested_bytes() {
        const CLIENTS: usize = 32;
        const CHUNK: usize = 4096;
        let path = std::env::temp_dir().join(format!("wave-http-{}.mp3", uuid::Uuid::new_v4()));
        let contents: Vec<u8> = (0..1_000_000).map(|index| (index % 251) as u8).collect();
        std::fs::write(&path, &contents).unwrap();
        let server = Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let worker = thread::spawn(move || {
            let mut requests = Vec::new();
            for _ in 0..CLIENTS {
                let request = server.recv().unwrap();
                let file = path.clone();
                requests.push(thread::spawn(move || {
                    let range = request
                        .headers()
                        .iter()
                        .find(|header| header.field.equiv("Range"))
                        .map(|header| header.value.as_str());
                    let response = file_response(&file, range, false).unwrap();
                    request.respond(response).unwrap();
                }));
            }
            for request in requests {
                request.join().unwrap();
            }
            std::fs::remove_file(path).unwrap();
        });

        let clients: Vec<_> = (0..CLIENTS)
            .map(|index| {
                thread::spawn(move || {
                    let start = index * 13_337;
                    let end = start + CHUNK - 1;
                    let mut stream = TcpStream::connect(address).unwrap();
                    stream
                        .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                        .unwrap();
                    write!(
                        stream,
                        "GET / HTTP/1.1\r\nHost: {address}\r\nRange: bytes={start}-{end}\r\nConnection: close\r\n\r\n"
                    )
                    .unwrap();
                    let mut response = Vec::new();
                    stream.read_to_end(&mut response).unwrap();
                    let split = response.windows(4).position(|part| part == b"\r\n\r\n").unwrap();
                    assert!(response.starts_with(b"HTTP/1.1 206 "));
                    (start, response[split + 4..].to_vec())
                })
            })
            .collect();

        for client in clients {
            let (start, received) = client.join().unwrap();
            assert_eq!(received, contents[start..start + CHUNK]);
        }
        worker.join().unwrap();
    }
}
