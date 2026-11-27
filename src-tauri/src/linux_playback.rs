//! GStreamer playback, with WebKit retained as a compatibility fallback.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::api::player::{Command, Report};

pub const STATE_EVENT: &str = "linux-native-playback-state";

const MAX_GAIN: f64 = 0.7;
const END_SLACK_MS: f64 = 200.0;

/// A queue entry playable without the WebView.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NativeTrack {
    pub id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub genre: String,
    pub year: Option<u16>,
    pub duration_ms: u64,
    pub codec: String,
    pub media_type: String,
    pub artwork: String,
    pub colour: String,
    /// Loudness normalisation selected by the frontend for this exact track.
    pub gain: f64,
}

/// `replace` distinguishes an explicit queue edit from a stale reconnect.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Sync {
    pub report: Report,
    pub tracks: Vec<NativeTrack>,
    pub equaliser_enabled: bool,
    pub output_id: String,
    pub replace: bool,
}

impl Default for Sync {
    fn default() -> Self {
        Self {
            report: Report::default(),
            tracks: Vec::new(),
            equaliser_enabled: false,
            output_id: String::new(),
            replace: false,
        }
    }
}

/// Native state broadcast on transitions, with positions sampled on read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub active: bool,
    pub reason: Option<String>,
    pub report: Report,
    pub revision: u64,
    pub transition: Option<Transition>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub kind: String,
    pub previous_track_id: Option<String>,
    pub current_track_id: Option<String>,
}

#[derive(Debug, Clone)]
enum Effect {
    None,
    Load {
        track: NativeTrack,
        position_ms: u64,
        playing: bool,
        crossfade: bool,
        previous_level: f64,
    },
    Play,
    PlayAt(u64),
    Pause,
    Stop,
    Seek(u64),
    Volume,
}

#[derive(Default)]
struct Queue {
    tracks: HashMap<String, NativeTrack>,
    report: Report,
    active: bool,
    reason: Option<String>,
    revision: u64,
    shuffle_seed: u64,
    transition: Option<Transition>,
}

impl Queue {
    fn status(&self) -> Status {
        Status {
            active: self.active,
            reason: self.reason.clone(),
            report: self.report.clone(),
            revision: self.revision,
            transition: self.transition.clone(),
        }
    }

    fn transition(&mut self, kind: impl Into<String>, previous_track_id: Option<String>) {
        self.transition = Some(Transition {
            kind: kind.into(),
            previous_track_id,
            current_track_id: self.report.current_id.clone(),
        });
    }

    fn set_shuffle(&mut self, enabled: bool) {
        if self.report.shuffle == enabled {
            return;
        }
        let current = self.report.current_id.clone();
        let source = self
            .report
            .source_order
            .clone()
            .unwrap_or_else(|| self.report.order.clone().unwrap_or_default());
        let order = if enabled {
            let mut remaining: Vec<String> = source
                .iter()
                .filter(|id| Some(id.as_str()) != current.as_deref())
                .cloned()
                .collect();
            self.shuffle_in_place(&mut remaining);
            let mut order = current.clone().into_iter().collect::<Vec<_>>();
            order.append(&mut remaining);
            order
        } else {
            source
        };
        self.report.cursor = current
            .as_ref()
            .and_then(|id| order.iter().position(|candidate| candidate == id))
            .unwrap_or(0);
        self.report.order = Some(order);
        self.report.shuffle = enabled;
    }

    fn shuffle_in_place(&mut self, values: &mut [String]) {
        for at in (1..values.len()).rev() {
            self.shuffle_seed = self
                .shuffle_seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let other = (self.shuffle_seed as usize) % (at + 1);
            values.swap(at, other);
        }
    }

    fn now_playing(&self) -> Option<crate::presence::NowPlaying> {
        if !self.active {
            return None;
        }
        let track = self.track()?;
        Some(crate::presence::NowPlaying {
            title: track.title.clone(),
            artist: track.artist.clone(),
            album: track.album.clone(),
            duration_ms: self.report.duration_ms.max(0.0).round() as u64,
            position_ms: self.report.position_ms.max(0.0).round() as u64,
            playing: self.report.playing,
            artwork: track.artwork.clone(),
            colour: track.colour.clone(),
        })
    }

    fn track(&self) -> Option<&NativeTrack> {
        self.report
            .current_id
            .as_deref()
            .and_then(|id| self.tracks.get(id))
    }

    fn level(&self) -> f64 {
        let Some(track) = self.track() else {
            return 0.0;
        };
        if !self.report.playing || self.report.muted {
            return 0.0;
        }
        ((self.report.volume.clamp(0.0, 100.0) / 100.0) * MAX_GAIN * track.gain.max(0.0))
            .clamp(0.0, 1.0)
    }

    fn at_end(&self) -> bool {
        let Some(track) = self.track() else {
            return false;
        };
        let duration = duration_for(track, self.report.duration_ms);
        duration > 0.0 && self.report.position_ms >= (duration - END_SLACK_MS).max(0.0)
    }

    fn deactivate(&mut self, reason: impl Into<String>) {
        self.active = false;
        self.reason = Some(reason.into());
        self.revision = self.revision.wrapping_add(1);
    }

    fn sync(&mut self, sync: Sync) -> Result<Effect, String> {
        let previous_track_id = self.report.current_id.clone();
        if sync.equaliser_enabled {
            self.deactivate("the equaliser is active, so Wave is using the WebKit playback path");
            self.transition("fallback", previous_track_id);
            return Ok(Effect::None);
        }
        if !sync.output_id.trim().is_empty() {
            self.deactivate("a selected audio output needs the WebKit playback path");
            self.transition("fallback", previous_track_id);
            return Ok(Effect::None);
        }

        let previous = self.report.clone();
        let previous_track = self.track().cloned();
        let was_active = self.active;
        for track in sync.tracks {
            self.tracks.insert(track.id.clone(), track);
        }

        // A reconnect learns native state through `state`, not by replacing it.
        if self.active && !sync.replace {
            let gain_changed = previous_track
                .as_ref()
                .zip(self.track())
                .is_some_and(|(before, after)| before.gain != after.gain);
            return Ok(gain_changed
                .then_some(Effect::Volume)
                .unwrap_or(Effect::None));
        }

        self.report = normalise_report(sync.report);
        if self
            .report
            .order
            .as_ref()
            .is_some_and(|order| order.is_empty())
        {
            self.report.current_id = None;
            self.report.cursor = 0;
            self.report.playing = false;
        }
        let Some(track) = self.track().cloned() else {
            self.deactivate("the native queue has no playable current track");
            self.transition("fallback", previous.current_id);
            return Ok(Effect::None);
        };
        if track.path.trim().is_empty() {
            self.deactivate("the current track has no local audio path");
            self.transition("fallback", previous.current_id);
            return Ok(Effect::None);
        }
        let retain_slot = was_active
            && previous.current_id == self.report.current_id
            && previous_track
                .as_ref()
                .is_some_and(|before| before.path == track.path);
        if retain_slot {
            self.report.position_ms = previous.position_ms;
            self.report.duration_ms = previous.duration_ms;
        }

        self.active = true;
        self.reason = None;
        self.report.duration_ms = duration_for(&track, self.report.duration_ms);
        self.revision = self.revision.wrapping_add(1);
        self.transition(
            if sync.replace { "queue" } else { "sync" },
            previous.current_id.clone(),
        );
        if retain_slot {
            let effect = self.effect_after(&previous, "sync")?;
            let gain_changed = previous_track
                .as_ref()
                .is_some_and(|before| before.gain != track.gain);
            return Ok(if gain_changed && matches!(&effect, Effect::None) {
                Effect::Volume
            } else {
                effect
            });
        }
        Ok(Effect::Load {
            track,
            position_ms: milliseconds(self.report.position_ms),
            playing: self.report.playing,
            crossfade: previous.playing
                && self.report.playing
                && previous.current_id != self.report.current_id,
            previous_level: level_for(
                &previous,
                previous
                    .current_id
                    .as_deref()
                    .and_then(|id| self.tracks.get(id)),
            ),
        })
    }

    fn command(&mut self, command: &Command) -> Result<Effect, String> {
        if !self.active {
            return Err(self.reason.clone().unwrap_or_else(|| {
                "the Linux native player is not active; use the WebKit playback path".to_string()
            }));
        }

        let before = self.report.clone();
        match command.action.as_str() {
            "play" => {
                if self.track().is_some() {
                    if !self.report.playing && self.at_end() {
                        self.report.position_ms = 0.0;
                    }
                    self.report.playing = true;
                }
            }
            "pause" => self.report.playing = false,
            "toggle" => {
                if self.track().is_some() {
                    if !self.report.playing && self.at_end() {
                        self.report.position_ms = 0.0;
                    }
                    self.report.playing = !self.report.playing;
                }
            }
            "next" => self.step(1),
            "previous" => self.step(-1),
            "stop" => {
                self.report.playing = false;
                self.report.position_ms = 0.0;
            }
            "seek" => self.report.position_ms = command.value.unwrap_or(0.0).max(0.0),
            "seekBy" => {
                self.report.position_ms =
                    (self.report.position_ms + command.value.unwrap_or(10_000.0)).max(0.0);
            }
            "volume" => {
                self.report.volume = command
                    .value
                    .unwrap_or(self.report.volume)
                    .clamp(0.0, 100.0);
                if self.report.volume > 0.0 {
                    self.report.muted = false;
                }
            }
            "mute" => {
                if let Some(muted) = command.flag {
                    self.report.muted = muted;
                }
            }
            "shuffle" => {
                if let Some(shuffle) = command.flag {
                    self.set_shuffle(shuffle);
                }
            }
            "repeat" => {
                self.report.repeat = if command.text.as_deref() == Some("all") {
                    "all".to_string()
                } else {
                    "off".to_string()
                };
            }
            "playTrack" => {
                let id = command
                    .track_id
                    .as_deref()
                    .ok_or_else(|| "playTrack needs trackId".to_string())?;
                self.select(id, true)?;
            }
            "queue" => self.replace(command)?,
            "queueAppend" => self.append(command.track_id.as_deref(), false)?,
            "queueNext" => self.append(command.track_id.as_deref(), true)?,
            "queueRemove" => self.remove(command.track_id.as_deref())?,
            "playCollection" | "openCollection" => {
                return Err(
                    "collection playback needs a resolved queue from the frontend".to_string(),
                );
            }
            action => return Err(format!("the native player does not recognise {action}")),
        }

        self.clamp_position();
        self.revision = self.revision.wrapping_add(1);
        self.transition(command.action.clone(), before.current_id.clone());
        self.effect_after(&before, command.action.as_str())
    }

    fn effect_after(&self, before: &Report, action: &str) -> Result<Effect, String> {
        if before.current_id != self.report.current_id {
            let Some(track) = self.track().cloned() else {
                return Ok(Effect::Stop);
            };
            return Ok(Effect::Load {
                track,
                position_ms: milliseconds(self.report.position_ms),
                playing: self.report.playing,
                crossfade: before.playing && self.report.playing,
                previous_level: level_for(
                    before,
                    before
                        .current_id
                        .as_deref()
                        .and_then(|id| self.tracks.get(id)),
                ),
            });
        }
        if action == "next"
            && before.playing
            && self.report.playing
            && before.current_id == self.report.current_id
            && self.report.current_id.is_some()
            && self.report.repeat == "all"
        {
            let track = self
                .track()
                .cloned()
                .ok_or_else(|| "the selected queue entry is unavailable".to_string())?;
            return Ok(Effect::Load {
                track,
                position_ms: 0,
                playing: true,
                crossfade: false,
                previous_level: 0.0,
            });
        }
        if action == "stop" {
            return Ok(Effect::Stop);
        }
        if before.playing != self.report.playing {
            return Ok(if self.report.playing {
                (before.position_ms != self.report.position_ms)
                    .then_some(Effect::PlayAt(milliseconds(self.report.position_ms)))
                    .unwrap_or(Effect::Play)
            } else {
                Effect::Pause
            });
        }
        if before.position_ms != self.report.position_ms {
            return Ok(Effect::Seek(milliseconds(self.report.position_ms)));
        }
        if before.volume != self.report.volume || before.muted != self.report.muted {
            return Ok(Effect::Volume);
        }
        Ok(Effect::None)
    }

    fn step(&mut self, direction: i8) {
        let Some(order) = self.report.order.as_ref() else {
            return;
        };
        if order.is_empty() {
            return;
        }
        let last = order.len() - 1;
        let next = if direction > 0 {
            (self.report.cursor < last)
                .then_some(self.report.cursor + 1)
                .or_else(|| (self.report.repeat == "all").then_some(0))
        } else {
            (self.report.cursor > 0)
                .then(|| self.report.cursor - 1)
                .or_else(|| (self.report.repeat == "all").then_some(last))
        };
        if let Some(cursor) = next {
            let id = order.get(cursor).cloned();
            self.report.cursor = cursor;
            self.report.current_id = id;
            self.report.position_ms = 0.0;
            self.report.playing = true;
            self.report.duration_ms = self
                .track()
                .map(|track| track.duration_ms as f64)
                .unwrap_or_default();
        }
    }

    fn select(&mut self, id: &str, playing: bool) -> Result<(), String> {
        let order = self
            .report
            .order
            .as_ref()
            .ok_or_else(|| "the queue is empty".to_string())?;
        let cursor = order
            .iter()
            .position(|candidate| candidate == id)
            .ok_or_else(|| format!("{id} is not in the queue"))?;
        self.report.cursor = cursor;
        self.report.current_id = Some(id.to_string());
        self.report.position_ms = 0.0;
        self.report.playing = playing;
        self.report.duration_ms = self
            .tracks
            .get(id)
            .map(|track| track.duration_ms as f64)
            .unwrap_or_default();
        Ok(())
    }

    fn replace(&mut self, command: &Command) -> Result<(), String> {
        let playing = self.report.playing;
        self.set_queue(
            command.source_id.clone(),
            command.source_name.clone().unwrap_or_default(),
            command.track_ids.clone(),
            command.start_track_id.as_deref(),
            playing,
        )
    }

    fn set_queue(
        &mut self,
        source_id: Option<String>,
        source_name: String,
        track_ids: Vec<String>,
        start_track_id: Option<&str>,
        playing: bool,
    ) -> Result<(), String> {
        let current = start_track_id
            .filter(|id| track_ids.iter().any(|candidate| candidate == id))
            .map(ToString::to_string)
            .or_else(|| track_ids.first().cloned());
        let mut order = track_ids.clone();
        if self.report.shuffle {
            order.retain(|id| Some(id) != current.as_ref());
            self.shuffle_in_place(&mut order);
            if let Some(current) = current.as_ref() {
                order.insert(0, current.clone());
            }
        }
        self.report.source_id = source_id;
        self.report.source_name = source_name;
        self.report.source_order = Some(track_ids);
        self.report.order = Some(order);
        self.report.cursor = 0;
        self.report.current_id = None;
        self.report.position_ms = 0.0;
        self.report.playing = false;
        if let Some(id) = current.as_deref() {
            self.select(id, playing)?;
        }
        Ok(())
    }

    fn append(&mut self, id: Option<&str>, next: bool) -> Result<(), String> {
        let id = id.ok_or_else(|| "the queue command needs trackId".to_string())?;
        if !self.tracks.contains_key(id) {
            return Err(format!("{id} is not available to the native player"));
        }
        {
            let order = self.report.order.get_or_insert_with(Vec::new);
            if order.contains(&id.to_string()) {
                return Ok(());
            }
            if next && !order.is_empty() {
                order.insert((self.report.cursor + 1).min(order.len()), id.to_string());
            } else {
                order.push(id.to_string());
            }
        }
        self.report
            .source_order
            .get_or_insert_with(Vec::new)
            .push(id.to_string());
        if self.report.current_id.is_none() {
            self.select(id, false)?;
        }
        Ok(())
    }

    fn remove(&mut self, id: Option<&str>) -> Result<(), String> {
        let id = id.ok_or_else(|| "the queue command needs trackId".to_string())?;
        let Some(index) = self
            .report
            .order
            .as_ref()
            .and_then(|order| order.iter().position(|candidate| candidate == id))
        else {
            return Ok(());
        };
        let was_current = self.report.current_id.as_deref() == Some(id);
        let order = self.report.order.as_mut().expect("queue was checked");
        order.remove(index);
        let empty = order.is_empty();
        let next_id = (!empty).then(|| order[self.report.cursor.min(order.len() - 1)].clone());
        if let Some(source) = self.report.source_order.as_mut() {
            source.retain(|candidate| candidate != id);
        }
        if empty {
            self.report.current_id = None;
            self.report.cursor = 0;
            self.report.position_ms = 0.0;
            self.report.duration_ms = 0.0;
            self.report.playing = false;
        } else if was_current {
            self.report.cursor = self
                .report
                .cursor
                .min(self.report.order.as_ref().expect("not empty").len() - 1);
            self.report.current_id = next_id;
            self.report.position_ms = 0.0;
            self.report.duration_ms = self
                .track()
                .map(|track| track.duration_ms as f64)
                .unwrap_or_default();
        } else if index < self.report.cursor {
            self.report.cursor -= 1;
        }
        Ok(())
    }

    fn clamp_position(&mut self) {
        if let Some(track) = self.track() {
            let duration = duration_for(track, self.report.duration_ms);
            self.report.duration_ms = duration;
            if self.report.duration_ms > 0.0 {
                self.report.position_ms =
                    self.report.position_ms.clamp(0.0, self.report.duration_ms);
            }
        }
    }
}

fn normalise_report(mut report: Report) -> Report {
    if report.repeat != "all" {
        report.repeat = "off".to_string();
    }
    report.volume = report.volume.clamp(0.0, 100.0);
    if let Some(order) = report.order.as_ref() {
        if order.is_empty() {
            report.cursor = 0;
            report.current_id = None;
        } else {
            report.cursor = report.cursor.min(order.len() - 1);
            report.current_id = order.get(report.cursor).cloned();
        }
    }
    report
}

fn duration_for(track: &NativeTrack, reported: f64) -> f64 {
    if reported > 0.0 {
        reported
    } else {
        track.duration_ms as f64
    }
}

fn milliseconds(value: f64) -> u64 {
    value.max(0.0).round() as u64
}

fn level_for(report: &Report, track: Option<&NativeTrack>) -> f64 {
    if !report.playing || report.muted {
        return 0.0;
    }
    let gain = track.map(|track| track.gain).unwrap_or(1.0).max(0.0);
    ((report.volume.clamp(0.0, 100.0) / 100.0) * MAX_GAIN * gain).clamp(0.0, 1.0)
}

#[cfg(target_os = "linux")]
pub(crate) mod runtime {
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex, MutexGuard};
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    use gst::prelude::*;
    use gstreamer as gst;
    use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
    use tauri::{AppHandle, Emitter, Manager, State};
    use zbus::blocking::{Connection, Proxy};

    use super::{Effect, MAX_GAIN, NativeTrack, Queue, STATE_EVENT, Status, Sync};
    use crate::analytics::{Analytics, PlayRecord, TrackSnapshot};
    use crate::api::player::{Command, Report};
    use crate::catalog::{Catalog, TrackRow};
    use crate::presence::Presence;
    use crate::state::{PersistedState, Playback, Session, Store};

    const ACTIVE_WAIT: Duration = Duration::from_millis(500);
    const IDLE_WAIT: Duration = Duration::from_secs(2);
    const CHECKPOINT: Duration = Duration::from_secs(15);
    const PREROLL_WAIT: Duration = Duration::from_secs(5);
    const MIN_LISTEN_MS: u64 = 1_000;
    const FADE: Duration = Duration::from_millis(300);
    const FADE_STEPS: u64 = 15;
    const PATH_ESCAPE: &AsciiSet = &CONTROLS
        .add(b' ')
        .add(b'"')
        .add(b'#')
        .add(b'%')
        .add(b'<')
        .add(b'>')
        .add(b'?')
        .add(b'`')
        .add(b'{')
        .add(b'}');

    pub struct NativePlayback {
        app: AppHandle,
        inner: Arc<Mutex<Inner>>,
        operation: Arc<Mutex<()>>,
        inhibitor: Arc<Mutex<SuspendInhibitorState>>,
        inhibitor_generation: Arc<AtomicU64>,
        stopping: Arc<AtomicBool>,
        worker: Arc<Mutex<Option<JoinHandle<()>>>>,
    }

    struct Inner {
        queue: Queue,
        engine: Option<Engine>,
        checkpoint: Instant,
        listening: Listening,
    }

    #[derive(Default)]
    struct Listening {
        active: Option<ActiveListen>,
    }

    struct ActiveListen {
        track: NativeTrack,
        listen_id: String,
        started_at: i64,
        played_ms: u64,
        playing_since: Option<Instant>,
        source_id: Option<String>,
        source_name: String,
        source_kind: Option<String>,
        shuffle: bool,
        repeat: String,
    }

    struct HistoryWrite {
        track: NativeTrack,
        play: PlayRecord,
    }

    struct HistoryContext {
        enabled: bool,
        source_kind: Option<String>,
    }

    struct SuspendInhibitor {
        connection: Connection,
        request: Option<zbus::zvariant::OwnedObjectPath>,
    }

    enum SuspendInhibitorState {
        Inactive,
        Acquiring(u64),
        Active(SuspendInhibitor),
    }

    impl SuspendInhibitor {
        fn acquire() -> Result<Self, String> {
            let connection = Connection::session()
                .map_err(|error| format!("could not open the session bus: {error}"))?;
            let proxy = Proxy::new(
                &connection,
                "org.freedesktop.portal.Desktop",
                "/org/freedesktop/portal/desktop",
                "org.freedesktop.portal.Inhibit",
            )
            .map_err(|error| format!("could not reach the suspend inhibitor: {error}"))?;
            let options = HashMap::<String, zbus::zvariant::Value<'static>>::new();
            let request = proxy
                .call::<_, _, zbus::zvariant::OwnedObjectPath>("Inhibit", &("", 4_u32, options))
                .map_err(|error| format!("could not inhibit suspend: {error}"))?;
            Ok(Self {
                connection,
                request: Some(request),
            })
        }

        fn release(mut self) {
            let Some(request) = self.request.take() else {
                return;
            };
            let connection = self.connection.clone();
            thread::spawn(move || close_suspend_inhibitor(connection, request));
        }
    }

    impl Drop for SuspendInhibitor {
        fn drop(&mut self) {
            let Some(request) = self.request.take() else {
                return;
            };
            let connection = self.connection.clone();
            thread::spawn(move || close_suspend_inhibitor(connection, request));
        }
    }

    fn close_suspend_inhibitor(connection: Connection, request: zbus::zvariant::OwnedObjectPath) {
        let result = Proxy::new(
            &connection,
            "org.freedesktop.portal.Desktop",
            &request,
            "org.freedesktop.portal.Request",
        )
        .and_then(|proxy| proxy.call::<_, _, ()>("Close", &()));
        if let Err(error) = result {
            eprintln!("the playback suspend inhibitor could not be released: {error}");
        }
    }

    impl Listening {
        fn reconcile(
            &mut self,
            queue: &Queue,
            reason: Option<&str>,
            history: HistoryContext,
        ) -> Option<HistoryWrite> {
            if !history.enabled {
                self.active = None;
                return None;
            }
            let next = queue.active.then(|| queue.track().cloned()).flatten();
            let same_track = self
                .active
                .as_ref()
                .zip(next.as_ref())
                .is_some_and(|(active, next)| active.track.id == next.id);
            let should_finish = self.active.is_some() && (!same_track || reason.is_some());
            let write = should_finish
                .then(|| self.finish(reason.unwrap_or("skipped")))
                .flatten();

            if queue.active && queue.report.playing {
                if self.active.is_none() {
                    if let Some(track) = next {
                        self.start(track, &queue.report, history.source_kind);
                    }
                } else {
                    self.resume();
                }
            } else {
                self.pause();
            }
            write
        }

        fn checkpoint(&mut self) -> Option<HistoryWrite> {
            self.account(true);
            let active = self.active.as_ref()?;
            Some(HistoryWrite {
                track: active.track.clone(),
                play: PlayRecord {
                    listen_id: active.listen_id.clone(),
                    track_id: active.track.id.clone(),
                    started_at: active.started_at,
                    ended_at: None,
                    ms_played: active.played_ms.min(i64::MAX as u64) as i64,
                    duration_ms: active.track.duration_ms.min(i64::MAX as u64) as i64,
                    completed: false,
                    reason: "open".to_string(),
                    source_id: active.source_id.clone(),
                    source_name: Some(active.source_name.clone()),
                    source_kind: active.source_kind.clone(),
                    shuffle: active.shuffle,
                    repeat: Some(active.repeat.clone()),
                },
            })
        }

        fn start(&mut self, track: NativeTrack, report: &Report, source_kind: Option<String>) {
            self.active = Some(ActiveListen {
                track,
                listen_id: crate::identity::new_id(),
                started_at: crate::identity::now_ms(),
                played_ms: 0,
                playing_since: Some(Instant::now()),
                source_id: report.source_id.clone(),
                source_name: report.source_name.clone(),
                source_kind,
                shuffle: report.shuffle,
                repeat: report.repeat.clone(),
            });
        }

        fn resume(&mut self) {
            if let Some(active) = self.active.as_mut() {
                if active.playing_since.is_none() {
                    active.playing_since = Some(Instant::now());
                }
            }
        }

        fn pause(&mut self) {
            self.account(false);
        }

        fn finish(&mut self, reason: &str) -> Option<HistoryWrite> {
            self.account(false);
            let active = self.active.take()?;
            if reason != "ended" && active.played_ms < MIN_LISTEN_MS {
                return None;
            }
            Some(HistoryWrite {
                track: active.track.clone(),
                play: PlayRecord {
                    listen_id: active.listen_id,
                    track_id: active.track.id,
                    started_at: active.started_at,
                    ended_at: Some(crate::identity::now_ms()),
                    ms_played: active.played_ms.min(i64::MAX as u64) as i64,
                    duration_ms: active.track.duration_ms.min(i64::MAX as u64) as i64,
                    completed: reason == "ended",
                    reason: reason.to_string(),
                    source_id: active.source_id,
                    source_name: Some(active.source_name),
                    source_kind: active.source_kind,
                    shuffle: active.shuffle,
                    repeat: Some(active.repeat),
                },
            })
        }

        fn account(&mut self, continue_playing: bool) {
            let Some(active) = self.active.as_mut() else {
                return;
            };
            let Some(started) = active.playing_since.take() else {
                return;
            };
            let now = Instant::now();
            active.played_ms = active.played_ms.saturating_add(
                now.duration_since(started)
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64,
            );
            if continue_playing {
                active.playing_since = Some(now);
            }
        }
    }

    fn persist_history(app: &AppHandle, write: Option<HistoryWrite>) {
        let Some(write) = write else {
            return;
        };
        if !app.state::<Store>().snapshot().settings.analytics_enabled {
            return;
        }
        let analytics = app.state::<Analytics>();
        let snapshot = snapshot_for(&write.track);
        let _ = analytics.remember_tracks_preserving_existing(&[snapshot]);
        let _ = analytics.record_play(&write.play);
    }

    fn snapshot_for(track: &NativeTrack) -> TrackSnapshot {
        TrackSnapshot {
            id: track.id.clone(),
            title: track.title.clone(),
            artist: non_empty(&track.artist),
            album: non_empty(&track.album),
            album_artist: non_empty(&track.album_artist),
            genre: non_empty(&track.genre),
            year: track.year,
            duration_ms: track.duration_ms,
            media_type: media_type_for(track),
            codec: track.codec.clone(),
        }
    }

    fn non_empty(value: &str) -> Option<String> {
        (!value.trim().is_empty()).then(|| value.to_string())
    }

    fn media_type_for(track: &NativeTrack) -> String {
        match track.media_type.as_str() {
            "audiobook" | "podcast" | "music" => return track.media_type.clone(),
            _ => {}
        }
        if track
            .path
            .rsplit_once('.')
            .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("m4b"))
        {
            return "audiobook".to_string();
        }
        let genre = track.genre.to_lowercase();
        if genre.contains("audiobook") {
            "audiobook".to_string()
        } else if genre.contains("podcast") || genre.contains("spoken word") {
            "podcast".to_string()
        } else {
            "music".to_string()
        }
    }

    fn history_context(app: &AppHandle, queue: &Queue) -> HistoryContext {
        let state = app.state::<Store>().snapshot();
        let source_kind = queue
            .report
            .source_id
            .as_deref()
            .and_then(|source_id| source_kind(&state, source_id));
        HistoryContext {
            enabled: state.settings.analytics_enabled,
            source_kind,
        }
    }

    fn source_kind(state: &crate::state::PersistedState, source_id: &str) -> Option<String> {
        match source_id {
            "all" | "liked" => Some(source_id.to_string()),
            _ => {
                if let Some((kind, _)) = source_id.split_once(':') {
                    return matches!(kind, "artist" | "album" | "genre").then(|| kind.to_string());
                }
                state
                    .playlists
                    .iter()
                    .find(|playlist| playlist.id == source_id)
                    .map(|playlist| {
                        if playlist.kind == "generated" {
                            "generated".to_string()
                        } else {
                            "playlist".to_string()
                        }
                    })
            }
        }
    }

    impl NativePlayback {
        pub fn start(app: &AppHandle) -> Self {
            let inner = Arc::new(Mutex::new(Inner {
                queue: Queue::default(),
                engine: None,
                checkpoint: Instant::now(),
                listening: Listening::default(),
            }));
            let stopping = Arc::new(AtomicBool::new(false));
            let worker_inner = inner.clone();
            let worker_stopping = stopping.clone();
            let handle = app.clone();
            let worker = thread::spawn(move || worker(handle, worker_inner, worker_stopping));
            Self {
                app: app.clone(),
                inner,
                operation: Arc::new(Mutex::new(())),
                inhibitor: Arc::new(Mutex::new(SuspendInhibitorState::Inactive)),
                inhibitor_generation: Arc::new(AtomicU64::new(0)),
                stopping,
                worker: Arc::new(Mutex::new(Some(worker))),
            }
        }

        pub fn active(&self) -> bool {
            self.guard().queue.active
        }

        pub fn refresh_presence(&self, presence: &Presence) {
            let _operation = self.operation();
            let song = {
                let mut inner = self.guard();
                let Inner { queue, engine, .. } = &mut *inner;
                if !queue.active {
                    return;
                }
                if let Some(engine) = engine.as_ref() {
                    engine.sample(queue);
                }
                queue.now_playing()
            };
            presence.show(song);
        }

        pub fn restore_session(&self, app: &AppHandle) {
            let _operation = self.operation();
            let saved = app.state::<Store>().snapshot();
            if !saved.settings.resume_on_launch || self.active() {
                return;
            }
            let playback = saved.session.playback;
            let order = if playback.order.is_empty() {
                playback.source_order.clone()
            } else {
                playback.order.clone()
            };
            if order.is_empty() {
                return;
            }
            let tracks = match resolve_tracks(app, &order) {
                Ok(tracks) if tracks.len() == order.len() => tracks,
                Ok(_) => return,
                Err(error) => {
                    eprintln!("the native playback session could not be restored: {error}");
                    return;
                }
            };
            let report = Report {
                source_id: playback.source_id,
                source_name: playback.source_name,
                source_order: Some(playback.source_order),
                order: Some(order),
                cursor: playback.cursor,
                position_ms: playback.position_ms as f64,
                playing: false,
                shuffle: playback.shuffle,
                repeat: playback.repeat,
                volume: f64::from(saved.settings.volume),
                muted: playback.muted,
                ..Report::default()
            };
            let _ = self.sync_locked(
                app,
                Sync {
                    report,
                    tracks,
                    equaliser_enabled: saved.settings.eq_enabled,
                    output_id: saved.settings.eq_output_id,
                    replace: true,
                },
            );
        }

        pub fn status(&self) -> Status {
            let mut inner = self.guard();
            let Inner { queue, engine, .. } = &mut *inner;
            if let Some(engine) = engine.as_ref() {
                engine.sample(queue);
            }
            queue.status()
        }

        pub fn save_frontend_session(
            &self,
            app: &AppHandle,
            mut session: Session,
        ) -> Result<PersistedState, String> {
            let _operation = self.operation();
            let status = self.status();
            app.state::<Store>().update_saved(app, |state| {
                if status.active {
                    session.saved_at = session.saved_at.max(state.session.saved_at);
                    update_session_playback(&mut session, &status.report);
                }
                state.session = session;
            })
        }

        pub fn sync(&self, app: &AppHandle, sync: Sync) -> Result<Status, String> {
            let _operation = self.operation();
            self.sync_locked(app, sync)
        }

        fn sync_locked(&self, app: &AppHandle, sync: Sync) -> Result<Status, String> {
            let (effect, history) = {
                let mut inner = self.guard();
                let Inner {
                    queue,
                    engine,
                    listening,
                    ..
                } = &mut *inner;
                if let Some(engine) = engine.as_ref() {
                    engine.sample(queue);
                }
                let before = queue.report.clone();
                let effect = queue.sync(sync)?;
                if !queue.active {
                    if let Some(engine) = engine.take() {
                        engine.shutdown();
                    }
                }
                let reason = if !queue.active {
                    Some("stopped")
                } else if before.current_id != queue.report.current_id {
                    Some("skipped")
                } else {
                    None
                };
                let history = listening.reconcile(queue, reason, history_context(app, queue));
                (effect, history)
            };
            persist_history(app, history);
            if let Err(error) = self.apply_locked(app, effect) {
                self.deactivate_locked(app, error);
                return Ok(self.status());
            }
            self.publish(app, true);
            Ok(self.status())
        }

        pub fn command(&self, app: &AppHandle, command: Command) -> Result<Report, String> {
            let _operation = self.operation();
            self.command_locked(app, command)
        }

        fn command_locked(&self, app: &AppHandle, command: Command) -> Result<Report, String> {
            let (effect, history) = {
                let mut inner = self.guard();
                let Inner {
                    queue,
                    engine,
                    listening,
                    ..
                } = &mut *inner;
                if let Some(engine) = engine.as_ref() {
                    engine.sample(queue);
                }
                let before = queue.report.clone();
                let effect = resolve_command(app, queue, &command)?;
                let reason = if command.action == "stop" {
                    Some("stopped")
                } else if before.current_id != queue.report.current_id {
                    Some("skipped")
                } else {
                    None
                };
                let history = listening.reconcile(queue, reason, history_context(app, queue));
                (effect, history)
            };
            persist_history(app, history);
            if let Err(error) = self.apply_locked(app, effect) {
                self.deactivate_locked(app, error.clone());
                return Err(error);
            }
            self.publish(app, true);
            Ok(self.status().report)
        }

        pub fn shutdown(&self) {
            self.stopping.store(true, Ordering::Release);
            if let Some(worker) = self
                .worker
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take()
            {
                let _ = worker.join();
            }
            let _operation = self.operation();
            let history = {
                let mut inner = self.guard();
                let Inner {
                    queue,
                    engine,
                    listening,
                    ..
                } = &mut *inner;
                if let Some(engine) = engine.as_ref() {
                    engine.sample(queue);
                }
                if let Some(engine) = engine.take() {
                    engine.shutdown();
                }
                queue.report.playing = false;
                listening.reconcile(queue, Some("stopped"), history_context(&self.app, queue))
            };
            persist_history(&self.app, history);
            self.update_suspend_inhibitor(false);
        }

        fn apply_locked(&self, app: &AppHandle, effect: Effect) -> Result<(), String> {
            let fade = {
                let mut inner = self.guard();
                if !inner.queue.active {
                    return Ok(());
                }
                let Inner { queue, engine, .. } = &mut *inner;
                if engine.is_none() {
                    *engine = Some(Engine::new()?);
                }
                let engine = engine.as_mut().expect("just created");
                if matches!(
                    &effect,
                    Effect::Load { .. }
                        | Effect::Play
                        | Effect::PlayAt(_)
                        | Effect::Pause
                        | Effect::Stop
                ) {
                    engine.supersede_fade();
                }
                let fade_epoch = engine.fade_epoch;
                let mut fade = match effect {
                    Effect::None => None,
                    Effect::Load {
                        track,
                        position_ms,
                        playing,
                        crossfade,
                        previous_level,
                    } => engine.load(
                        &track,
                        position_ms,
                        playing,
                        queue.level(),
                        crossfade,
                        previous_level,
                    )?,
                    Effect::Play => engine.play(queue.level())?,
                    Effect::PlayAt(position) => {
                        engine.seek(position, false)?;
                        engine.play(queue.level())?
                    }
                    Effect::Pause => engine.pause()?,
                    Effect::Stop => engine.stop()?,
                    Effect::Seek(position) => {
                        engine.seek(position, !queue.report.playing)?;
                        None
                    }
                    Effect::Volume => engine.volume(queue.level())?,
                };
                if let Some(fade) = fade.as_mut() {
                    fade.epoch = fade_epoch;
                }
                fade
            };
            if let Some(fade) = fade {
                let _ = spawn_fade(self.inner.clone(), fade);
            }
            let _ = app;
            Ok(())
        }

        fn publish(&self, app: &AppHandle, persist: bool) {
            let (status, song) = {
                let mut inner = self.guard();
                let Inner { queue, engine, .. } = &mut *inner;
                if let Some(engine) = engine.as_ref() {
                    engine.sample(queue);
                }
                (queue.status(), queue.now_playing())
            };
            if persist {
                persist_session(app, &status.report);
            }
            self.update_suspend_inhibitor(status.active && status.report.playing);
            if let Some(presence) = app.try_state::<Presence>() {
                presence.show(song);
            }
            let _ = app.emit(STATE_EVENT, &status);
        }

        fn deactivate_locked(&self, app: &AppHandle, reason: String) {
            let history = {
                let mut inner = self.guard();
                let Inner {
                    queue,
                    engine,
                    listening,
                    ..
                } = &mut *inner;
                let previous_track_id = queue.report.current_id.clone();
                if let Some(engine) = engine.as_ref() {
                    engine.sample(queue);
                }
                if let Some(engine) = engine.take() {
                    engine.shutdown();
                }
                queue.deactivate(reason);
                queue.transition("error", previous_track_id);
                listening.reconcile(queue, Some("error"), history_context(app, queue))
            };
            persist_history(app, history);
            self.publish(app, true);
        }

        fn update_suspend_inhibitor(&self, playing: bool) {
            if !playing {
                self.inhibitor_generation.fetch_add(1, Ordering::AcqRel);
                let inactive = {
                    let mut inhibitor = self
                        .inhibitor
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    std::mem::replace(&mut *inhibitor, SuspendInhibitorState::Inactive)
                };
                if let SuspendInhibitorState::Active(inhibitor) = inactive {
                    inhibitor.release();
                }
                return;
            }
            let generation = {
                let mut inhibitor = self
                    .inhibitor
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if !matches!(&*inhibitor, SuspendInhibitorState::Inactive) {
                    return;
                }
                let generation = self.inhibitor_generation.fetch_add(1, Ordering::AcqRel) + 1;
                *inhibitor = SuspendInhibitorState::Acquiring(generation);
                generation
            };
            let inhibitor = self.inhibitor.clone();
            thread::spawn(move || match SuspendInhibitor::acquire() {
                Ok(next) => {
                    let mut state = inhibitor.lock().unwrap_or_else(|error| error.into_inner());
                    if matches!(&*state, SuspendInhibitorState::Acquiring(current) if *current == generation)
                    {
                        *state = SuspendInhibitorState::Active(next);
                    }
                }
                Err(error) => {
                    let mut state = inhibitor.lock().unwrap_or_else(|error| error.into_inner());
                    if matches!(&*state, SuspendInhibitorState::Acquiring(current) if *current == generation)
                    {
                        *state = SuspendInhibitorState::Inactive;
                        eprintln!("the playback suspend inhibitor is unavailable: {error}");
                    }
                }
            });
        }

        fn operation(&self) -> MutexGuard<'_, ()> {
            self.operation
                .lock()
                .unwrap_or_else(|error| error.into_inner())
        }

        fn guard(&self) -> MutexGuard<'_, Inner> {
            self.inner.lock().unwrap_or_else(|error| error.into_inner())
        }
    }

    impl Clone for NativePlayback {
        fn clone(&self) -> Self {
            Self {
                app: self.app.clone(),
                inner: self.inner.clone(),
                operation: self.operation.clone(),
                inhibitor: self.inhibitor.clone(),
                inhibitor_generation: self.inhibitor_generation.clone(),
                stopping: self.stopping.clone(),
                worker: self.worker.clone(),
            }
        }
    }

    #[tauri::command]
    pub async fn linux_native_playback_sync(
        app: AppHandle,
        player: State<'_, NativePlayback>,
        sync: Sync,
    ) -> Result<Status, String> {
        let player = player.inner().clone();
        tauri::async_runtime::spawn_blocking(move || player.sync(&app, sync))
            .await
            .map_err(|error| {
                format!("the native playback synchronisation stopped unexpectedly: {error}")
            })?
    }

    #[tauri::command]
    pub async fn linux_native_playback_command(
        app: AppHandle,
        player: State<'_, NativePlayback>,
        command: Command,
    ) -> Result<Status, String> {
        let player = player.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            player.command(&app, command)?;
            Ok(player.status())
        })
        .await
        .map_err(|error| format!("the native playback command stopped unexpectedly: {error}"))?
    }

    #[tauri::command]
    pub async fn linux_native_playback_state(
        player: State<'_, NativePlayback>,
    ) -> Result<Status, String> {
        let player = player.inner().clone();
        tauri::async_runtime::spawn_blocking(move || player.status())
            .await
            .map_err(|error| {
                format!("the native playback state lookup stopped unexpectedly: {error}")
            })
    }

    fn worker(app: AppHandle, inner: Arc<Mutex<Inner>>, stopping: Arc<AtomicBool>) {
        while !stopping.load(Ordering::Acquire) {
            let (bus, wait, checkpoint, checkpoint_history) = {
                let mut inner = inner.lock().unwrap_or_else(|error| error.into_inner());
                let Inner {
                    queue,
                    engine,
                    checkpoint: last_checkpoint,
                    listening,
                } = &mut *inner;
                if let Some(engine) = engine.as_ref() {
                    engine.sample(queue);
                }
                let analytics_enabled = app.state::<Store>().analytics_enabled();
                if !analytics_enabled {
                    listening.active = None;
                }
                let checkpoint =
                    queue.active && queue.report.playing && last_checkpoint.elapsed() >= CHECKPOINT;
                if checkpoint {
                    *last_checkpoint = Instant::now();
                }
                if checkpoint && analytics_enabled && listening.active.is_none() {
                    let _ = listening.reconcile(queue, None, history_context(&app, queue));
                }
                let checkpoint_history = checkpoint.then(|| listening.checkpoint()).flatten();
                (
                    queue
                        .active
                        .then(|| engine.as_ref().and_then(Engine::bus))
                        .flatten(),
                    if queue.report.playing {
                        ACTIVE_WAIT
                    } else {
                        IDLE_WAIT
                    },
                    checkpoint,
                    checkpoint_history,
                )
            };
            persist_history(&app, checkpoint_history);

            let action = match bus {
                Some((generation, bus)) => {
                    Engine::poll(&bus, wait).map(|action| (generation, action))
                }
                None => {
                    thread::sleep(IDLE_WAIT);
                    None
                }
            };
            if stopping.load(Ordering::Acquire) {
                break;
            }

            let player = app.state::<NativePlayback>();
            if let Some((generation, action)) = action {
                let _operation = player.operation();
                let (effect, publish, history) = {
                    let mut inner = inner.lock().unwrap_or_else(|error| error.into_inner());
                    if inner
                        .engine
                        .as_ref()
                        .map_or(true, |engine| engine.generation != generation)
                    {
                        (None, false, None)
                    } else {
                        let Inner {
                            queue,
                            engine,
                            listening,
                            ..
                        } = &mut *inner;
                        match action {
                            BusAction::Ended => {
                                let before = queue.report.clone();
                                queue.step(1);
                                if before.current_id == queue.report.current_id
                                    && queue.report.repeat != "all"
                                {
                                    queue.report.playing = false;
                                    queue.report.position_ms = queue.report.duration_ms.max(0.0);
                                }
                                queue.revision = queue.revision.wrapping_add(1);
                                queue.transition("ended", before.current_id.clone());
                                let history = listening.reconcile(
                                    queue,
                                    Some("ended"),
                                    history_context(&app, queue),
                                );
                                (
                                    Some(
                                        queue.effect_after(&before, "next").unwrap_or(Effect::Stop),
                                    ),
                                    true,
                                    history,
                                )
                            }
                            BusAction::Failed(reason) => {
                                let previous_track_id = queue.report.current_id.clone();
                                if let Some(engine) = engine.as_ref() {
                                    engine.sample(queue);
                                }
                                if let Some(engine) = engine.take() {
                                    engine.shutdown();
                                }
                                queue.deactivate(reason);
                                queue.transition("error", previous_track_id);
                                let history = listening.reconcile(
                                    queue,
                                    Some("error"),
                                    history_context(&app, queue),
                                );
                                (None, true, history)
                            }
                        }
                    }
                };
                persist_history(&app, history);
                if let Some(effect) = effect {
                    if let Err(error) = player.apply_locked(&app, effect) {
                        player.deactivate_locked(&app, error);
                        continue;
                    }
                }
                if publish {
                    player.publish(&app, true);
                }
            } else if checkpoint {
                let _operation = player.operation();
                let status = player.status();
                if status.active {
                    persist_session(&app, &status.report);
                }
            }
        }
    }

    fn persist_session(app: &AppHandle, report: &Report) {
        let store = app.state::<Store>();
        let _ = store.update_saved(app, |state| {
            update_session_playback(&mut state.session, report);
            state.settings.volume = report.volume.clamp(0.0, 100.0).round() as u8;
        });
    }

    fn update_session_playback(session: &mut Session, report: &Report) {
        session.playback = Playback {
            source_id: report.source_id.clone(),
            source_name: report.source_name.clone(),
            source_order: report.source_order.clone().unwrap_or_default(),
            order: report.order.clone().unwrap_or_default(),
            cursor: report.cursor,
            position_ms: report.position_ms.max(0.0).round() as u64,
            shuffle: report.shuffle,
            repeat: report.repeat.clone(),
            muted: report.muted,
        };
        session.saved_at = session
            .saved_at
            .max(crate::identity::now_ms().max(0) as u64);
    }

    struct ResolvedCollection {
        id: String,
        name: String,
        tracks: Vec<NativeTrack>,
    }

    fn resolve_command(
        app: &AppHandle,
        queue: &mut Queue,
        command: &Command,
    ) -> Result<Effect, String> {
        if !queue.active {
            return Err(queue.reason.clone().unwrap_or_else(|| {
                "the Linux native player is not active; use the WebKit playback path".to_string()
            }));
        }
        match command.action.as_str() {
            "queue" => populate_tracks(app, queue, &command.track_ids)?,
            "queueAppend" | "queueNext" => {
                let id = command
                    .track_id
                    .as_deref()
                    .ok_or_else(|| "the queue command needs trackId".to_string())?;
                populate_tracks(app, queue, &[id.to_string()])?;
            }
            "playTrack" => {
                let id = command
                    .track_id
                    .as_deref()
                    .ok_or_else(|| "playTrack needs trackId".to_string())?;
                if !queue
                    .report
                    .order
                    .as_ref()
                    .is_some_and(|order| order.iter().any(|candidate| candidate == id))
                {
                    let all = resolve_collection(app, "all")?;
                    let ids: Vec<String> =
                        all.tracks.iter().map(|track| track.id.clone()).collect();
                    if !ids.iter().any(|candidate| candidate == id) {
                        return Err(format!(
                            "the native player cannot find {id} in the local library"
                        ));
                    }
                    let before = queue.report.clone();
                    populate_resolved(queue, all.tracks);
                    queue.set_queue(Some(all.id), all.name, ids, Some(id), true)?;
                    queue.clamp_position();
                    queue.revision = queue.revision.wrapping_add(1);
                    queue.transition(command.action.clone(), before.current_id.clone());
                    return queue.effect_after(&before, command.action.as_str());
                } else {
                    populate_tracks(app, queue, &[id.to_string()])?;
                }
            }
            "playCollection" | "openCollection" => {
                let id = command
                    .source_id
                    .as_deref()
                    .ok_or_else(|| "the collection command needs sourceId".to_string())?;
                let collection = resolve_collection(app, id)?;
                if collection.tracks.is_empty() {
                    return Err(format!("{id} has no playable tracks"));
                }
                let before = queue.report.clone();
                let ids: Vec<String> = collection
                    .tracks
                    .iter()
                    .map(|track| track.id.clone())
                    .collect();
                populate_resolved(queue, collection.tracks);
                let playing = command.action == "playCollection" || before.playing;
                queue.set_queue(Some(collection.id), collection.name, ids, None, playing)?;
                queue.clamp_position();
                queue.revision = queue.revision.wrapping_add(1);
                queue.transition(command.action.clone(), before.current_id.clone());
                return queue.effect_after(&before, command.action.as_str());
            }
            _ => {}
        }
        queue.command(command)
    }

    fn populate_tracks(app: &AppHandle, queue: &mut Queue, ids: &[String]) -> Result<(), String> {
        let tracks = resolve_tracks(app, ids)?;
        if tracks.len() != ids.len() {
            let found: std::collections::HashSet<&str> =
                tracks.iter().map(|track| track.id.as_str()).collect();
            let missing: Vec<&str> = ids
                .iter()
                .map(String::as_str)
                .filter(|id| !found.contains(id))
                .collect();
            return Err(format!(
                "the native player cannot find {} in the local library",
                missing.join(", ")
            ));
        }
        populate_resolved(queue, tracks);
        Ok(())
    }

    fn populate_resolved(queue: &mut Queue, tracks: Vec<NativeTrack>) {
        for track in tracks {
            queue.tracks.insert(track.id.clone(), track);
        }
    }

    fn resolve_collection(app: &AppHandle, id: &str) -> Result<ResolvedCollection, String> {
        let catalog = app.state::<Catalog>();
        let state = app.state::<Store>().snapshot();
        let (name, ids) = match id {
            "all" => {
                let mut rows = catalog.tracks()?;
                rows.sort_by_key(|row| row.title.to_lowercase());
                (
                    "All songs".to_string(),
                    rows.into_iter().map(|row| row.id).collect(),
                )
            }
            "liked" => ("Liked Songs".to_string(), state.likes.clone()),
            _ => {
                if let Some((kind, key)) = id.split_once(':') {
                    resolve_metadata_collection(&catalog, kind, key)?
                } else {
                    let playlist = catalog
                        .playlists()?
                        .into_iter()
                        .find(|playlist| playlist.id == id)
                        .ok_or_else(|| {
                            format!("the native player cannot resolve collection {id}")
                        })?;
                    (playlist.name, playlist.track_ids)
                }
            }
        };
        let tracks = resolve_tracks_with(&catalog, &state, &ids)?;
        Ok(ResolvedCollection {
            id: id.to_string(),
            name,
            tracks,
        })
    }

    fn resolve_metadata_collection(
        catalog: &Catalog,
        kind: &str,
        key: &str,
    ) -> Result<(String, Vec<String>), String> {
        let key = key.trim();
        let mut rows: Vec<TrackRow> = catalog
            .tracks()?
            .into_iter()
            .filter(|row| match kind {
                "album" => matches_metadata(row.album.as_deref(), key),
                "genre" => matches_metadata(row.genre.as_deref(), key),
                "artist" => row
                    .artist
                    .as_deref()
                    .is_some_and(|artist| matches_artist(artist, key)),
                _ => false,
            })
            .collect();
        if rows.is_empty() {
            return Err(format!(
                "the native player cannot resolve collection {kind}:{key}"
            ));
        }
        if kind == "album" {
            rows.sort_by_key(|row| {
                (
                    row.disc_no.unwrap_or(0),
                    row.track_no.unwrap_or(0),
                    row.title.to_lowercase(),
                )
            });
        } else {
            rows.sort_by_key(|row| row.title.to_lowercase());
        }
        let name = match kind {
            "album" => rows[0]
                .album
                .clone()
                .unwrap_or_else(|| "Unknown album".to_string()),
            "genre" => rows[0]
                .genre
                .clone()
                .unwrap_or_else(|| "Unknown genre".to_string()),
            "artist" => rows[0]
                .artist
                .clone()
                .unwrap_or_else(|| "Unknown artist".to_string()),
            _ => {
                return Err(format!(
                    "the native player cannot resolve collection {kind}:{key}"
                ));
            }
        };
        Ok((name, rows.into_iter().map(|row| row.id).collect()))
    }

    fn matches_metadata(value: Option<&str>, key: &str) -> bool {
        let value = value.unwrap_or("").trim();
        if key.is_empty() {
            value.is_empty()
        } else {
            value.eq_ignore_ascii_case(key)
        }
    }

    fn matches_artist(artist: &str, key: &str) -> bool {
        if key.is_empty() {
            return artist.trim().is_empty();
        }
        artist
            .split(['&', ';', ','])
            .flat_map(|part| part.split(" feat.").chain(part.split(" feat ")))
            .any(|part| part.trim().eq_ignore_ascii_case(key))
            || artist.trim().eq_ignore_ascii_case(key)
    }

    fn resolve_tracks(app: &AppHandle, ids: &[String]) -> Result<Vec<NativeTrack>, String> {
        let catalog = app.state::<Catalog>();
        let state = app.state::<Store>().snapshot();
        resolve_tracks_with(&catalog, &state, ids)
    }

    fn resolve_tracks_with(
        catalog: &Catalog,
        state: &crate::state::PersistedState,
        ids: &[String],
    ) -> Result<Vec<NativeTrack>, String> {
        let rows = catalog.tracks_by_ids(ids)?;
        Ok(ids
            .iter()
            .filter_map(|id| rows.get(id))
            .filter(|row| !row.missing)
            .map(|row| native_track(catalog, state, row))
            .collect())
    }

    fn native_track(
        catalog: &Catalog,
        state: &crate::state::PersistedState,
        row: &TrackRow,
    ) -> NativeTrack {
        let gain = if state.settings.normalize_volume {
            loudness_gain(row)
        } else {
            1.0
        };
        NativeTrack {
            id: row.id.clone(),
            path: catalog
                .root()
                .join(&row.rel_path)
                .to_string_lossy()
                .into_owned(),
            title: row.title.clone(),
            artist: row.artist.clone().unwrap_or_default(),
            album: row.album.clone().unwrap_or_default(),
            album_artist: row.album_artist.clone().unwrap_or_default(),
            genre: row.genre.clone().unwrap_or_default(),
            year: row.year,
            duration_ms: row.duration_ms,
            codec: row.codec.clone(),
            media_type: String::new(),
            artwork: row
                .cover_path
                .as_ref()
                .map(|path| catalog.root().join(path).to_string_lossy().into_owned())
                .unwrap_or_default(),
            colour: state
                .artwork_colours
                .get(&row.id)
                .cloned()
                .unwrap_or_default(),
            gain,
        }
    }

    fn loudness_gain(row: &TrackRow) -> f64 {
        let Some(lufs) = row.lufs else {
            return 1.0;
        };
        let wanted = 10_f64.powf((-14.0 - f64::from(lufs)) / 20.0);
        let peak = row.peak.map(f64::from).unwrap_or(1.0).max(0.001);
        wanted.min(1.0 / (MAX_GAIN * peak))
    }

    enum BusAction {
        Ended,
        Failed(String),
    }

    struct Slot {
        element: gst::Element,
        bus: gst::Bus,
    }

    struct Engine {
        current: Option<Slot>,
        generation: u64,
        fade_epoch: u64,
    }

    impl Engine {
        fn new() -> Result<Self, String> {
            gst::init().map_err(|error| format!("GStreamer could not start: {error}"))?;
            if gst::ElementFactory::find("playbin").is_none() {
                return Err("the GStreamer playbin plug-in is unavailable".to_string());
            }
            Ok(Self {
                current: None,
                generation: 0,
                fade_epoch: 0,
            })
        }

        fn supersede_fade(&mut self) {
            self.fade_epoch = self.fade_epoch.wrapping_add(1);
        }

        fn load(
            &mut self,
            track: &NativeTrack,
            position_ms: u64,
            playing: bool,
            target: f64,
            crossfade: bool,
            previous_level: f64,
        ) -> Result<Option<Fade>, String> {
            let next = Slot::new(track, position_ms, playing, 0.0)?;
            let old = self.current.replace(next);
            self.generation = self.generation.wrapping_add(1);
            let Some(old) = old else {
                return Ok((playing && target > 0.0).then(|| {
                    Fade::single(
                        self.current.as_ref().expect("loaded").element.clone(),
                        0.0,
                        target,
                        FadeEnd::None,
                    )
                }));
            };
            if !crossfade {
                old.element.set_state(gst::State::Null).map_err(|error| {
                    format!("GStreamer could not release the previous track: {error}")
                })?;
                return Ok((playing && target > 0.0).then(|| {
                    Fade::single(
                        self.current.as_ref().expect("loaded").element.clone(),
                        0.0,
                        target,
                        FadeEnd::None,
                    )
                }));
            }
            Ok(Some(Fade::pair(
                old.element,
                previous_level,
                0.0,
                self.current.as_ref().expect("loaded").element.clone(),
                0.0,
                target,
                FadeEnd::NullOld,
            )))
        }

        fn play(&mut self, target: f64) -> Result<Option<Fade>, String> {
            let current = self
                .current
                .as_ref()
                .ok_or_else(|| "the native queue is empty".to_string())?;
            current
                .element
                .set_state(gst::State::Playing)
                .map_err(|error| format!("GStreamer could not resume playback: {error}"))?;
            Ok(Some(Fade::single(
                current.element.clone(),
                0.0,
                target,
                FadeEnd::None,
            )))
        }

        fn pause(&mut self) -> Result<Option<Fade>, String> {
            let current = self
                .current
                .as_ref()
                .ok_or_else(|| "the native queue is empty".to_string())?;
            let position = current
                .element
                .query_position::<gst::ClockTime>()
                .map(|time| time.mseconds())
                .unwrap_or(0);
            let level = current.element.property::<f64>("volume");
            Ok(Some(Fade::single(
                current.element.clone(),
                level,
                0.0,
                FadeEnd::Pause(position),
            )))
        }

        fn stop(&mut self) -> Result<Option<Fade>, String> {
            let current = self
                .current
                .as_ref()
                .ok_or_else(|| "the native queue is empty".to_string())?;
            let level = current.element.property::<f64>("volume");
            Ok(Some(Fade::single(
                current.element.clone(),
                level,
                0.0,
                FadeEnd::Stop,
            )))
        }

        fn seek(&mut self, position_ms: u64, paused: bool) -> Result<(), String> {
            if paused {
                self.supersede_fade();
            }
            let current = self
                .current
                .as_ref()
                .ok_or_else(|| "the native queue is empty".to_string())?;
            if paused {
                current.element.set_property("volume", 0.0_f64);
                current
                    .element
                    .set_state(gst::State::Paused)
                    .map_err(|error| format!("GStreamer could not pause playback: {error}"))?;
            }
            current
                .element
                .seek_simple(
                    gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                    gst::ClockTime::from_mseconds(position_ms),
                )
                .map_err(|error| format!("GStreamer could not seek: {error}"))
        }

        fn volume(&self, target: f64) -> Result<Option<Fade>, String> {
            let current = self
                .current
                .as_ref()
                .ok_or_else(|| "the native queue is empty".to_string())?;
            current.element.set_property("volume", target);
            Ok(None)
        }

        fn bus(&self) -> Option<(u64, gst::Bus)> {
            self.current
                .as_ref()
                .map(|current| (self.generation, current.bus.clone()))
        }

        fn poll(bus: &gst::Bus, timeout: Duration) -> Option<BusAction> {
            let message = bus.timed_pop_filtered(
                gst::ClockTime::from_mseconds(timeout.as_millis() as u64),
                &[gst::MessageType::Eos, gst::MessageType::Error],
            )?;
            match message.view() {
                gst::MessageView::Eos(..) => Some(BusAction::Ended),
                gst::MessageView::Error(error) => Some(BusAction::Failed(format!(
                    "GStreamer playback failed: {}",
                    error.error()
                ))),
                _ => None,
            }
        }

        fn sample(&self, queue: &mut Queue) {
            if queue.report.current_id.is_none() {
                return;
            }
            let Some(current) = self.current.as_ref() else {
                return;
            };
            if queue.report.playing {
                if let Some(position) = current.element.query_position::<gst::ClockTime>() {
                    queue.report.position_ms = position.mseconds() as f64;
                }
            }
            if let Some(duration) = current.element.query_duration::<gst::ClockTime>() {
                queue.report.duration_ms = duration.mseconds() as f64;
            }
            queue.clamp_position();
        }

        fn shutdown(self) {
            if let Some(current) = self.current {
                let _ = current.element.set_state(gst::State::Null);
            }
        }
    }

    impl Slot {
        fn new(
            track: &NativeTrack,
            position_ms: u64,
            playing: bool,
            volume: f64,
        ) -> Result<Self, String> {
            let element = gst::ElementFactory::make("playbin")
                .build()
                .map_err(|error| format!("the GStreamer playbin could not be created: {error}"))?;
            Self::prepare(element, track, position_ms, playing, volume)
        }

        fn prepare(
            element: gst::Element,
            track: &NativeTrack,
            position_ms: u64,
            playing: bool,
            volume: f64,
        ) -> Result<Self, String> {
            element.set_property("uri", file_uri(&track.path)?);
            element.set_property("volume", volume);
            element
                .set_state(gst::State::Paused)
                .map_err(|error| format!("GStreamer could not prepare {}: {error}", track.title))?;
            let (prepared, current, pending) = element.state(gst::ClockTime::from_mseconds(
                PREROLL_WAIT.as_millis() as u64,
            ));
            if let Err(error) = prepared {
                let _ = element.set_state(gst::State::Null);
                return Err(format!(
                    "GStreamer could not preroll {}: {error}",
                    track.title
                ));
            }
            if current != gst::State::Paused {
                let _ = element.set_state(gst::State::Null);
                return Err(format!(
                    "GStreamer did not preroll {} within {} ms (state: {current:?}, pending: {pending:?})",
                    track.title,
                    PREROLL_WAIT.as_millis(),
                ));
            }
            if position_ms > 0 {
                if let Err(error) = element.seek_simple(
                    gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                    gst::ClockTime::from_mseconds(position_ms),
                ) {
                    let _ = element.set_state(gst::State::Null);
                    return Err(format!("GStreamer could not seek {}: {error}", track.title));
                }
            }
            element
                .set_state(if playing {
                    gst::State::Playing
                } else {
                    gst::State::Paused
                })
                .map_err(|error| format!("GStreamer could not start {}: {error}", track.title))?;
            let bus = element
                .bus()
                .ok_or_else(|| "the GStreamer player has no message bus".to_string())?;
            Ok(Self { element, bus })
        }
    }

    fn file_uri(path: &str) -> Result<String, String> {
        let path = Path::new(path);
        if !path.is_absolute() {
            return Err("native playback needs an absolute audio path".to_string());
        }
        let path = path
            .to_str()
            .ok_or_else(|| "the audio path is not valid UTF-8".to_string())?;
        Ok(format!("file://{}", utf8_percent_encode(path, PATH_ESCAPE)))
    }

    enum FadeEnd {
        None,
        NullOld,
        Pause(u64),
        Stop,
    }

    struct Fade {
        retired: Option<(gst::Element, f64, f64)>,
        current: Option<(gst::Element, f64, f64)>,
        end: FadeEnd,
        epoch: u64,
    }

    impl Fade {
        fn single(element: gst::Element, from: f64, to: f64, end: FadeEnd) -> Self {
            Self {
                retired: None,
                current: Some((element, from, to)),
                end,
                epoch: 0,
            }
        }

        fn pair(
            first: gst::Element,
            first_from: f64,
            first_to: f64,
            second: gst::Element,
            second_from: f64,
            second_to: f64,
            end: FadeEnd,
        ) -> Self {
            Self {
                retired: Some((first, first_from, first_to)),
                current: Some((second, second_from, second_to)),
                end,
                epoch: 0,
            }
        }
    }

    fn spawn_fade(inner: Arc<Mutex<Inner>>, fade: Fade) -> JoinHandle<()> {
        thread::spawn(move || {
            for step in 1..=FADE_STEPS {
                let inner = inner.lock().unwrap_or_else(|error| error.into_inner());
                if !fade_is_current(&inner, &fade) {
                    if let Some((element, _, _)) = fade.retired {
                        let _ = element.set_state(gst::State::Null);
                    }
                    return;
                }
                let progress = smoothstep(step as f64 / FADE_STEPS as f64);
                if let Some((element, from, to)) = fade.retired.as_ref() {
                    element.set_property("volume", from + (to - from) * progress);
                }
                if let Some((element, from, to)) = fade.current.as_ref() {
                    let to = match fade.end {
                        FadeEnd::None | FadeEnd::NullOld => inner.queue.level(),
                        FadeEnd::Pause(_) | FadeEnd::Stop => *to,
                    };
                    element.set_property("volume", from + (to - from) * progress);
                }
                drop(inner);
                thread::sleep(FADE / FADE_STEPS as u32);
            }
            let inner = inner.lock().unwrap_or_else(|error| error.into_inner());
            if !fade_is_current(&inner, &fade) {
                if let Some((element, _, _)) = fade.retired {
                    let _ = element.set_state(gst::State::Null);
                }
                return;
            }
            match fade.end {
                FadeEnd::None => {}
                FadeEnd::NullOld => {
                    if let Some((element, _, _)) = fade.retired {
                        let _ = element.set_state(gst::State::Null);
                    }
                }
                FadeEnd::Pause(position) => {
                    if let Some((element, _, _)) = fade.current {
                        let _ = element.seek_simple(
                            gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                            gst::ClockTime::from_mseconds(position),
                        );
                        let _ = element.set_state(gst::State::Paused);
                    }
                }
                FadeEnd::Stop => {
                    if let Some((element, _, _)) = fade.current {
                        let _ = element.seek_simple(
                            gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT,
                            gst::ClockTime::ZERO,
                        );
                        let _ = element.set_state(gst::State::Paused);
                    }
                }
            }
        })
    }

    fn fade_is_current(inner: &Inner, fade: &Fade) -> bool {
        inner.queue.active
            && inner
                .engine
                .as_ref()
                .is_some_and(|engine| engine.fade_epoch == fade.epoch)
    }

    fn smoothstep(value: f64) -> f64 {
        value * value * (3.0 - 2.0 * value)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn native_session_playback_preserves_frontend_browsing_state() {
            let mut session = Session {
                recents: vec!["playlist".into()],
                queue_open: true,
                saved_at: u64::MAX,
                ..Session::default()
            };
            session.playback.order = vec!["stale".into()];
            let report = Report {
                order: Some(vec!["current".into()]),
                source_order: Some(vec!["current".into()]),
                position_ms: 1_234.0,
                muted: true,
                ..Report::default()
            };
            update_session_playback(&mut session, &report);
            assert_eq!(session.playback.order, vec!["current"]);
            assert_eq!(session.playback.position_ms, 1_234);
            assert!(session.playback.muted);
            assert_eq!(session.recents, vec!["playlist"]);
            assert!(session.queue_open);
            assert_eq!(session.saved_at, u64::MAX);
        }

        #[test]
        #[ignore = "requires GStreamer WAV decoding plugins"]
        fn gstreamer_slot_decodes_seeks_and_reaches_end() {
            gst::init().unwrap();
            let path =
                std::env::temp_dir().join(format!("wave-native-{}.wav", crate::identity::new_id()));
            let data_len = 8_000_u32 * 2 * 2;
            let mut wav = Vec::new();
            wav.extend_from_slice(b"RIFF");
            wav.extend_from_slice(&(36 + data_len).to_le_bytes());
            wav.extend_from_slice(b"WAVEfmt ");
            wav.extend_from_slice(&16_u32.to_le_bytes());
            wav.extend_from_slice(&1_u16.to_le_bytes());
            wav.extend_from_slice(&1_u16.to_le_bytes());
            wav.extend_from_slice(&8_000_u32.to_le_bytes());
            wav.extend_from_slice(&16_000_u32.to_le_bytes());
            wav.extend_from_slice(&2_u16.to_le_bytes());
            wav.extend_from_slice(&16_u16.to_le_bytes());
            wav.extend_from_slice(b"data");
            wav.extend_from_slice(&data_len.to_le_bytes());
            wav.resize(44 + data_len as usize, 0);
            std::fs::write(&path, wav).unwrap();

            let track = NativeTrack {
                path: path.to_string_lossy().into_owned(),
                title: "test".to_string(),
                ..NativeTrack::default()
            };
            let element = gst::ElementFactory::make("playbin").build().unwrap();
            let sink = gst::ElementFactory::make("fakesink").build().unwrap();
            sink.set_property("sync", true);
            element.set_property("audio-sink", sink);
            let slot = Slot::prepare(element, &track, 1_000, true, 1.0).unwrap();
            let bus = slot.bus.clone();
            let mut engine = Engine::new().unwrap();
            engine.current = Some(slot);
            engine.supersede_fade();
            let mut fade = engine.pause().unwrap().unwrap();
            fade.epoch = engine.fade_epoch;
            let mut queue = Queue::default();
            queue.active = true;
            let inner = Arc::new(Mutex::new(Inner {
                queue,
                engine: Some(engine),
                checkpoint: Instant::now(),
                listening: Listening::default(),
            }));
            let fade = spawn_fade(inner.clone(), fade);
            thread::sleep(Duration::from_millis(40));
            inner
                .lock()
                .unwrap()
                .engine
                .as_mut()
                .unwrap()
                .seek(500, true)
                .unwrap();
            fade.join().unwrap();
            let element = inner
                .lock()
                .unwrap()
                .engine
                .as_ref()
                .unwrap()
                .current
                .as_ref()
                .unwrap()
                .element
                .clone();
            let (_, state, _) = element.state(gst::ClockTime::from_seconds(2));
            assert_eq!(state, gst::State::Paused);
            let position = element
                .query_position::<gst::ClockTime>()
                .unwrap()
                .mseconds();
            assert!(position.abs_diff(500) < 100, "paused at {position}ms");
            let mut stopped = Queue::default();
            stopped.report.current_id = Some("test".into());
            stopped.report.position_ms = 0.0;
            inner
                .lock()
                .unwrap()
                .engine
                .as_ref()
                .unwrap()
                .sample(&mut stopped);
            assert_eq!(stopped.report.position_ms, 0.0);
            element.set_state(gst::State::Playing).unwrap();
            match Engine::poll(&bus, Duration::from_secs(4)) {
                Some(BusAction::Ended) => {}
                Some(BusAction::Failed(error)) => panic!("{error}"),
                None => panic!("GStreamer did not reach the end of the track"),
            }
            element.set_state(gst::State::Null).unwrap();
            std::fs::remove_file(path).unwrap();
        }

        #[test]
        #[ignore = "requires the GStreamer playbin plugin"]
        fn fade_follows_volume_changes_and_can_be_superseded() {
            gst::init().unwrap();
            let element = gst::ElementFactory::make("playbin").build().unwrap();
            let track = NativeTrack {
                id: "test".into(),
                gain: 1.0,
                ..NativeTrack::default()
            };
            let mut queue = Queue::default();
            queue.tracks.insert(track.id.clone(), track);
            queue.report.current_id = Some("test".into());
            queue.report.playing = true;
            queue.report.volume = 100.0;
            queue.active = true;
            let inner = Arc::new(Mutex::new(Inner {
                queue,
                engine: Some(Engine::new().unwrap()),
                checkpoint: Instant::now(),
                listening: Listening::default(),
            }));
            let fade = spawn_fade(
                inner.clone(),
                Fade::single(element.clone(), 0.0, MAX_GAIN, FadeEnd::None),
            );
            thread::sleep(Duration::from_millis(80));
            inner.lock().unwrap().queue.report.volume = 20.0;
            fade.join().unwrap();
            assert!((element.property::<f64>("volume") - 0.14).abs() < 0.001);

            let stale = Fade::single(element, 0.0, 0.0, FadeEnd::Pause(0));
            let mut inner = inner.lock().unwrap();
            assert!(fade_is_current(&inner, &stale));
            inner.engine.as_mut().unwrap().supersede_fade();
            assert!(!fade_is_current(&inner, &stale));
        }
    }
}

#[cfg(target_os = "linux")]
pub use runtime::NativePlayback;

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str) -> NativeTrack {
        NativeTrack {
            id: id.to_string(),
            path: format!("/music/{id}.flac"),
            title: id.to_string(),
            duration_ms: 60_000,
            gain: 1.0,
            ..NativeTrack::default()
        }
    }

    fn sync(replace: bool) -> Sync {
        Sync {
            report: Report {
                current_id: Some("one".into()),
                order: Some(vec!["one".into(), "two".into()]),
                source_order: Some(vec!["one".into(), "two".into()]),
                playing: true,
                volume: 70.0,
                ..Report::default()
            },
            tracks: vec![track("one"), track("two")],
            replace,
            ..Sync::default()
        }
    }

    #[test]
    fn reconnect_does_not_replace_an_active_native_queue() {
        let mut queue = Queue::default();
        queue.sync(sync(false)).unwrap();
        queue.command(&Command::new("next")).unwrap();
        let revision = queue.revision;

        queue.sync(sync(false)).unwrap();

        assert_eq!(queue.report.current_id.as_deref(), Some("two"));
        assert_eq!(queue.revision, revision);
    }

    #[test]
    fn an_explicit_queue_replacement_can_replace_native_state() {
        let mut queue = Queue::default();
        queue.sync(sync(false)).unwrap();
        let mut update = sync(true);
        update.report.current_id = Some("two".into());
        update.report.cursor = 1;

        let effect = queue.sync(update).unwrap();

        assert!(matches!(effect, Effect::Load { .. }));
        assert_eq!(queue.report.current_id.as_deref(), Some("two"));
    }

    #[test]
    fn queue_only_sync_keeps_the_active_audio_slot() {
        let mut queue = Queue::default();
        queue.sync(sync(false)).unwrap();
        queue.report.position_ms = 12_345.0;
        queue.report.duration_ms = 60_000.0;
        let mut update = sync(true);
        update.report.order = Some(vec!["two".into(), "one".into()]);
        update.report.source_order = Some(vec!["one".into(), "two".into()]);
        update.report.cursor = 1;
        update.report.position_ms = 0.0;

        let effect = queue.sync(update).unwrap();

        assert!(matches!(effect, Effect::None));
        assert_eq!(queue.report.current_id.as_deref(), Some("one"));
        assert_eq!(queue.report.position_ms, 12_345.0);
        assert_eq!(queue.report.order, Some(vec!["two".into(), "one".into()]));
    }

    #[test]
    fn status_transitions_identify_native_queue_changes() {
        let mut queue = Queue::default();
        queue.sync(sync(false)).unwrap();

        let transition = queue.status().transition.unwrap();
        assert_eq!(transition.kind, "sync");
        assert_eq!(transition.current_track_id.as_deref(), Some("one"));

        queue.command(&Command::new("next")).unwrap();

        let transition = queue.status().transition.unwrap();
        assert_eq!(transition.kind, "next");
        assert_eq!(transition.previous_track_id.as_deref(), Some("one"));
        assert_eq!(transition.current_track_id.as_deref(), Some("two"));
    }

    #[test]
    fn equaliser_and_output_routing_keep_the_webkit_fallback() {
        let mut queue = Queue::default();
        let mut eq = sync(false);
        eq.equaliser_enabled = true;
        queue.sync(eq).unwrap();
        assert!(!queue.active);
        assert!(queue.reason.as_deref().unwrap().contains("equaliser"));

        let mut output = sync(false);
        output.output_id = "headphones".into();
        queue.sync(output).unwrap();
        assert!(!queue.active);
        assert!(queue.reason.as_deref().unwrap().contains("output"));
    }

    #[test]
    fn queue_transitions_and_repeat_remain_native() {
        let mut queue = Queue::default();
        queue.sync(sync(false)).unwrap();
        queue.command(&Command::new("previous")).unwrap();
        assert_eq!(queue.report.current_id.as_deref(), Some("one"));
        queue.command(&Command::new("next")).unwrap();
        assert_eq!(queue.report.current_id.as_deref(), Some("two"));
        queue.command(&Command::new("next")).unwrap();
        assert_eq!(queue.report.current_id.as_deref(), Some("two"));
        queue.command(&Command::new("repeat").text("all")).unwrap();
        queue.command(&Command::new("next")).unwrap();
        assert_eq!(queue.report.current_id.as_deref(), Some("one"));
    }

    #[test]
    fn play_and_toggle_restart_a_finished_track() {
        for action in ["play", "toggle"] {
            let mut queue = Queue::default();
            queue.sync(sync(false)).unwrap();
            queue.report.playing = false;
            queue.report.position_ms = queue.report.duration_ms;

            let effect = queue.command(&Command::new(action)).unwrap();

            assert!(matches!(effect, Effect::PlayAt(0)));
            assert!(queue.report.playing);
            assert_eq!(queue.report.position_ms, 0.0);
        }
    }

    #[test]
    fn shuffle_rebuilds_the_order_and_keeps_the_current_track() {
        let mut queue = Queue::default();
        queue.sync(sync(false)).unwrap();

        queue.command(&Command::new("shuffle").flag(true)).unwrap();

        assert!(queue.report.shuffle);
        assert_eq!(queue.report.current_id.as_deref(), Some("one"));
        assert_eq!(queue.report.cursor, 0);
        assert_eq!(queue.report.order.as_ref().unwrap().len(), 2);

        queue.command(&Command::new("shuffle").flag(false)).unwrap();

        assert!(!queue.report.shuffle);
        assert_eq!(queue.report.order.as_ref().unwrap(), &["one", "two"]);
        assert_eq!(queue.report.cursor, 0);
    }

    #[test]
    fn repeat_all_reloads_a_single_track_after_eos() {
        let mut queue = Queue::default();
        let mut update = sync(false);
        update.report.order = Some(vec!["one".into()]);
        update.report.source_order = Some(vec!["one".into()]);
        update.tracks = vec![track("one")];
        queue.sync(update).unwrap();
        queue.command(&Command::new("repeat").text("all")).unwrap();

        let effect = queue.command(&Command::new("next")).unwrap();

        assert!(matches!(effect, Effect::Load { playing: true, .. }));
        assert_eq!(queue.report.current_id.as_deref(), Some("one"));
        assert_eq!(queue.report.position_ms, 0.0);
    }

    #[test]
    fn native_queue_commands_preserve_the_current_entry() {
        let mut queue = Queue::default();
        queue.sync(sync(false)).unwrap();
        queue.tracks.insert("three".into(), track("three"));
        queue
            .command(&Command::new("queueNext").track("three"))
            .unwrap();
        assert_eq!(
            queue.report.order.as_ref().unwrap(),
            &["one", "three", "two"]
        );
        queue
            .command(&Command::new("queueRemove").track("one"))
            .unwrap();
        assert_eq!(queue.report.current_id.as_deref(), Some("three"));
        assert_eq!(queue.report.cursor, 0);
    }

    #[test]
    fn normalised_volume_matches_the_web_audio_ceiling() {
        let mut queue = Queue::default();
        let mut update = sync(false);
        update.report.volume = 100.0;
        update.tracks[0].gain = 4.0;
        queue.sync(update).unwrap();

        assert_eq!(queue.level(), 1.0);
        assert_eq!(level_for(&queue.report, queue.track()), 1.0);
    }
}
