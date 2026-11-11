//! A plain-text record of every yt-dlp run an import makes, so a download that
//! goes wrong can be read back afterwards. The file holds the last import only:
//! the first entry an import writes rewrites whatever was there.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::identity::now_ms;

/// The folder the log lives in, beside the library.
const LOG_DIR: &str = "logs";
const LOG_FILE: &str = "import.log";

/// The log the import underway is writing, if there is one. An import is run
/// one at a time, so the newest is the one that matters.
static CURRENT: Mutex<Option<Arc<Log>>> = Mutex::new(None);

/// One import's record. The file is opened on the first write rather than when
/// the import starts, so an import that never runs yt-dlp leaves the last log
/// standing instead of wiping it.
pub struct Log {
    /// `None` until something is written, which is also what rewrites the file.
    file: Mutex<Option<File>>,
    path: PathBuf,
    source: String,
    started_at: i64,
}

/// What one yt-dlp run produced, which is all the log reads from it.
pub struct Ran<'a> {
    pub code: Option<i32>,
    pub stdout: &'a [u8],
    pub stderr: &'a [u8],
}

impl<'a> Ran<'a> {
    pub fn of(output: &'a Output) -> Self {
        Self {
            code: output.status.code(),
            stdout: &output.stdout,
            stderr: &output.stderr,
        }
    }
}

/// Starts the log for the import about to run, and makes it the current one.
/// `None` when the file cannot be placed, because logging is never worth
/// failing an import over.
pub fn begin<R: Runtime>(app: &AppHandle<R>, source: &str) -> Option<Arc<Log>> {
    let log = Arc::new(Log::at(log_path(app).ok()?, source, now_ms()));

    let mut slot = CURRENT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *slot = Some(log.clone());
    Some(log)
}

/// The log the import underway is writing, if there is one.
pub fn current() -> Option<Arc<Log>> {
    CURRENT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

impl Log {
    fn at(path: PathBuf, source: &str, started_at: i64) -> Self {
        Self {
            file: Mutex::new(None),
            path,
            source: source.to_string(),
            started_at,
        }
    }

    /// One yt-dlp run: what it was for, the command, the exit code and both
    /// streams, so a failure can be read without running it again.
    pub fn run(&self, kind: &str, label: &str, command: &Command, ran: &Ran<'_>) {
        let heading = match label.trim() {
            "" => kind.to_string(),
            label => format!("{kind} - {label}"),
        };
        let code = match ran.code {
            Some(code) => code.to_string(),
            None => "killed".to_string(),
        };

        self.write(&format!(
            "[{}] {heading}\n  {}\n  exit code: {code}\n  stdout:\n{}  stderr:\n{}\n",
            clock(now_ms()),
            describe(command),
            block(ran.stdout),
            block(ran.stderr),
        ));
    }

    /// Which import the log belongs to, once the link has been read.
    pub fn link(&self, name: &str, total: usize) {
        let noun = if total == 1 { "track" } else { "tracks" };
        self.write(&format!("\nLink: {name} ({total} {noun})\n"));
    }

    /// The line the import reported for a song, so the log ends on what the
    /// user was actually shown.
    pub fn failure(&self, reason: &str) {
        self.write(&format!("[{}] failed\n  {reason}\n\n", clock(now_ms())));
    }

    fn write(&self, text: &str) {
        let mut file = self.file.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        if file.is_none() {
            *file = self.open();
        }
        let Some(file) = file.as_mut() else {
            return;
        };

        let _ = file.write_all(text.as_bytes());
        let _ = file.flush();
    }

    /// Opens the file for the first write, rewriting an earlier import's log.
    fn open(&self) -> Option<File> {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&self.path)
            .ok()?;

        let header = format!(
            "Wave download log\nStarted {}\nSource: {}\n\n",
            timestamp(self.started_at),
            self.source
        );
        let _ = file.write_all(header.as_bytes());
        Some(file)
    }
}

/// Where the log is kept, with the folder made ready for it.
fn log_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data directory: {e}"))?
        .join(LOG_DIR);

    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir.join(LOG_FILE))
}

/// Where the download log is, so the dialog can say.
#[tauri::command]
pub fn import_log_path(app: AppHandle) -> Result<String, String> {
    Ok(log_path(&app)?.to_string_lossy().into_owned())
}

/// Opens the download log, making it first so there is something to open.
#[tauri::command]
pub fn open_import_log(app: AppHandle) -> Result<(), String> {
    let path = log_path(&app)?;
    if !path.is_file() {
        fs::write(&path, b"").map_err(|e| format!("could not create {}: {e}", path.display()))?;
    }

    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| format!("could not open {}: {e}", path.display()))
}

/// The command as it was run, so it can be pasted into a terminal.
fn describe(command: &Command) -> String {
    let mut parts = vec![quote(&command.get_program().to_string_lossy())];
    parts.extend(command.get_args().map(|arg| quote(&arg.to_string_lossy())));
    parts.join(" ")
}

/// An argument with a space in it is wrapped, so the line reads as one command.
fn quote(text: &str) -> String {
    if text.contains(' ') {
        return format!("\"{text}\"");
    }
    text.to_string()
}

/// One stream, indented under its heading. A stream that said nothing says so
/// rather than leaving a gap.
fn block(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim_end();
    if text.trim().is_empty() {
        return "    (nothing)\n".to_string();
    }

    let mut out = String::new();
    for line in text.lines() {
        out.push_str("    ");
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

/// A Unix time in milliseconds said as `YYYY-MM-DD HH:MM:SS`, in UTC.
fn timestamp(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);

    format!(
        "{year:04}-{month:02}-{day:02} {}",
        clock(ms)
    )
}

/// The time of day alone, which is what an entry heading needs.
fn clock(ms: i64) -> String {
    let seconds = ms.div_euclid(1000).rem_euclid(86_400);
    format!(
        "{:02}:{:02}:{:02}",
        seconds / 3600,
        (seconds % 3600) / 60,
        seconds % 60
    )
}

/// The date a count of days since 1970-01-01 falls on, by Howard Hinnant's
/// civil-from-days algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;

    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    } as u32;

    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::Path;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wave-download-log-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.join(LOG_FILE)
    }

    /// A log with a fixed start, so the header is the same every run.
    fn log(path: &Path) -> Log {
        Log::at(path.to_path_buf(), "spotify", 1_700_000_000_000)
    }

    #[test]
    fn the_first_entry_rewrites_what_an_earlier_import_left() {
        let path = scratch("truncates");
        fs::write(&path, b"an older import").unwrap();

        let log = log(&path);
        // Nothing written yet, so an import that ran no yt-dlp leaves the
        // older log standing.
        assert_eq!(fs::read_to_string(&path).unwrap(), "an older import");

        log.failure("ERROR: Video unavailable");

        let written = fs::read_to_string(&path).unwrap();
        assert!(written.starts_with("Wave download log\n"), "{written}");
        assert!(written.contains("Started 2023-11-14 22:13:20"), "{written}");
        assert!(written.contains("Source: spotify"), "{written}");
        assert!(written.contains("ERROR: Video unavailable"), "{written}");
        assert!(!written.contains("an older import"), "{written}");
    }

    #[test]
    fn writes_the_command_and_both_streams() {
        let path = scratch("entry");
        let log = log(&path);

        let mut command = Command::new("yt-dlp");
        command.arg("-x").arg("Hey Jude.mp3");
        log.run(
            "download",
            "The Beatles - Hey Jude",
            &command,
            &Ran {
                code: Some(1),
                stdout: b"[download] Destination: Hey Jude.mp3\n",
                stderr: b"ERROR: Video unavailable\n",
            },
        );

        let written = fs::read_to_string(&path).unwrap();
        assert!(
            written.contains("] download - The Beatles - Hey Jude\n"),
            "{written}"
        );
        assert!(written.contains("yt-dlp -x \"Hey Jude.mp3\""), "{written}");
        assert!(written.contains("exit code: 1"), "{written}");
        assert!(
            written.contains("    [download] Destination: Hey Jude.mp3"),
            "{written}"
        );
        assert!(written.contains("    ERROR: Video unavailable"), "{written}");
    }

    #[test]
    fn a_run_that_was_killed_says_so() {
        let path = scratch("killed");
        let log = log(&path);

        log.run(
            "search",
            "",
            &Command::new("yt-dlp"),
            &Ran {
                code: None,
                stdout: b"",
                stderr: b"",
            },
        );

        let written = fs::read_to_string(&path).unwrap();
        // A search has nothing to name, so it is headed by its kind alone.
        assert!(written.contains("] search\n"), "{written}");
        assert!(written.contains("exit code: killed"), "{written}");
        assert_eq!(written.matches("(nothing)").count(), 2, "{written}");
    }

    #[test]
    fn names_the_import_and_what_failed() {
        let path = scratch("names");
        let log = log(&path);

        log.link("Vol. 3", 14);
        log.link("One song", 1);
        log.failure("ERROR: Video unavailable");

        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("Link: Vol. 3 (14 tracks)"), "{written}");
        assert!(written.contains("Link: One song (1 track)"), "{written}");
        assert!(written.contains("] failed\n  ERROR: Video unavailable"), "{written}");
    }

    #[test]
    fn a_stream_that_said_nothing_reads_as_nothing() {
        assert_eq!(block(b"   \n"), "    (nothing)\n");
        assert_eq!(block(b""), "    (nothing)\n");
        assert_eq!(block(b"one\ntwo\n"), "    one\n    two\n");
    }

    #[test]
    fn says_when_it_ran() {
        assert_eq!(timestamp(0), "1970-01-01 00:00:00");
        assert_eq!(timestamp(1_000_000_000_000), "2001-09-09 01:46:40");
        assert_eq!(timestamp(1_700_000_000_000), "2023-11-14 22:13:20");
        assert_eq!(timestamp(2_000_000_000_000), "2033-05-18 03:33:20");
        assert_eq!(clock(1_700_000_000_000), "22:13:20");
        assert_eq!(clock(1_700_000_043_000), "22:14:03");
    }
}
