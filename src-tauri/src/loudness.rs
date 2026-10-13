use std::collections::HashMap;
use std::fs;
use std::path::Path;

use ebur128::{EbuR128, Mode};
use serde::{Deserialize, Serialize};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{CODEC_TYPE_NULL, DecoderOptions};
use symphonia::core::errors::Error as DecodeError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::library::{self, TrackPaths, CONFIG_DIR};

/// Follows one loudness pass, one song at a time.
pub const PROGRESS_EVENT: &str = "loudness-scan";

const LOUDNESS_FILE: &str = "loudness.json";

/// How many readings are collected before the index is written out.
const FLUSH_EVERY: usize = 25;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    pub lufs: f32,
    pub peak: f32,
    pub bytes: u64,
}

/// Readings by library-relative song path, so they survive the library moving.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct LoudnessIndex {
    #[serde(default)]
    pub songs: HashMap<String, Measurement>,
}

/// One song's reading, sent as soon as it is taken.
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

/// How a loudness pass went.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessOutcome {
    /// Measured this time.
    pub measured: usize,
    /// Left alone, because the library already had a reading for them.
    pub skipped: usize,
    pub failures: Vec<String>,
}

pub fn read_index(root: &Path) -> LoudnessIndex {
    fs::read_to_string(root.join(CONFIG_DIR).join(LOUDNESS_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Writes via a temp file so a crash mid-write cannot truncate the real one.
pub fn write_index(root: &Path, index: &LoudnessIndex) -> Result<(), String> {
    let json = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    let path = root.join(CONFIG_DIR).join(LOUDNESS_FILE);
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, json).map_err(|e| format!("could not write {}: {e}", temp.display()))?;
    // `rename` does not overwrite on Windows, so clear the target first.
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    fs::rename(&temp, &path).map_err(|e| format!("could not replace {}: {e}", path.display()))
}

pub fn measure(path: &Path) -> Result<Measurement, String> {
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

fn analyse<R: Runtime>(app: &AppHandle<R>, songs: &[(String, String)]) -> LoudnessOutcome {
    let Ok(root) = library::library_root(app) else {
        return LoudnessOutcome::default();
    };

    let mut index = read_index(&root);
    let todo: Vec<&(String, String)> = songs
        .iter()
        .filter(|(_, relative)| needs_measuring(&root, &index, relative))
        .collect();

    let total = todo.len();
    let skipped = songs.len() - total;
    let mut measured = 0usize;
    let mut failures = Vec::new();

    for (position, (id, relative)) in todo.iter().enumerate() {
        match measure(&root.join(relative)) {
            Ok(reading) => {
                index.songs.insert(relative.clone(), reading);
                measured += 1;
                let _ = app.emit(
                    PROGRESS_EVENT,
                    LoudnessUpdate {
                        id: id.clone(),
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

        // Written as it goes, so a long pass is not lost to a crash.
        if (position + 1) % FLUSH_EVERY == 0 {
            let _ = write_index(&root, &index);
        }
    }

    prune(&root, &mut index);
    let _ = write_index(&root, &index);

    LoudnessOutcome {
        measured,
        skipped,
        failures,
    }
}

fn needs_measuring(root: &Path, index: &LoudnessIndex, relative: &str) -> bool {
    let Ok(bytes) = fs::metadata(root.join(relative)).map(|meta| meta.len()) else {
        return false;
    };
    match index.songs.get(relative) {
        Some(known) => known.bytes != bytes,
        None => true,
    }
}

/// Drops readings for files that are no longer in the library.
fn prune(root: &Path, index: &mut LoudnessIndex) {
    index.songs.retain(|relative, _| root.join(relative).is_file());
}

#[tauri::command]
pub async fn analyse_loudness(app: AppHandle, track_ids: Vec<String>) -> LoudnessOutcome {
    // Resolved before the await: a state guard cannot cross one.
    let songs = {
        let paths = app.state::<TrackPaths>();
        paths.ids_to_pairs(&track_ids)
    };

    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || analyse(&handle, &songs))
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
    fn a_song_is_measured_until_its_reading_still_fits() {
        let dir = scratch("stale");
        let songs = dir.join(library::SONGS_DIR);
        fs::create_dir_all(&songs).unwrap();

        let song = songs.join("song.mp3");
        let relative = format!("{}/song.mp3", library::SONGS_DIR);
        fs::write(&song, b"0123456789").unwrap();

        let mut index = LoudnessIndex::default();
        assert!(needs_measuring(&dir, &index, &relative));

        // A reading taken from this exact file stands.
        index.songs.insert(
            relative.clone(),
            Measurement {
                lufs: -9.0,
                peak: 0.9,
                bytes: 10,
            },
        );
        assert!(!needs_measuring(&dir, &index, &relative));

        // A different file under the same name does not.
        fs::write(&song, b"a longer file").unwrap();
        assert!(needs_measuring(&dir, &index, &relative));

        // A file that is gone is left alone rather than reported.
        assert!(!needs_measuring(&dir, &index, "songs/missing.mp3"));
    }

    #[test]
    fn the_index_round_trips() {
        let dir = scratch("index");
        fs::create_dir_all(dir.join(CONFIG_DIR)).unwrap();

        let mut index = LoudnessIndex::default();
        index.songs.insert(
            "songs/one.mp3".to_string(),
            Measurement {
                lufs: -9.5,
                peak: 0.98,
                bytes: 4096,
            },
        );
        write_index(&dir, &index).unwrap();

        let read = read_index(&dir);
        let one = read.songs.get("songs/one.mp3").unwrap();
        assert_eq!(one.bytes, 4096);
        assert!((one.lufs + 9.5).abs() < 0.001);
        assert!((one.peak - 0.98).abs() < 0.001);
        // A library with no readings reads as an empty index, not a failure.
        assert!(read_index(&dir.join("nowhere")).songs.is_empty());
    }
}
