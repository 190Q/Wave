use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::source::now_ms;

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
    /// When the pass being counted began, so the readout can estimate the rest.
    pub started_at: u64,
}

/// Where a long job's updates go: the app's own event, or the terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Output {
    /// Emitted on the job's event, for the window to draw.
    Events,
    /// Printed as the job runs, for the command line.
    Console,
}

/// Collects progress so every update carries the whole picture.
pub struct Reporter {
    app: Option<AppHandle>,
    event: &'static str,
    output: Output,
    phase: String,
    total: usize,
    done: usize,
    label: String,
    message: String,
    failures: Vec<String>,
    reused: usize,
    started_at: u64,
}

impl Reporter {
    pub fn new(app: &AppHandle, event: &'static str, output: Output) -> Self {
        Self {
            app: Some(app.clone()),
            event,
            output,
            ..Self::quiet()
        }
    }

    pub fn quiet() -> Self {
        Self {
            app: None,
            event: "",
            output: Output::Events,
            phase: String::new(),
            total: 0,
            done: 0,
            label: String::new(),
            message: String::new(),
            failures: Vec::new(),
            reused: 0,
            started_at: now_ms(),
        }
    }

    pub fn failures(&self) -> &[String] {
        &self.failures
    }

    fn emit(&self) {
        let Some(app) = &self.app else {
            return;
        };

        let _ = app.emit(
            self.event,
            Progress {
                phase: self.phase.clone(),
                done: self.done,
                total: self.total,
                label: self.label.clone(),
                message: self.message.clone(),
                failures: self.failures.clone(),
                reused: self.reused,
                started_at: self.started_at,
            },
        );
    }

    /// Whether the updates are going to the terminal instead of the window.
    fn console(&self) -> bool {
        self.output == Output::Console
    }

    /// One song, as it is handled.
    fn print_line(&self, position: usize, label: &str) {
        if self.total > 0 {
            println!("[{position}/{}] {label}", self.total);
        } else {
            println!("[{position}] {label}");
        }
    }

    pub fn phase(&mut self, phase: &str, message: &str) {
        self.phase = phase.to_string();
        self.message = message.to_string();
        if self.console() {
            // A failure is not printed here: the job returns it as an error, and
            // the caller is the one that says it, once.
            if phase != "failed" {
                println!("{message}");
            }
            return;
        }
        self.emit();
    }

    pub fn count(&mut self, total: usize) {
        self.total = total;
        self.done = 0;
        self.started_at = now_ms();
        if self.console() {
            return;
        }
        self.emit();
    }

    /// The item now underway, counted as done so the readout never lags.
    pub fn at(&mut self, position: usize, label: &str) {
        self.done = position;
        self.label = label.to_string();
        if self.console() {
            self.print_line(position, label);
            return;
        }
        self.emit();
    }

    pub fn fail(&mut self, message: String) {
        if self.console() {
            eprintln!("failed: {message}");
            self.failures.push(message);
            return;
        }
        self.failures.push(message);
        self.emit();
    }

    /// An item the library already had, so nothing was done for it. The label
    /// keeps the readout on the song being passed over.
    pub fn reuse(&mut self, label: &str) {
        self.label = label.to_string();
        self.reused += 1;
        if self.console() {
            println!("already in your library: {label}");
            return;
        }
        self.emit();
    }
}
