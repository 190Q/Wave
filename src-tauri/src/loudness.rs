use std::collections::HashSet;
use std::fs;
use std::path::Path;
#[cfg(any(target_os = "android", test))]
use std::time::{Duration, Instant};

use ebur128::{EbuR128, Mode};
use serde::Serialize;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{CODEC_TYPE_NULL, DecoderOptions};
use symphonia::core::errors::Error as DecodeError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::{AppHandle, Emitter, Manager};

use crate::catalog::{Catalog, TrackRow};
use crate::library;

pub const PROGRESS_EVENT: &str = "loudness-scan";
#[cfg(target_os = "android")]
const FINISHED_EVENT: &str = "loudness-finished";

#[cfg(any(target_os = "android", test))]
const ANALYSIS_SLICE: Duration = Duration::from_millis(10);
#[cfg(target_os = "android")]
const PLAYBACK_YIELD: Duration = Duration::from_millis(40);

#[cfg(any(target_os = "android", test))]
struct AnalysisThrottle {
    started: Instant,
}

#[cfg(any(target_os = "android", test))]
impl AnalysisThrottle {
    fn new(now: Instant) -> Self {
        Self { started: now }
    }

    fn should_yield(&mut self, now: Instant, playing: impl FnOnce() -> bool) -> bool {
        if now.saturating_duration_since(self.started) < ANALYSIS_SLICE {
            return false;
        }
        self.started = now;
        playing()
    }

    fn reset(&mut self, now: Instant) {
        self.started = now;
    }
}

#[cfg(any(target_os = "android", test))]
#[derive(Default)]
struct AnalysisQueue {
    running: bool,
    again: bool,
}

#[cfg(any(target_os = "android", test))]
impl AnalysisQueue {
    fn request(&mut self) -> bool {
        if self.running {
            self.again = true;
            false
        } else {
            self.running = true;
            true
        }
    }

    fn advance(&mut self) -> bool {
        if self.again {
            self.again = false;
            true
        } else {
            self.running = false;
            false
        }
    }
}

#[cfg(target_os = "android")]
static ANALYSIS_QUEUE: std::sync::Mutex<AnalysisQueue> =
    std::sync::Mutex::new(AnalysisQueue { running: false, again: false });

#[cfg(target_os = "android")]
pub(crate) fn schedule(app: &AppHandle, guard: crate::library_work::Guard) {
    let mut queue = ANALYSIS_QUEUE.lock().unwrap_or_else(|error| error.into_inner());
    if !queue.request() {
        return;
    }
    drop(queue);

    guard.label("Analysing song loudness");
    let handle = app.clone();
    let spawned = std::thread::Builder::new()
        .name("loudness-analysis".into())
        .spawn(move || {
            let _guard = guard;
            loop {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    analyse(&handle, &[])
                }));
                let mut queue = ANALYSIS_QUEUE.lock().unwrap_or_else(|error| error.into_inner());
                if result.is_err() {
                    eprintln!("loudness analysis stopped unexpectedly");
                    queue.again = false;
                }
                if !queue.advance() {
                    let _ = handle.emit(FINISHED_EVENT, ());
                    break;
                }
            }
        });
    if let Err(error) = spawned {
        let mut queue = ANALYSIS_QUEUE.lock().unwrap_or_else(|error| error.into_inner());
        *queue = AnalysisQueue::default();
        let _ = app.emit(FINISHED_EVENT, ());
        eprintln!("loudness analysis could not start: {error}");
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessUpdate {
    pub id: String,
    pub lufs: f32,
    pub peak: f32,
    /// Songs handled so far, including this one.
    pub done: usize,
    /// How many songs needed a reading when the pass started.
    pub total: usize,
    /// Songs the library already had a reading for.
    pub skipped: usize,
    pub failures: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessOutcome {
    pub measured: usize,
    pub skipped: usize,
    pub failures: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct Measurement {
    pub lufs: f32,
    pub peak: f32,
    pub bytes: u64,
}

pub fn measure(path: &Path) -> Result<Measurement, String> {
    measure_with(path, || {})
}

fn measure_with(path: &Path, mut checkpoint: impl FnMut()) -> Result<Measurement, String> {
    let bytes = fs::metadata(path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?
        .len();

    let file =
        fs::File::open(path).map_err(|e| format!("could not open {}: {e}", path.display()))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());

    // The extension is only a hint; the probe reads the file to be sure.
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| format!("{} has no audio track", path.display()))?;
    let track_id = track.id;
    let params = track.codec_params.clone();

    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .map_err(|e| format!("could not decode {}: {e}", path.display()))?;

    let mut meter: Option<EbuR128> = None;
    let mut buffer: Option<SampleBuffer<f32>> = None;
    let mut frames = 0u64;

    loop {
        checkpoint();
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            // The stream ran out, or a packet is damaged. Either way, what has
            // been read so far still stands.
            Err(_) => break,
        };
        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            // One bad packet is not a reason to give up on the file.
            Err(DecodeError::DecodeError(_)) => continue,
            Err(_) => break,
        };

        let spec = *decoded.spec();
        if meter.is_none() {
            meter = Some(
                EbuR128::new(
                    spec.channels.count() as u32,
                    spec.rate,
                    Mode::I | Mode::TRUE_PEAK,
                )
                .map_err(|e| format!("could not measure {}: {e}", path.display()))?,
            );
        }
        let Some(meter) = meter.as_mut() else {
            break;
        };
        // A stream that changes shape part way through: keep what was measured.
        if meter.rate() != spec.rate || meter.channels() != spec.channels.count() as u32 {
            break;
        }

        if buffer.is_none() {
            buffer = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        }
        let Some(samples) = buffer.as_mut() else {
            break;
        };
        samples.copy_interleaved_ref(decoded);

        let interleaved = samples.samples();
        if meter.add_frames_f32(interleaved).is_err() {
            break;
        }
        frames += (interleaved.len() / spec.channels.count()) as u64;
    }

    let Some(meter) = meter else {
        return Err(format!("{} has nothing to decode", path.display()));
    };
    if frames == 0 {
        return Err(format!("{} has nothing to decode", path.display()));
    }

    let lufs = meter
        .loudness_global()
        .map_err(|e| format!("could not measure {}: {e}", path.display()))?;
    // Silence measures as negative infinity, which is not a gain to play at.
    if !lufs.is_finite() {
        return Err(format!("{} is silent", path.display()));
    }

    let peak = (0..meter.channels())
        .filter_map(|channel| meter.true_peak(channel).ok())
        .fold(0.0f64, f64::max);

    Ok(Measurement {
        lufs: lufs as f32,
        peak: peak as f32,
        bytes,
    })
}

/// Songs whose file is not the one the library measured last time.
fn pending<'a>(rows: &[&'a TrackRow]) -> Vec<&'a TrackRow> {
    rows.iter()
        .copied()
        .filter(|row| row.loudness_bytes != Some(row.bytes))
        .collect()
}

pub(crate) fn analyse(app: &AppHandle, track_ids: &[String]) -> LoudnessOutcome {
    let Ok(root) = library::library_root(app) else {
        return LoudnessOutcome::default();
    };
    let catalog = app.state::<Catalog>();

    let Ok(rows) = catalog.tracks() else {
        return LoudnessOutcome::default();
    };

    let wanted: Vec<&TrackRow> = if track_ids.is_empty() {
        rows.iter().collect()
    } else {
        let asked: HashSet<&str> = track_ids.iter().map(String::as_str).collect();
        rows.iter().filter(|row| asked.contains(row.id.as_str())).collect()
    };

    let todo = pending(&wanted);
    let total = todo.len();
    let skipped = wanted.len() - total;
    let mut measured = 0usize;
    let mut failures = Vec::new();

    #[cfg(target_os = "android")]
    let bridge = app.try_state::<crate::api::player::Bridge>();
    #[cfg(target_os = "android")]
    let mut throttle = AnalysisThrottle::new(Instant::now());

    for (position, row) in todo.iter().enumerate() {
        #[cfg(target_os = "android")]
        let reading = measure_with(&root.join(&row.rel_path), || {
            if throttle.should_yield(Instant::now(), || {
                bridge.as_ref().is_some_and(|bridge| bridge.is_playing())
            }) {
                std::thread::sleep(PLAYBACK_YIELD);
                throttle.reset(Instant::now());
            }
        });
        #[cfg(not(target_os = "android"))]
        let reading = measure(&root.join(&row.rel_path));

        match reading {
            Ok(reading) => {
                if catalog
                    .set_loudness(&row.id, reading.lufs, reading.peak, reading.bytes)
                    .is_err()
                {
                    failures.push(format!("{} could not be saved", row.title));
                    continue;
                }
                measured += 1;
                let _ = app.emit(
                    PROGRESS_EVENT,
                    LoudnessUpdate {
                        id: row.id.clone(),
                        lufs: reading.lufs,
                        peak: reading.peak,
                        done: position + 1,
                        total,
                        skipped,
                        failures: failures.clone(),
                    },
                );
            }
            Err(error) => failures.push(error),
        }
    }

    LoudnessOutcome {
        measured,
        skipped,
        failures,
    }
}

#[tauri::command]
pub async fn analyse_loudness(app: AppHandle, track_ids: Vec<String>) -> LoudnessOutcome {
    // The catalog is reached through the handle inside the blocking closure: a
    // state guard cannot cross an await.
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "android")]
        let _guard = crate::library_work::Guard::start(&handle, "Analysing song loudness");
        analyse(&handle, &track_ids)
    })
    .await
    .unwrap_or_else(|error| LoudnessOutcome {
        measured: 0,
        skipped: 0,
        failures: vec![format!("the analysis stopped unexpectedly: {error}")],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn overlapping_analysis_requests_are_coalesced_and_retried() {
        let mut queue = AnalysisQueue::default();
        assert!(queue.request());
        assert!(!queue.request());
        assert!(!queue.request());
        assert!(queue.advance());
        assert!(!queue.advance());
        assert!(queue.request());
        assert!(!queue.advance());
    }

    #[test]
    fn analysis_only_yields_after_a_work_slice_while_playing() {
        let start = Instant::now();
        let mut throttle = AnalysisThrottle::new(start);
        assert!(!throttle.should_yield(start + Duration::from_millis(9), || panic!("too early")));
        assert!(throttle.should_yield(start + Duration::from_millis(10), || true));
        throttle.reset(start + Duration::from_millis(50));
        assert!(!throttle.should_yield(start + Duration::from_millis(59), || panic!("too early")));
        assert!(!throttle.should_yield(start + Duration::from_millis(60), || false));
        assert!(!throttle.should_yield(start + Duration::from_millis(69), || panic!("too early")));
        assert!(throttle.should_yield(start + Duration::from_millis(70), || true));
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wave-loudness-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A stereo 16-bit WAV holding a sine at `amplitude` for `seconds`.
    fn write_sine(path: &Path, amplitude: f32, seconds: f32) {
        const RATE: u32 = 44_100;
        const CHANNELS: u16 = 2;
        // An exact eighth of the rate, so the samples land on the sine's peaks.
        const HZ: f32 = RATE as f32 / 8.0;

        let frames = (RATE as f32 * seconds) as usize;
        let mut data = Vec::with_capacity(frames * 4);
        for frame in 0..frames {
            let angle = std::f32::consts::TAU * HZ * frame as f32 / RATE as f32;
            let value = (amplitude * angle.sin() * f32::from(i16::MAX)) as i16;
            for _ in 0..CHANNELS {
                data.extend_from_slice(&value.to_le_bytes());
            }
        }

        let mut file = Vec::new();
        file.extend_from_slice(b"RIFF");
        file.extend_from_slice(&((36 + data.len()) as u32).to_le_bytes());
        file.extend_from_slice(b"WAVE");
        file.extend_from_slice(b"fmt ");
        file.extend_from_slice(&16u32.to_le_bytes());
        file.extend_from_slice(&1u16.to_le_bytes());
        file.extend_from_slice(&CHANNELS.to_le_bytes());
        file.extend_from_slice(&RATE.to_le_bytes());
        file.extend_from_slice(&(RATE * u32::from(CHANNELS) * 2).to_le_bytes());
        file.extend_from_slice(&(CHANNELS * 2).to_le_bytes());
        file.extend_from_slice(&16u16.to_le_bytes());
        file.extend_from_slice(b"data");
        file.extend_from_slice(&(data.len() as u32).to_le_bytes());
        file.extend_from_slice(&data);

        fs::write(path, &file).unwrap();
    }

    fn row(id: &str, bytes: u64, measured: Option<u64>) -> TrackRow {
        TrackRow {
            id: id.to_string(),
            bytes,
            loudness_bytes: measured,
            ..TrackRow::default()
        }
    }

    #[test]
    fn a_quieter_file_measures_the_expected_number_of_lu_lower() {
        let dir = scratch("level");
        let loud = dir.join("loud.wav");
        let quiet = dir.join("quiet.wav");
        write_sine(&loud, 0.5, 3.0);
        write_sine(&quiet, 0.25, 3.0);

        let loud = measure(&loud).unwrap();
        let quiet = measure(&quiet).unwrap();

        let difference = loud.lufs - quiet.lufs;
        assert!(
            (difference - 6.02).abs() < 0.2,
            "expected about 6 LU between the two, got {difference}"
        );
    }

    #[test]
    fn reports_the_true_peak_it_saw() {
        let dir = scratch("peak");
        let song = dir.join("song.wav");
        write_sine(&song, 0.5, 1.0);

        let reading = measure(&song).unwrap();
        assert!(
            (0.45..0.6).contains(&reading.peak),
            "expected a peak near 0.5, got {}",
            reading.peak
        );
        assert_eq!(reading.bytes, fs::metadata(&song).unwrap().len());
    }

    #[test]
    fn analysis_checks_for_playback_between_packets_without_changing_the_result() {
        let dir = scratch("checkpoints");
        let song = dir.join("song.wav");
        write_sine(&song, 0.5, 1.0);

        let baseline = measure(&song).unwrap();
        let mut checkpoints = 0;
        let reading = measure_with(&song, || checkpoints += 1).unwrap();
        assert!(checkpoints > 1);
        assert_eq!(reading.bytes, baseline.bytes);
        assert_eq!(reading.lufs, baseline.lufs);
        assert_eq!(reading.peak, baseline.peak);
    }

    #[test]
    fn silence_is_not_a_reading() {
        let dir = scratch("silence");
        let silent = dir.join("silent.wav");
        write_sine(&silent, 0.0, 1.0);

        assert!(measure(&silent).is_err());
    }

    #[test]
    fn a_file_that_is_not_audio_is_an_error_rather_than_a_panic() {
        let dir = scratch("garbage");
        let broken = dir.join("broken.mp3");
        fs::write(&broken, b"not an mp3 at all").unwrap();

        assert!(measure(&broken).is_err());
    }

    #[test]
    fn only_songs_whose_file_has_changed_are_measured_again() {
        let unmeasured = row("one", 100, None);
        let measured = row("two", 100, Some(100));
        let replaced = row("three", 200, Some(100));

        let rows = vec![&unmeasured, &measured, &replaced];
        let todo = pending(&rows);

        assert_eq!(
            todo.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["one", "three"]
        );
    }
}
