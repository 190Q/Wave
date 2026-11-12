//! The bridge between the API and the player.
//!
//! Playback lives in the webview, so a command is emitted to the window as
//! `api-command`, carrying an id of its own. The window answers by calling the
//! `api_report` command with that id in the report it sends, which is what lets
//! a playback call answer with what is playing now rather than "accepted". The
//! wait is short, and a window that does not answer is an error rather than a
//! hang.

use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};

use crate::identity;

use super::COMMAND_EVENT;

/// How long a command waits for the window to say it applied it.
const ACK_WAIT: Duration = Duration::from_millis(500);

/// What the window says about the player, and the command it has just applied.
///
/// The fields are the ones the front end and the Rust side agreed on, so a
/// rename on either side is a broken seam. The position, the length and the
/// volume are read as numbers rather than as whole numbers, because the player
/// works in fractions and a report that will not parse would cost the caller
/// its answer.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Report {
    /// The id of the command just applied, or `None` for a plain update.
    pub command: Option<String>,
    pub current_id: Option<String>,
    pub source_id: Option<String>,
    pub source_name: String,
    /// The play order, which is what the queue is.
    pub order: Vec<String>,
    pub source_order: Vec<String>,
    /// Where in `order` the current song sits.
    pub cursor: usize,
    pub position_ms: f64,
    pub duration_ms: f64,
    pub playing: bool,
    pub shuffle: bool,
    /// `off` or `all`.
    pub repeat: String,
    pub volume: f64,
    pub muted: bool,
}

/// One command for the window, in the shape the two sides agreed on. Every
/// field is written, null or not, so the front end never has to tell a missing
/// field from one it was not meant to use.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub id: String,
    pub action: String,
    pub value: Option<f64>,
    pub track_id: Option<String>,
    pub track_ids: Vec<String>,
    pub source_id: Option<String>,
    pub source_name: Option<String>,
    pub start_track_id: Option<String>,
    pub text: Option<String>,
    pub flag: Option<bool>,
}

impl Command {
    /// A command with an id of its own, which is what the report that comes
    /// back is matched on.
    pub fn new(action: &str) -> Self {
        Self {
            id: identity::new_id(),
            action: action.to_string(),
            value: None,
            track_id: None,
            track_ids: Vec::new(),
            source_id: None,
            source_name: None,
            start_track_id: None,
            text: None,
            flag: None,
        }
    }

    /// A seek in milliseconds, a volume level, or a step to move by.
    pub fn value(mut self, value: f64) -> Self {
        self.value = Some(value);
        self
    }

    pub fn track(mut self, id: &str) -> Self {
        self.track_id = Some(id.to_string());
        self
    }

    pub fn tracks(mut self, ids: Vec<String>) -> Self {
        self.track_ids = ids;
        self
    }

    /// The collection a queue came from. A collection the window knows by its
    /// own id is left to name itself, so only an id the caller supplied is
    /// passed on.
    pub fn source(mut self, id: Option<String>, name: Option<String>) -> Self {
        self.source_id = id;
        self.source_name = name;
        self
    }

    pub fn start(mut self, id: Option<String>) -> Self {
        self.start_track_id = id;
        self
    }

    /// A repeat mode, which is the only thing the window reads as text.
    pub fn text(mut self, text: &str) -> Self {
        self.text = Some(text.to_string());
        self
    }

    pub fn flag(mut self, flag: bool) -> Self {
        self.flag = Some(flag);
        self
    }
}

/// What the window has said, as it has said it.
#[derive(Default)]
struct Heard {
    /// The last report, whatever it carried.
    last: Option<Report>,
    /// The last report that acknowledged a command, kept apart from `last` so
    /// a plain update landing just afterwards cannot hide the answer.
    acked: Option<(String, Report)>,
}

/// The last report the window sent, and a way to wait for the next one.
#[derive(Default)]
pub struct Bridge {
    heard: Mutex<Heard>,
    arrived: Condvar,
}

impl Bridge {
    /// The last report, or nothing when the window has not sent one yet.
    pub fn snapshot(&self) -> Option<Report> {
        self.guard().last.clone()
    }

    /// Takes in a report from the window and wakes whoever is waiting on it.
    pub fn accept(&self, report: Report) {
        let mut heard = self.guard();
        if let Some(id) = report.command.clone() {
            heard.acked = Some((id, report.clone()));
        }
        heard.last = Some(report);
        self.arrived.notify_all();
    }

    /// Sends a command and waits for the window to say it applied it, which is
    /// what makes a playback call answer with the player as it now stands.
    pub fn send<R: Runtime>(&self, app: &AppHandle<R>, command: Command) -> Result<Report, String> {
        let id = command.id.clone();
        app.emit(COMMAND_EVENT, &command)
            .map_err(|e| format!("the window could not be reached: {e}"))?;

        self.wait(&id)
    }

    /// Waits for the window to acknowledge a command by id, or gives up.
    fn wait(&self, id: &str) -> Result<Report, String> {
        let mut heard = self.guard();
        let deadline = Instant::now() + ACK_WAIT;

        loop {
            if let Some((acked, report)) = heard.acked.as_ref() {
                if acked == id {
                    return Ok(report.clone());
                }
            }

            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(format!(
                    "the window did not apply {id} within {}ms, so nothing was changed",
                    ACK_WAIT.as_millis()
                ));
            }

            heard = self
                .arrived
                .wait_timeout(heard, left)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
    }

    fn guard(&self) -> MutexGuard<'_, Heard> {
        // A poisoned lock only means another command panicked mid-write.
        self.heard
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// What the window says about the player. Called on every player change, on a
/// one-second position timer, and again, carrying the id, as soon as a command
/// has been applied.
#[tauri::command]
pub fn api_report(bridge: State<'_, Bridge>, report: Report) {
    bridge.accept(report);
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Arc;
    use std::thread;

    #[test]
    fn a_command_waits_for_the_window_to_acknowledge_it() {
        let bridge = Arc::new(Bridge::default());
        let waiting = bridge.clone();
        let id = "command-1".to_string();
        let wanted = id.clone();

        let waiter = thread::spawn(move || waiting.wait(&wanted));
        thread::sleep(Duration::from_millis(50));
        bridge.accept(Report {
            command: Some(id),
            playing: true,
            ..Report::default()
        });

        let answered = waiter.join().unwrap().unwrap();
        assert_eq!(answered.command.as_deref(), Some("command-1"));
        assert!(answered.playing);
    }

    /// The window sends an update every second while a song plays, so one can
    /// land between the answer and the waiting thread waking up.
    #[test]
    fn a_plain_update_after_the_answer_does_not_hide_it() {
        let bridge = Bridge::default();
        bridge.accept(Report {
            command: Some("command-1".to_string()),
            playing: false,
            ..Report::default()
        });
        bridge.accept(Report {
            command: None,
            playing: true,
            ..Report::default()
        });

        let answered = bridge.wait("command-1").unwrap();
        assert!(!answered.playing, "the answer was the plain update");
        assert_eq!(
            bridge.snapshot().unwrap().playing,
            true,
            "the latest is kept"
        );
    }

    #[test]
    fn a_window_that_never_answers_gives_up() {
        let bridge = Bridge::default();
        let started = Instant::now();

        let error = bridge.wait("command-1").unwrap_err();

        assert!(error.contains("command-1"), "{error}");
        assert!(started.elapsed() >= ACK_WAIT, "the wait was not held");
    }

    #[test]
    fn a_report_is_read_in_the_shape_the_window_sends() {
        let raw = r#"{
            "command": null,
            "currentId": "abc",
            "sourceId": "liked",
            "sourceName": "Liked Songs",
            "order": ["abc", "def"],
            "sourceOrder": ["abc", "def"],
            "cursor": 1,
            "positionMs": 1000,
            "durationMs": 290000,
            "playing": true,
            "shuffle": false,
            "repeat": "all",
            "volume": 70,
            "muted": false
        }"#;

        let report: Report = serde_json::from_str(raw).unwrap();
        assert_eq!(report.command, None);
        assert_eq!(report.current_id.as_deref(), Some("abc"));
        assert_eq!(report.source_id.as_deref(), Some("liked"));
        assert_eq!(report.source_name, "Liked Songs");
        assert_eq!(report.order, vec!["abc", "def"]);
        assert_eq!(report.cursor, 1);
        assert_eq!(report.position_ms, 1000.0);
        assert_eq!(report.duration_ms, 290_000.0);
        assert!(report.playing);
        assert_eq!(report.repeat, "all");
        assert_eq!(report.volume, 70.0);
        assert!(!report.muted);
    }

    #[test]
    fn a_command_carries_every_field_the_window_reads() {
        let command = Command::new("playTrack").track("abc").value(1500.0);
        let json = serde_json::to_value(&command).unwrap();

        assert_eq!(json["action"], "playTrack");
        assert_eq!(json["trackId"], "abc");
        assert_eq!(json["value"], 1500.0);

        // Every field is written, so the front end never has to tell a missing
        // one from one it was not meant to use.
        for field in [
            "id",
            "action",
            "value",
            "trackId",
            "trackIds",
            "sourceId",
            "sourceName",
            "startTrackId",
            "text",
            "flag",
        ] {
            assert!(json.get(field).is_some(), "{field} is missing");
        }
        assert!(json["sourceId"].is_null());
        assert!(json["flag"].is_null());
        assert_eq!(json["trackIds"], serde_json::json!([]));

        // And the id is the one the report has to come back with.
        assert_eq!(json["id"], serde_json::json!(command.id));
    }
}
