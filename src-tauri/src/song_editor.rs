use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use lofty::config::WriteOptions;
use lofty::file::AudioFile;
use lofty::prelude::{Accessor, ItemKey, TagExt, TaggedFileExt};
use lofty::tag::{items::Timestamp, Tag};
use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::catalog::{Catalog, TrackRow};
use crate::{identity, library, source, tools};

const STAGE_PREFIX: &str = ".song-editor-";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cut {
    start_ms: u64,
    end_ms: u64,
}

#[tauri::command(async)]
pub fn stage_editor_audio(app: AppHandle, path: String) -> Result<String, String> {
    let source = Path::new(&path);
    if !library::has_extension(source, library::AUDIO_EXTENSIONS) {
        return Err("Choose a supported audio file.".to_string());
    }
    lofty::read_from_path(source).map_err(|e| format!("Could not read the selected audio: {e}"))?;
    let extension = source.extension().and_then(|value| value.to_str())
        .ok_or_else(|| "The audio file has no extension.".to_string())?.to_lowercase();
    let target = library::library_root(&app)?.join(library::CONFIG_DIR)
        .join(format!("{STAGE_PREFIX}{}.{extension}", identity::new_id()));
    fs::copy(source, &target).map_err(|e| format!("Could not prepare the audio: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

fn stage_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or("");
    let valid = stem.strip_prefix(STAGE_PREFIX).is_some_and(identity::is_id)
        && path.parent() == Some(root.join(library::CONFIG_DIR).as_path())
        && library::has_extension(&path, library::AUDIO_EXTENSIONS);
    if !valid {
        return Err("The staged audio is no longer available.".to_string());
    }
    Ok(path)
}

#[tauri::command]
pub fn discard_editor_audio(app: AppHandle, path: String) -> Result<(), String> {
    let path = stage_path(&library::library_root(&app)?, &path)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("Could not remove the temporary audio: {e}"))?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn editor_waveform(
    app: AppHandle,
    catalog: State<'_, Catalog>,
    track_id: String,
    staged_audio: Option<String>,
) -> Result<Vec<f32>, String> {
    let root = library::library_root(&app)?;
    let row = catalog.track(&track_id)?.filter(|row| !row.missing)
        .ok_or_else(|| "That song is no longer in the library.".to_string())?;
    let path = match staged_audio {
        Some(path) => stage_path(&root, &path)?,
        None => root.join(&row.rel_path),
    };
    let env = source::read_env(&app);
    let ffmpeg = tools::tool_path(env.ffmpeg.as_ref(), "ffmpeg", tools::bundled_dir(&app).as_deref())
        .ok_or_else(|| "FFmpeg is needed to display the waveform.".to_string())?;
    waveform(&path, &ffmpeg)
}

fn waveform(path: &Path, ffmpeg: &Path) -> Result<Vec<f32>, String> {
    let mut command = Command::new(ffmpeg);
    command.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args(["-map", "0:a:0", "-vn", "-ac", "2", "-ar", "24000", "-f", "s16le", "pipe:1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    tools::hide_console(&mut command);
    let mut child = command.spawn().map_err(|e| format!("Could not start FFmpeg: {e}"))?;
    let stdout = child.stdout.take().ok_or_else(|| "Could not read the waveform.".to_string())?;
    let mut reader = BufReader::new(stdout);
    let mut samples = [0u8; 4800];
    let mut peaks = Vec::<f32>::new();
    let mut peak = 0.0f32;
    let mut blocks = 0usize;
    let mut stride = 1usize;
    loop {
        let mut length = 0;
        while length < samples.len() {
            match reader.read(&mut samples[length..]) {
                Ok(0) => break,
                Ok(read) => length += read,
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("Could not read the waveform: {error}"));
                }
            }
        }
        if length == 0 {
            break;
        }
        for sample in samples[..length].chunks_exact(2) {
            let value = i16::from_le_bytes([sample[0], sample[1]]).unsigned_abs() as f32 / 32768.0;
            peak = peak.max(value);
        }
        blocks += 1;
        if blocks == stride {
            peaks.push(peak);
            peak = 0.0;
            blocks = 0;
            if peaks.len() == 100_000 {
                peaks = peaks.chunks_exact(2).map(|pair| pair[0].max(pair[1])).collect();
                stride *= 2;
            }
        }
    }
    if blocks > 0 {
        peaks.push(peak);
    }
    let status = child.wait().map_err(|e| format!("Could not finish the waveform: {e}"))?;
    if !status.success() || peaks.is_empty() {
        return Err("This audio could not be decoded for the waveform.".to_string());
    }
    Ok(peaks)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(path: &Path, seconds: u32) {
        let bytes = seconds * 8000 * 2;
        let mut data = Vec::new();
        data.extend_from_slice(b"RIFF");
        data.extend_from_slice(&(36 + bytes).to_le_bytes());
        data.extend_from_slice(b"WAVEfmt ");
        data.extend_from_slice(&16u32.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&8000u32.to_le_bytes());
        data.extend_from_slice(&16000u32.to_le_bytes());
        data.extend_from_slice(&2u16.to_le_bytes());
        data.extend_from_slice(&16u16.to_le_bytes());
        data.extend_from_slice(b"data");
        data.extend_from_slice(&bytes.to_le_bytes());
        data.resize(data.len() + bytes as usize, 0);
        fs::write(path, data).unwrap();
    }

    fn song() -> (PathBuf, Catalog, TrackRow) {
        let root = std::env::temp_dir().join(format!("wave-song-editor-{}", identity::new_id()));
        let id = identity::new_id();
        let dir = library::track_dir(&root, &id);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("audio.wav");
        wav(&path, 10);
        let catalog = Catalog::open(&root).unwrap();
        let row = library::describe(&root, &id, &path, "Singer - Title.wav", None).unwrap();
        catalog.upsert_track(&row).unwrap();
        catalog.set_loudness(&id, -12.0, 0.8, row.bytes).unwrap();
        (root, catalog, row)
    }

    #[test]
    fn saves_lyrics_without_changing_audio_or_loudness() {
        let (root, catalog, row) = song();
        let path = root.join(&row.rel_path);
        let saved = save_edit(
            &root, &catalog, &row.id, &path.to_string_lossy(), None,
            Some("[00:01.000]Words\n"), None, &[], None,
        ).unwrap();
        assert_eq!(saved.rel_path, row.rel_path);
        assert_eq!(current_lyrics(&root, &saved).as_deref(), Some("[00:01.000]Words\n"));
        assert_eq!(catalog.track(&row.id).unwrap().unwrap().lufs, Some(-12.0));
        assert_eq!(library::lyrics_in(&library::track_dir(&root, &row.id)), saved.lyrics_path.map(|p| root.join(p)));
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_stale_lyrics_without_writing_anything() {
        let (root, catalog, row) = song();
        let path = root.join(&row.rel_path);
        fs::write(library::lyrics_path(&root, &row.id), "[00:01.00]Changed").unwrap();
        let result = save_edit(
            &root, &catalog, &row.id, &path.to_string_lossy(), None,
            Some("New"), None, &[], None,
        );
        assert!(result.unwrap_err().contains("lyrics changed"));
        assert_eq!(fs::read_to_string(library::lyrics_path(&root, &row.id)).unwrap(), "[00:01.00]Changed");
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_cuts_and_missing_ffmpeg_leave_original_intact() {
        let (root, catalog, row) = song();
        let path = root.join(&row.rel_path);
        let before = fs::read(&path).unwrap();
        let cut = [Cut { start_ms: 1000, end_ms: 2000 }];
        let result = save_edit(
            &root, &catalog, &row.id, &path.to_string_lossy(), None,
            Some("Words"), None, &cut, None,
        );
        assert!(result.unwrap_err().contains("FFmpeg"));
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(catalog.track(&row.id).unwrap().unwrap().rel_path, row.rel_path);
        assert!(!library::lyrics_path(&root, &row.id).exists());
        assert!(kept_ranges(&[Cut { start_ms: 1, end_ms: 4 }, Cut { start_ms: 3, end_ms: 5 }], 10).is_err());
        assert!(kept_ranges(&[Cut { start_ms: 0, end_ms: 10 }], 10).is_err());
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replaces_and_cuts_audio_while_preserving_identity_and_backing_up_original() {
        let Some(ffmpeg) = tools::find_tool("ffmpeg") else { return };
        let (root, catalog, row) = song();
        let original = root.join(&row.rel_path);
        let before = fs::read(&original).unwrap();
        let staged = root.join(library::CONFIG_DIR).join(format!("{STAGE_PREFIX}{}.wav", identity::new_id()));
        wav(&staged, 10);
        let cuts = [Cut { start_ms: 2000, end_ms: 4000 }, Cut { start_ms: 6000, end_ms: 8000 }];
        let saved = save_edit(
            &root, &catalog, &row.id, &original.to_string_lossy(), None,
            Some("[00:05.000]Words\n"), Some(&staged.to_string_lossy()), &cuts, Some(&ffmpeg),
        ).unwrap();
        assert_eq!(saved.id, row.id);
        assert_eq!(saved.title, row.title);
        assert_eq!(saved.artist, row.artist);
        assert_eq!(saved.added_at, row.added_at);
        assert!(saved.rel_path.ends_with(".flac"));
        assert!((saved.duration_ms as i64 - 6000).abs() < 50, "{}", saved.duration_ms);
        assert_eq!(current_lyrics(&root, &saved).as_deref(), Some("[00:05.000]Words\n"));
        assert_eq!(catalog.track(&row.id).unwrap().unwrap().lufs, None);
        let backups: Vec<_> = fs::read_dir(root.join(library::CONFIG_DIR).join("audio-backups").join(&row.id))
            .unwrap().map(|entry| entry.unwrap().path()).collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read(&backups[0]).unwrap(), before);
        assert_eq!(fs::read(&original).unwrap(), before);
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_accepts_editor_stages_in_the_config_directory() {
        let (root, catalog, row) = song();
        let staged = root.join(library::CONFIG_DIR).join(format!("{STAGE_PREFIX}{}.wav", identity::new_id()));
        assert!(stage_path(&root, &staged.to_string_lossy()).is_ok());
        assert!(stage_path(&root, &root.join(&row.rel_path).to_string_lossy()).is_err());
        assert!(stage_path(&root, &root.join(library::CONFIG_DIR).join(".song-editor-../audio.wav").to_string_lossy()).is_err());
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn waveform_represents_audio_peaks() {
        let Some(ffmpeg) = tools::find_tool("ffmpeg") else { return };
        let (root, catalog, row) = song();
        let path = root.join(&row.rel_path);
        let mut bytes = fs::read(&path).unwrap();
        for (index, sample) in bytes[44..44 + 8000 * 2].chunks_exact_mut(2).enumerate() {
            let angle = index as f32 * std::f32::consts::TAU * 440.0 / 8000.0;
            sample.copy_from_slice(&((angle.sin() * 16000.0) as i16).to_le_bytes());
        }
        fs::write(&path, bytes).unwrap();
        let peaks = waveform(&path, &ffmpeg).unwrap();
        assert_eq!(peaks.len(), 200);
        assert!(peaks[5] > 0.25, "{}", peaks[5]);
        assert!(peaks[100] < 0.01);
        drop(catalog);
        fs::remove_dir_all(root).unwrap();
    }
}

#[tauri::command(async)]
pub fn save_song_edit(
    app: AppHandle,
    catalog: State<'_, Catalog>,
    track_id: String,
    expected_path: String,
    expected_lyrics: Option<String>,
    lyrics: Option<String>,
    staged_audio: Option<String>,
    cuts: Vec<Cut>,
) -> Result<library::Track, String> {
    let root = library::library_root(&app)?;
    let env = source::read_env(&app);
    let ffmpeg = tools::tool_path(env.ffmpeg.as_ref(), "ffmpeg", tools::bundled_dir(&app).as_deref());
    let row = save_edit(
        &root, &catalog, &track_id, &expected_path, expected_lyrics.as_deref(),
        lyrics.as_deref(), staged_audio.as_deref(), &cuts, ffmpeg.as_deref(),
    )?;
    Ok(library::to_track(&row, &root))
}

fn current_lyrics(root: &Path, row: &TrackRow) -> Option<String> {
    let path = row.lyrics_path.as_deref().map(|path| root.join(path))
        .filter(|path| path.is_file())
        .or_else(|| library::lyrics_in(&library::track_dir(root, &row.id)))?;
    fs::read_to_string(path).ok().filter(|text| !text.trim().is_empty())
}

fn kept_ranges(cuts: &[Cut], duration_ms: u64) -> Result<Vec<(u64, Option<u64>)>, String> {
    if cuts.len() > 100 || duration_ms == 0 {
        return Err("The audio length or cut ranges could not be read.".to_string());
    }
    let mut cuts = cuts.to_vec();
    cuts.sort_by_key(|cut| cut.start_ms);
    let mut end = 0;
    let mut kept = Vec::new();
    for cut in cuts {
        if cut.start_ms >= cut.end_ms || cut.end_ms > duration_ms || cut.start_ms < end {
            return Err("Cut ranges must be within the audio and must not overlap.".to_string());
        }
        if cut.start_ms > end {
            kept.push((end, Some(cut.start_ms)));
        }
        end = cut.end_ms;
    }
    if end < duration_ms {
        kept.push((end, None));
    }
    if kept.is_empty() {
        return Err("The cuts cannot remove the entire song.".to_string());
    }
    Ok(kept)
}

fn render_cuts(source: &Path, target: &Path, ffmpeg: &Path, kept: &[(u64, Option<u64>)]) -> Result<(), String> {
    let mut filters = Vec::new();
    let mut inputs = String::new();
    for (index, (start, end)) in kept.iter().enumerate() {
        let end = end.map(|value| format!(":end={:.3}", value as f64 / 1000.0)).unwrap_or_default();
        filters.push(format!("[0:a:0]atrim=start={:.3}{end},asetpts=PTS-STARTPTS[a{index}]", *start as f64 / 1000.0));
        inputs.push_str(&format!("[a{index}]"));
    }
    filters.push(format!("{inputs}concat=n={}:v=0:a=1[out]", kept.len()));
    let mut command = Command::new(ffmpeg);
    command.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(source)
        .args(["-filter_complex", &filters.join(";"), "-map", "[out]", "-c:a", "flac"])
        .arg(target);
    tools::hide_console(&mut command);
    let output = command.output().map_err(|e| format!("Could not start FFmpeg: {e}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Could not render the audio: {}", detail.trim()));
    }
    Ok(())
}

fn preserve_tags(original: &Path, target: &Path, row: &TrackRow) -> Result<(), String> {
    let old = lofty::read_from_path(original).map_err(|e| format!("Could not read the song tags: {e}"))?;
    let file = lofty::read_from_path(target).map_err(|e| format!("Could not read the new audio: {e}"))?;
    let tag_type = file.file_type().primary_tag_type();
    if !file.file_type().tag_support(tag_type).is_writable() {
        return Err("The replacement audio format cannot preserve this song's tags.".to_string());
    }
    let mut tag = old.primary_tag().or_else(|| old.first_tag()).cloned().unwrap_or_else(|| Tag::new(tag_type));
    if tag.tag_type() != tag_type {
        tag.re_map(tag_type);
    }
    tag.set_title(row.title.clone());
    match &row.artist { Some(value) => tag.set_artist(value.clone()), None => tag.remove_artist() }
    match &row.album { Some(value) => tag.set_album(value.clone()), None => tag.remove_album() }
    match &row.album_artist {
        Some(value) => { tag.insert_text(ItemKey::AlbumArtist, value.clone()); }
        None => tag.remove_key(ItemKey::AlbumArtist),
    }
    match &row.genre {
        Some(value) => { tag.insert_text(ItemKey::Genre, value.clone()); }
        None => tag.remove_key(ItemKey::Genre),
    }
    match row.year {
        Some(year) => tag.set_date(Timestamp { year, ..tag.date().unwrap_or_default() }),
        None => tag.remove_date(),
    }
    match row.track_no { Some(value) => tag.set_track(value), None => tag.remove_track() }
    match row.disc_no { Some(value) => tag.set_disk(value), None => tag.remove_disk() }
    drop(file);
    drop(old);
    tag.save_to_path(target, WriteOptions::default())
        .map_err(|e| format!("Could not preserve the song tags: {e}"))
}

fn save_edit(
    root: &Path,
    catalog: &Catalog,
    track_id: &str,
    expected_path: &str,
    expected_lyrics: Option<&str>,
    lyrics: Option<&str>,
    staged_audio: Option<&str>,
    cuts: &[Cut],
    ffmpeg: Option<&Path>,
) -> Result<TrackRow, String> {
    let _operation = catalog.library_operation();
    let previous = catalog.track(track_id)?.filter(|row| !row.missing)
        .ok_or_else(|| "That song is no longer in the library.".to_string())?;
    let original = root.join(&previous.rel_path);
    if original.to_string_lossy() != expected_path {
        return Err("The song changed while the editor was open. Reopen it and try again.".to_string());
    }
    let stamp = identity::stamp_of(&original)?;
    if stamp.bytes != previous.bytes || stamp.modified_ms != previous.modified_ms {
        return Err("The song changed since the last scan. Rescan the library and try again.".to_string());
    }
    if lyrics.is_some() && current_lyrics(root, &previous).as_deref() != expected_lyrics {
        return Err("The lyrics changed while the editor was open. Reopen it and try again.".to_string());
    }
    let audio_changed = staged_audio.is_some() || !cuts.is_empty();
    let source = match staged_audio {
        Some(path) => stage_path(root, path)?,
        None => original.clone(),
    };
    let dir = library::track_dir(root, track_id);
    let mut created = Vec::new();
    let result = (|| {
        let mut row = previous.clone();
        if audio_changed {
            let info = lofty::read_from_path(&source).map_err(|e| format!("Could not read the audio: {e}"))?;
            let duration = info.properties().duration().as_millis() as u64;
            let extension = if cuts.is_empty() {
                source.extension().and_then(|value| value.to_str()).unwrap_or("audio")
            } else {
                "flac"
            };
            let target = dir.join(format!("audio-{}.{}", identity::new_id(), extension));
            created.push(target.clone());
            if cuts.is_empty() {
                fs::copy(&source, &target).map_err(|e| format!("Could not prepare the new audio: {e}"))?;
            } else {
                let kept = kept_ranges(cuts, duration)?;
                let ffmpeg = ffmpeg.ok_or_else(|| "FFmpeg was not found. Install it or set FFMPEG_PATH in Wave's config to cut audio.".to_string())?;
                render_cuts(&source, &target, ffmpeg, &kept)?;
            }
            preserve_tags(&original, &target, &previous)?;
            row = library::describe(root, track_id, &target, &previous.original_name, None)?;
            if row.title != previous.title || row.artist != previous.artist || row.album != previous.album
                || row.album_artist != previous.album_artist || row.genre != previous.genre
                || row.year != previous.year || row.track_no != previous.track_no || row.disc_no != previous.disc_no {
                return Err("The replacement format could not preserve the song's tags.".to_string());
            }
            row.added_at = previous.added_at;
            row.cover_path = previous.cover_path.clone();
            row.lyrics_path = previous.lyrics_path.clone();
            let backup = root.join(library::CONFIG_DIR).join("audio-backups").join(track_id);
            fs::create_dir_all(&backup).map_err(|e| format!("Could not prepare an audio backup: {e}"))?;
            let name = original.file_name().ok_or_else(|| "The song has no file name.".to_string())?;
            let backup = backup.join(format!("{}-{}", identity::new_id(), name.to_string_lossy()));
            fs::copy(&original, backup).map_err(|e| format!("Could not back up the original audio: {e}"))?;
        }
        if let Some(lyrics) = lyrics {
            let target = dir.join(format!("lyrics-{:020}-{}.lrc", identity::now_ms().max(0), identity::new_id()));
            created.push(target.clone());
            fs::write(&target, lyrics).map_err(|e| format!("Could not save the lyrics: {e}"))?;
            row.lyrics_path = library::relative(root, &target);
        }
        if identity::stamp_of(&original)? != stamp {
            return Err("The song changed while it was being edited. Try again.".to_string());
        }
        if audio_changed {
            catalog.replace_audio_track(&row)?;
        } else {
            catalog.upsert_track(&row)?;
        }
        Ok(row)
    })();
    if result.is_err() {
        for path in created {
            let _ = fs::remove_file(path);
        }
    } else if lyrics.is_some() {
        if let Some(path) = previous.lyrics_path.as_deref().map(|path| root.join(path)) {
            if path.parent() == Some(dir.as_path()) {
                let _ = fs::remove_file(path);
            }
        }
    }
    result
}

#[tauri::command]
pub fn cleanup_edited_audio(catalog: State<'_, Catalog>, track_id: String, old_path: String) -> Result<(), String> {
    let root = catalog.root();
    let _operation = catalog.library_operation();
    let row = catalog.track(&track_id)?.ok_or_else(|| "That song is no longer in the library.".to_string())?;
    let old = PathBuf::from(old_path);
    if old.parent() != Some(library::track_dir(root, &track_id).as_path())
        || old == root.join(&row.rel_path)
        || !library::has_extension(&old, library::AUDIO_EXTENSIONS) {
        return Err("That audio cannot be removed.".to_string());
    }
    if old.exists() {
        fs::remove_file(old).map_err(|e| format!("Could not remove the previous library copy: {e}"))?;
    }
    Ok(())
}
