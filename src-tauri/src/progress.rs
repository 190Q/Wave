use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// One update from a long job, sent on the job's own event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// `authorising`, `resolving`, `downloading`, `importing`, `lyrics`, `done`
    /// or `failed`.
    pub phase: String,
    /// Items handled so far, including the one underway.
    pub done: usize,
    pub total: usize,
    /// The item being worked on.
    pub label: String,
    pub message: String,
    pub failures: Vec<String>,
    /// Items left alone because the library already had them.
    pub reused: usize,
}

/// Collects progress so every update carries the whole picture.
pub struct Reporter {
    app: AppHandle,
    event: &'static str,
    phase: String,
    total: usize,
    done: usize,
    label: String,
    message: String,
    failures: Vec<String>,
    reused: usize,
}

impl Reporter {
    pub fn new(app: &AppHandle, event: &'static str) -> Self {
        Self {
            app: app.clone(),
            event,
            phase: String::new(),
            total: 0,
            done: 0,
            label: String::new(),
            message: String::new(),
            failures: Vec::new(),
            reused: 0,
        }
    }

    pub fn failures(&self) -> &[String] {
        &self.failures
    }

    fn send(&self) {
        let _ = self.app.emit(
            self.event,
            Progress {
                phase: self.phase.clone(),
                done: self.done,
                total: self.total,
                label: self.label.clone(),
                message: self.message.clone(),
                failures: self.failures.clone(),
                reused: self.reused,
            },
        );
    }

    pub fn phase(&mut self, phase: &str, message: &str) {
        self.phase = phase.to_string();
        self.message = message.to_string();
        self.send();
    }

    pub fn count(&mut self, total: usize) {
        self.total = total;
        self.done = 0;
        self.send();
    }

    /// The item now underway, counted as done so the readout never lags.
    pub fn at(&mut self, position: usize, label: &str) {
        self.done = position;
        self.label = label.to_string();
        self.send();
    }

    pub fn fail(&mut self, message: String) {
        self.failures.push(message);
        self.send();
    }

    /// An item the library already had, so nothing was done for it.
    pub fn reuse(&mut self) {
        self.reused += 1;
        self.send();
    }
}
