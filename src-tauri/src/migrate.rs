use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::catalog::{Catalog, LAYOUT_VERSION, LAYOUT_VERSION_KEY};
use crate::identity;
use crate::library::{
    self, has_extension, library_root, track_dir, AUDIO_EXTENSIONS, CONFIG_DIR, SONGS_DIR,
};
use crate::state::{Playlist, Store};

const LEGACY_INDEX_FILE: &str = "index.json";
const LEGACY_LOUDNESS_FILE: &str = "loudness.json";
const LEGACY_PLAYLISTS_DIR: &str = "playlists";
const LEGACY_ARTWORK_DIR: &str = "images";
const LEGACY_LYRICS_DIR: &str = "lyrics";

const JOURNAL_FILE: &str = "migration.json";

#[derive(Debug, Default, Deserialize)]
struct LegacyIndex {
    #[serde(default)]
    songs: HashMap<String, String>,
    #[serde(default)]
    lyrics: HashMap<String, String>,
}

#[derive(Debug, Default, Deserialize)]
struct LegacyLoudness {
    #[serde(default)]
    songs: HashMap<String, Reading>,
}

#[derive(Debug, Deserialize)]
struct Reading {
    lufs: f32,
    peak: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PlannedMove {
    /// The id the old library minted from the song's path.
    old_id: String,
    new_id: String,
    /// Library-relative, as is `to`.
    from: String,
    to: String,
    name: String,
    /// Another file already holds this audio, so there is nothing to move and
    /// this song's history belongs on that one.
    duplicate: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Journal {
    backup: String,
    moves: Vec<PlannedMove>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub songs: usize,
    pub covers: usize,
    pub lyrics: usize,
    pub playlists: usize,
    /// Where the old records were put.
    pub backup: String,
    pub failures: Vec<String>,
}

/// Returns `None` when there was nothing to upgrade.
pub fn run(
    app: &AppHandle,
    catalog: &Catalog,
    store: &Store,
) -> Result<Option<MigrationReport>, String> {
    let root = library_root(app)?;
    let state = crate::state::state_file(app).ok();

    upgrade(&root, catalog, state.as_deref(), |tracks, playlists| {
        crate::state::remap_ids(app, store, tracks, playlists)?;
        crate::analytics::remap_track_ids(app, tracks)
    })
}

pub fn upgrade(
    root: &Path,
    catalog: &Catalog,
    state_file: Option<&Path>,
    remap: impl FnOnce(&HashMap<String, String>, &HashMap<String, String>) -> Result<(), String>,
) -> Result<Option<MigrationReport>, String> {
    if catalog.meta(LAYOUT_VERSION_KEY).is_some() {
        return Ok(None);
    }

    let journal_path = root.join(CONFIG_DIR).join(JOURNAL_FILE);

    let journal = match read_journal(&journal_path) {
        Some(journal) => journal,
        None => {
            let loose = loose_songs(root)?;
            let index_exists = root.join(CONFIG_DIR).join(LEGACY_INDEX_FILE).is_file();

            if loose.is_empty() && !index_exists {
                catalog.set_meta(LAYOUT_VERSION_KEY, LAYOUT_VERSION)?;
                return Ok(None);
            }

            let journal = Journal {
                backup: backup_dir(root)?.to_string_lossy().into_owned(),
                moves: plan(&loose)?,
            };
            write_journal(&journal_path, &journal)?;
            journal
        }
    };

    let report = apply(root, catalog, state_file, &journal, remap)?;

    // Recorded before the journal goes, so a crash in between is harmless.
    catalog.set_meta(LAYOUT_VERSION_KEY, LAYOUT_VERSION)?;
    let _ = fs::remove_file(&journal_path);

    Ok(Some(report))
}

fn apply(
    root: &Path,
    catalog: &Catalog,
    state_file: Option<&Path>,
    journal: &Journal,
    remap: impl FnOnce(&HashMap<String, String>, &HashMap<String, String>) -> Result<(), String>,
) -> Result<MigrationReport, String> {
    let backup = PathBuf::from(&journal.backup);
    fs::create_dir_all(&backup).map_err(|e| format!("could not create {}: {e}", backup.display()))?;

    let mut report = MigrationReport {
        backup: journal.backup.clone(),
        ..MigrationReport::default()
    };

    back_up_records(root, &backup, state_file)?;

    let index = read_legacy_index(root);
    let loudness = read_legacy_loudness(root);

    let mut ids: HashMap<String, String> = HashMap::new();
    for planned in &journal.moves {
        ids.insert(planned.old_id.clone(), planned.new_id.clone());
    }

    for planned in &journal.moves {
        if planned.duplicate {
            // The copy that was kept owns this song's history.
            let stray = root.join(&planned.from);
            if stray.is_file() {
                let _ = move_file(&stray, &backup.join(&planned.name));
            }
            continue;
        }

        let source = root.join(&planned.from);
        let target = root.join(&planned.to);

        if !target.is_file() {
            if !source.is_file() {
                report.failures.push(format!("{} is missing", planned.name));
                continue;
            }
            let dir = track_dir(root, &planned.new_id);
            fs::create_dir_all(&dir)
                .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
            move_file(&source, &target)?;
        }

        let cover = copy_cover(&index, root, planned)?;
        let lyrics = copy_lyrics(&index, root, planned)?;

        match library::describe(root, &planned.new_id, &target, &planned.name) {
            Ok(row) => {
                catalog.upsert_track(&row)?;
                report.songs += 1;
                report.covers += usize::from(cover);
                report.lyrics += usize::from(lyrics);

                if let Some(reading) = loudness.songs.get(&planned.from) {
                    catalog.set_loudness(&planned.new_id, reading.lufs, reading.peak, row.bytes)?;
                }
            }
            Err(error) => report.failures.push(format!("{}: {error}", planned.name)),
        }
    }

    let (playlists, playlist_ids) = legacy_playlists(root, &ids, &mut report.failures)?;
    if !playlists.is_empty() {
        catalog.insert_playlists(&playlists)?;
        report.playlists = playlists.len();
    }

    remap(&ids, &playlist_ids)?;

    sweep(root, &backup)?;
    Ok(report)
}

fn back_up_records(root: &Path, backup: &Path, state: Option<&Path>) -> Result<(), String> {
    for name in [LEGACY_INDEX_FILE, LEGACY_LOUDNESS_FILE] {
        let from = root.join(CONFIG_DIR).join(name);
        if from.is_file() {
            let to = backup.join(name);
            fs::copy(&from, &to).map_err(|e| format!("could not back up {}: {e}", from.display()))?;
        }
    }

    if let Some(state) = state.filter(|path| path.is_file()) {
        let to = backup.join("state.json");
        fs::copy(state, &to).map_err(|e| format!("could not back up {}: {e}", state.display()))?;
    }

    let playlists = root.join(LEGACY_PLAYLISTS_DIR);
    if let Ok(entries) = fs::read_dir(&playlists) {
        let to = backup.join(LEGACY_PLAYLISTS_DIR);
        fs::create_dir_all(&to).map_err(|e| format!("could not create {}: {e}", to.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let _ = fs::copy(&path, to.join(entry.file_name()));
            }
        }
    }

    Ok(())
}

/// Files sitting directly in the songs folder, where the old layout kept them.
fn loose_songs(root: &Path) -> Result<Vec<PathBuf>, String> {
    let dir = root.join(SONGS_DIR);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };

    let mut found: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && has_extension(&path, AUDIO_EXTENSIONS) {
            found.push(path);
        }
    }

    // Sorted, so the same library always produces the same plan.
    found.sort();
    Ok(found)
}

fn plan(loose: &[PathBuf]) -> Result<Vec<PlannedMove>, String> {
    let mut taken: HashSet<String> = HashSet::new();
    let mut moves = Vec::new();

    for path in loose {
        let Some(name) = path.file_name().map(|name| name.to_string_lossy().into_owned()) else {
            continue;
        };
        let Some(extension) = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_lowercase())
        else {
            continue;
        };

        // Reproduced so the song's likes and playlists can still be found.
        let from = format!("{SONGS_DIR}/{name}");
        let old_id = identity::legacy_id(&from);

        let hash = identity::content_hash(path)?;
        let new_id = identity::id_for_hash(&hash);
        let to = format!(
            "{SONGS_DIR}/{new_id}/{}.{extension}",
            library::AUDIO_STEM
        );

        moves.push(PlannedMove {
            old_id,
            new_id,
            from,
            to: to.clone(),
            name,
            duplicate: !taken.insert(to),
        });
    }

    Ok(moves)
}

fn copy_cover(index: &LegacyIndex, root: &Path, planned: &PlannedMove) -> Result<bool, String> {
    let Some(recorded) = index.songs.get(&planned.from) else {
        return Ok(false);
    };

    let from = root.join(recorded);
    if !from.is_file() {
        return Ok(false);
    }

    let extension = from
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("jpg")
        .to_lowercase();
    let to = library::cover_path(root, &planned.new_id, &extension);

    // Copied, not moved: the index could point two songs at one cover.
    fs::copy(&from, &to).map_err(|e| format!("could not copy {}: {e}", from.display()))?;
    Ok(true)
}

fn copy_lyrics(index: &LegacyIndex, root: &Path, planned: &PlannedMove) -> Result<bool, String> {
    let Some(recorded) = index.lyrics.get(&planned.from) else {
        return Ok(false);
    };

    let from = root.join(recorded);
    if !from.is_file() {
        return Ok(false);
    }

    let to = library::lyrics_path(root, &planned.new_id);
    fs::copy(&from, &to).map_err(|e| format!("could not copy {}: {e}", from.display()))?;
    Ok(true)
}

/// Also returns the old names mapped to the ids they have now, which is what a
/// queue that was playing a playlist is renumbered by.
fn legacy_playlists(
    root: &Path,
    ids: &HashMap<String, String>,
    failures: &mut Vec<String>,
) -> Result<(Vec<Playlist>, HashMap<String, String>), String> {
    let dir = root.join(LEGACY_PLAYLISTS_DIR);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok((Vec::new(), HashMap::new()));
    };

    let mut playlists = Vec::new();
    let mut names = HashMap::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }

        let Some(name) = path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
        else {
            continue;
        };
        if name.is_empty() {
            continue;
        }

        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) => {
                failures.push(format!("{name} could not be read: {error}"));
                continue;
            }
        };
        let files: Vec<String> = match serde_json::from_str(&raw) {
            Ok(files) => files,
            Err(error) => {
                failures.push(format!("{name} is not a readable playlist: {error}"));
                continue;
            }
        };

        let track_ids: Vec<String> = files
            .iter()
            .filter_map(|file| ids.get(&identity::legacy_id(file)).cloned())
            .collect();

        let created_at = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0);

        let id = playlist_id(&name);
        names.insert(name.clone(), id.clone());
        playlists.push(Playlist {
            id,
            name,
            entries: track_ids.clone(),
            track_ids,
            created_at,
            ..Playlist::default()
        });
    }

    playlists.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok((playlists, names))
}

/// Derived from the name, so a re-run does not leave two copies behind.
fn playlist_id(name: &str) -> String {
    identity::id_for_hash(&format!("wave:playlist:{}", name.to_lowercase()))
}

/// Puts whatever is left of the old layout into the backup.
fn sweep(root: &Path, backup: &Path) -> Result<(), String> {
    let orphans = backup.join("orphans");

    for name in [LEGACY_ARTWORK_DIR, LEGACY_LYRICS_DIR] {
        let dir = root.join(name);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.path().is_file() {
                continue;
            }
            fs::create_dir_all(&orphans)
                .map_err(|e| format!("could not create {}: {e}", orphans.display()))?;
            let _ = fs::rename(entry.path(), orphans.join(entry.file_name()))
                .or_else(|_| fs::copy(entry.path(), orphans.join(entry.file_name())).map(|_| ()));
        }
        let _ = fs::remove_dir(&dir);
    }

    for name in [LEGACY_INDEX_FILE, LEGACY_LOUDNESS_FILE] {
        let _ = fs::remove_file(root.join(CONFIG_DIR).join(name));
    }

    let playlists = root.join(LEGACY_PLAYLISTS_DIR);
    if let Ok(entries) = fs::read_dir(&playlists) {
        for entry in entries.flatten() {
            if entry.path().is_file() {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let _ = fs::remove_dir(&playlists);

    Ok(())
}

fn read_legacy_index(root: &Path) -> LegacyIndex {
    fs::read_to_string(root.join(CONFIG_DIR).join(LEGACY_INDEX_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn read_legacy_loudness(root: &Path) -> LegacyLoudness {
    fs::read_to_string(root.join(CONFIG_DIR).join(LEGACY_LOUDNESS_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn read_journal(path: &Path) -> Option<Journal> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn write_journal(path: &Path, journal: &Journal) -> Result<(), String> {
    let json = serde_json::to_string_pretty(journal).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("could not write {}: {e}", path.display()))
}

fn backup_dir(root: &Path) -> Result<PathBuf, String> {
    let dir = root
        .join(CONFIG_DIR)
        .join(format!("legacy-{}", identity::now_ms()));
    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// A rename where that works, a copy where it does not, so a library on another
/// volume is still upgradable.
fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    fs::copy(from, to).map_err(|e| format!("could not file {}: {e}", to.display()))?;
    let _ = fs::remove_file(from);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wave-migrate-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(SONGS_DIR)).unwrap();
        fs::create_dir_all(dir.join(CONFIG_DIR)).unwrap();
        dir
    }

    #[test]
    fn a_song_is_planned_for_the_id_its_audio_earns() {
        let root = scratch("plan");
        let song = root.join(SONGS_DIR).join("Hey Jude.mp3");
        fs::write(&song, b"the audio").unwrap();

        let planned = plan(&loose_songs(&root).unwrap()).unwrap();

        assert_eq!(planned.len(), 1);
        let move_ = &planned[0];
        assert_eq!(move_.name, "Hey Jude.mp3");
        // The id the old library would have minted, so its likes can be found.
        assert_eq!(move_.old_id, identity::legacy_id("songs/Hey Jude.mp3"));
        assert_eq!(
            move_.new_id,
            identity::id_for_hash(&identity::content_hash(&song).unwrap())
        );
        assert_eq!(move_.to, format!("{SONGS_DIR}/{}/audio.mp3", move_.new_id));
        assert!(!move_.duplicate);
    }

    #[test]
    fn the_same_audio_twice_is_one_song() {
        let root = scratch("duplicate");
        for name in ["song.mp3", "song copy.mp3"] {
            fs::write(root.join(SONGS_DIR).join(name), b"the same audio").unwrap();
        }

        let planned = plan(&loose_songs(&root).unwrap()).unwrap();

        assert_eq!(planned.len(), 2);
        assert!(!planned[0].duplicate);
        assert!(planned[1].duplicate);
        // Both histories land on the one song that was kept.
        assert_eq!(planned[0].new_id, planned[1].new_id);
        assert_ne!(planned[0].old_id, planned[1].old_id);
    }

    #[test]
    fn only_audio_in_the_songs_folder_is_planned_for() {
        let root = scratch("loose");
        fs::write(root.join(SONGS_DIR).join("song.mp3"), b"audio").unwrap();
        fs::write(root.join(SONGS_DIR).join("notes.txt"), b"not audio").unwrap();
        fs::create_dir_all(root.join(SONGS_DIR).join("an-id-already")).unwrap();

        let loose = loose_songs(&root).unwrap();

        assert_eq!(loose.len(), 1);
        assert_eq!(loose[0].file_name().unwrap(), "song.mp3");
    }

    #[test]
    fn a_legacy_playlist_becomes_ids_in_the_order_it_had() {
        let root = scratch("playlists");
        let dir = root.join(LEGACY_PLAYLISTS_DIR);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("Road trip.json"),
            r#"["songs/One.mp3", "songs/Two.mp3", "songs/Gone.mp3"]"#,
        )
        .unwrap();

        let mut ids = HashMap::new();
        ids.insert(
            identity::legacy_id("songs/One.mp3"),
            "id-one".to_string(),
        );
        ids.insert(
            identity::legacy_id("songs/Two.mp3"),
            "id-two".to_string(),
        );

        let (playlists, names) = legacy_playlists(&root, &ids, &mut Vec::new()).unwrap();

        assert_eq!(playlists.len(), 1);
        assert_eq!(playlists[0].name, "Road trip");
        // A song the library no longer has is left out, and the rest keep order.
        assert_eq!(playlists[0].track_ids, vec!["id-one", "id-two"]);
        assert_eq!(names.get("Road trip"), Some(&playlist_id("Road trip")));
    }

    #[test]
    fn a_playlist_keeps_the_same_id_however_often_it_is_migrated() {
        assert_eq!(playlist_id("Rock"), playlist_id("rock"));
        assert_ne!(playlist_id("Rock"), playlist_id("Jazz"));
    }

    #[test]
    fn the_journal_round_trips() {
        let root = scratch("journal");
        let path = root.join(CONFIG_DIR).join(JOURNAL_FILE);
        let journal = Journal {
            backup: "config/legacy-1".to_string(),
            moves: vec![PlannedMove {
                old_id: "old".to_string(),
                new_id: "new".to_string(),
                from: "songs/a.mp3".to_string(),
                to: "songs/new/audio.mp3".to_string(),
                name: "a.mp3".to_string(),
                duplicate: false,
            }],
        };

        write_journal(&path, &journal).unwrap();
        let read = read_journal(&path).unwrap();

        assert_eq!(read.backup, journal.backup);
        assert_eq!(read.moves.len(), 1);
        assert_eq!(read.moves[0].new_id, "new");
        assert!(read_journal(&root.join(CONFIG_DIR).join("nowhere.json")).is_none());
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    /// A library root with the folders the old version kept.
    fn legacy(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("wave-migration-{name}"));
        let _ = fs::remove_dir_all(&root);
        for dir in [
            SONGS_DIR,
            CONFIG_DIR,
            LEGACY_PLAYLISTS_DIR,
            LEGACY_ARTWORK_DIR,
            LEGACY_LYRICS_DIR,
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        root
    }

    fn write_sine(path: &Path, amplitude: f32, seconds: f32) {
        const RATE: u32 = 44_100;
        const CHANNELS: u16 = 2;
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

    /// The same audio, carrying the tags a song in an old library had.
    fn write_tagged_sine(
        path: &Path,
        amplitude: f32,
        seconds: f32,
        title: &str,
        artist: &str,
        album: &str,
    ) {
        use lofty::prelude::Accessor;
        use lofty::tag::{Tag, TagExt, TagType};

        write_sine(path, amplitude, seconds);
        let mut tag = Tag::new(TagType::Id3v2);
        tag.set_title(title.to_string());
        tag.set_artist(artist.to_string());
        tag.set_album(album.to_string());
        tag.save_to_path(path, lofty::config::WriteOptions::default())
            .expect("the tags are written into the wav");
    }

    /// The id a song earns from the bytes it holds.
    fn id_of(path: &Path) -> String {
        identity::id_for_hash(&identity::content_hash(path).unwrap())
    }

    fn object(pairs: &[(&str, &str)]) -> serde_json::Value {
        serde_json::Value::Object(
            pairs
                .iter()
                .map(|(key, value)| {
                    (
                        (*key).to_string(),
                        serde_json::Value::String((*value).to_string()),
                    )
                })
                .collect(),
        )
    }

    /// `config/index.json`, as the old version wrote it.
    fn write_index(root: &Path, songs: &[(&str, &str)], lyrics: &[(&str, &str)]) {
        let json = serde_json::json!({
            "songs": object(songs),
            "lyrics": object(lyrics),
        });
        fs::write(root.join(CONFIG_DIR).join(LEGACY_INDEX_FILE), json.to_string()).unwrap();
    }

    fn write_loudness(root: &Path, readings: &[(&str, f32, f32)]) {
        let mut songs = serde_json::Map::new();
        for (path, lufs, peak) in readings {
            let bytes = fs::metadata(root.join(path)).map(|meta| meta.len()).unwrap_or(0);
            songs.insert(
                (*path).to_string(),
                serde_json::json!({ "lufs": lufs, "peak": peak, "bytes": bytes }),
            );
        }
        let json = serde_json::json!({ "songs": serde_json::Value::Object(songs) });
        fs::write(
            root.join(CONFIG_DIR).join(LEGACY_LOUDNESS_FILE),
            json.to_string(),
        )
        .unwrap();
    }

    /// `playlists/<name>.json`: library-relative paths, in order.
    fn write_playlist(root: &Path, name: &str, files: &[&str]) {
        let json = serde_json::Value::Array(
            files
                .iter()
                .map(|file| serde_json::Value::String((*file).to_string()))
                .collect(),
        );
        fs::write(
            root.join(LEGACY_PLAYLISTS_DIR).join(format!("{name}.json")),
            json.to_string(),
        )
        .unwrap();
    }

    /// Runs the upgrade, recording what the remap closure was handed.
    fn run_upgrade(
        root: &Path,
    ) -> (
        Option<MigrationReport>,
        HashMap<String, String>,
        HashMap<String, String>,
    ) {
        let catalog = Catalog::open(root).unwrap();
        let seen: RefCell<Option<(HashMap<String, String>, HashMap<String, String>)>> =
            RefCell::new(None);

        let report = upgrade(root, &catalog, None, |tracks, playlists| {
            *seen.borrow_mut() = Some((tracks.clone(), playlists.clone()));
            Ok(())
        })
        .expect("the upgrade runs");

        let (tracks, playlists) = seen.into_inner().unwrap_or_default();
        (report, tracks, playlists)
    }

    fn tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
        let mut found = BTreeMap::new();
        walk(root, root, &mut found);
        found
    }

    fn walk(root: &Path, dir: &Path, into: &mut BTreeMap<String, Vec<u8>>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        let catalog_file = format!("{CONFIG_DIR}/{}", crate::catalog::CATALOG_FILE);

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, into);
                continue;
            }
            let Some(relative) = library::relative(root, &path) else {
                continue;
            };
            if relative == catalog_file {
                continue;
            }
            into.insert(relative, fs::read(&path).unwrap_or_default());
        }
    }

    #[test]
    fn the_fixture_writes_tags_lofty_can_read() {
        use lofty::prelude::{Accessor, TaggedFileExt};

        let root = legacy("fixture");
        let song = root.join(SONGS_DIR).join("song.wav");
        write_tagged_sine(&song, 0.5, 1.0, "A Title", "An Artist", "An Album");

        let tagged = lofty::read_from_path(&song).unwrap();
        let tag = tagged.primary_tag().or_else(|| tagged.first_tag()).unwrap();

        assert_eq!(tag.title().as_deref(), Some("A Title"));
        assert_eq!(tag.artist().as_deref(), Some("An Artist"));
        assert_eq!(tag.album().as_deref(), Some("An Album"));
    }

    #[test]
    fn a_legacy_library_is_filed_and_its_history_renumbered() {
        let root = legacy("happy");
        let hey = root.join(SONGS_DIR).join("Hey Jude.wav");
        let step = root.join(SONGS_DIR).join("15 Step.wav");
        write_tagged_sine(&hey, 0.5, 1.0, "Hey Jude", "The Beatles", "Past Masters");
        write_tagged_sine(&step, 0.25, 1.0, "15 Step", "Radiohead", "In Rainbows");

        let hey_id = id_of(&hey);
        let step_id = id_of(&step);
        let hey_bytes = fs::metadata(&hey).unwrap().len();

        fs::write(
            root.join(LEGACY_ARTWORK_DIR).join("cover.jpg"),
            b"the cover bytes".to_vec(),
        )
        .unwrap();
        fs::write(
            root.join(LEGACY_LYRICS_DIR).join("hey.lrc"),
            b"[00:01.00] Hey Jude".to_vec(),
        )
        .unwrap();
        write_index(
            &root,
            &[("songs/Hey Jude.wav", "images/cover.jpg")],
            &[("songs/Hey Jude.wav", "lyrics/hey.lrc")],
        );
        write_loudness(
            &root,
            &[("songs/Hey Jude.wav", -9.5, 0.98), ("songs/15 Step.wav", -12.5, 0.5)],
        );
        write_playlist(&root, "Road trip", &["songs/15 Step.wav", "songs/Hey Jude.wav"]);

        let (report, ids, playlist_ids) = run_upgrade(&root);

        let report = report.expect("a legacy library is upgraded");
        assert_eq!(report.songs, 2);
        assert_eq!(report.covers, 1);
        assert_eq!(report.lyrics, 1);
        assert_eq!(report.playlists, 1);
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert!(Path::new(&report.backup).is_dir());

        // Each song is filed under the id its audio earns, and nothing is left
        // loose in the songs folder.
        assert!(track_dir(&root, &hey_id).join("audio.wav").is_file());
        assert!(track_dir(&root, &step_id).join("audio.wav").is_file());
        assert!(loose_songs(&root).unwrap().is_empty());

        let catalog = Catalog::open(&root).unwrap();
        let hey_row = catalog.track(&hey_id).unwrap().expect("Hey Jude is in the catalog");
        assert_eq!(hey_row.rel_path, format!("songs/{hey_id}/audio.wav"));
        assert_eq!(hey_row.original_name, "Hey Jude.wav");
        assert_eq!(hey_row.title, "Hey Jude");
        assert_eq!(hey_row.artist.as_deref(), Some("The Beatles"));
        assert_eq!(hey_row.album.as_deref(), Some("Past Masters"));
        assert_eq!(hey_row.codec, "WAV");
        assert_eq!(hey_row.lufs, Some(-9.5));
        assert_eq!(hey_row.peak, Some(0.98));
        assert_eq!(hey_row.loudness_bytes, Some(hey_bytes));

        let step_row = catalog.track(&step_id).unwrap().expect("15 Step is in the catalog");
        assert_eq!(step_row.title, "15 Step");
        assert_eq!(step_row.artist.as_deref(), Some("Radiohead"));
        assert_eq!(step_row.lufs, Some(-12.5));

        // The playlist holds the new ids, in the order the old file had.
        let playlists = catalog.playlists().unwrap();
        assert_eq!(playlists.len(), 1);
        assert_eq!(playlists[0].name, "Road trip");
        assert_eq!(playlists[0].track_ids, vec![step_id.clone(), hey_id.clone()]);

        // The map the caller renumbers likes, artwork colours, the queue and
        // the listening history with.
        assert_eq!(ids.len(), 2);
        assert_eq!(ids.get(&identity::legacy_id("songs/Hey Jude.wav")), Some(&hey_id));
        assert_eq!(ids.get(&identity::legacy_id("songs/15 Step.wav")), Some(&step_id));
        assert_eq!(playlist_ids.get("Road trip"), Some(&playlist_id("Road trip")));

        // The old records were kept before anything was touched, and the ones
        // the catalog replaces are gone from the library.
        let backup = PathBuf::from(&report.backup);
        assert!(backup.join(LEGACY_INDEX_FILE).is_file());
        assert!(backup.join(LEGACY_LOUDNESS_FILE).is_file());
        assert!(!root.join(CONFIG_DIR).join(LEGACY_INDEX_FILE).exists());
        assert!(!root.join(CONFIG_DIR).join(LEGACY_LOUDNESS_FILE).exists());
        assert!(!root.join(CONFIG_DIR).join(JOURNAL_FILE).exists());
        assert_eq!(
            catalog.meta(crate::catalog::LAYOUT_VERSION_KEY).as_deref(),
            Some(crate::catalog::LAYOUT_VERSION)
        );
    }

    #[test]
    fn a_second_upgrade_changes_nothing() {
        let root = legacy("idempotent");
        let song = root.join(SONGS_DIR).join("one.wav");
        write_tagged_sine(&song, 0.5, 1.0, "One", "An Artist", "An Album");
        let id = id_of(&song);
        fs::write(
            root.join(LEGACY_ARTWORK_DIR).join("cover.jpg"),
            b"the cover bytes".to_vec(),
        )
        .unwrap();
        write_index(&root, &[("songs/one.wav", "images/cover.jpg")], &[]);
        write_playlist(&root, "A playlist", &["songs/one.wav"]);

        let catalog = Catalog::open(&root).unwrap();
        let first = upgrade(&root, &catalog, None, |_, _| Ok(())).unwrap();
        assert!(first.is_some(), "the first run has work to do");

        let before = tree(&root);
        let rows_before: Vec<String> = catalog
            .tracks()
            .unwrap()
            .into_iter()
            .map(|row| row.id)
            .collect();

        let second = upgrade(&root, &catalog, None, |_, _| {
            panic!("a finished library has nothing to renumber")
        })
        .unwrap();

        assert!(second.is_none(), "the second run reports nothing to do");
        assert_eq!(tree(&root), before, "the second run changed the library");
        assert_eq!(
            catalog
                .tracks()
                .unwrap()
                .into_iter()
                .map(|row| row.id)
                .collect::<Vec<_>>(),
            rows_before
        );
        assert!(catalog.track(&id).unwrap().is_some());
    }

    #[test]
    fn a_journal_left_behind_after_a_finished_upgrade_is_ignored() {
        let root = legacy("journal-left");
        let song = root.join(SONGS_DIR).join("one.wav");
        write_tagged_sine(&song, 0.5, 1.0, "One", "An Artist", "An Album");
        let id = id_of(&song);
        write_index(&root, &[], &[]);

        let journal_path = root.join(CONFIG_DIR).join(JOURNAL_FILE);
        let captured: RefCell<Option<String>> = RefCell::new(None);
        let catalog = Catalog::open(&root).unwrap();

        let first = upgrade(&root, &catalog, None, |_, _| {
            // The journal is still on disk while the caller is renumbered.
            *captured.borrow_mut() = fs::read_to_string(&journal_path).ok();
            Ok(())
        })
        .unwrap();
        assert!(first.is_some());

        let journal = captured.into_inner().expect("the upgrade wrote a journal");
        assert!(journal.contains("moves"), "the journal is the planned moves");

        // Put it back, as a crash between the layout being recorded and the
        // journal being removed would leave it.
        fs::write(&journal_path, &journal).unwrap();
        let before = tree(&root);

        let second = upgrade(&root, &catalog, None, |_, _| {
            panic!("a finished library has nothing to renumber")
        })
        .unwrap();

        assert!(second.is_none());
        assert_eq!(tree(&root), before, "the leftover journal was acted on");
        assert!(journal_path.is_file(), "the leftover journal is simply ignored");
        assert_eq!(catalog.tracks().unwrap().len(), 1, "the song is not doubled");
        assert_eq!(catalog.track(&id).unwrap().unwrap().rel_path, format!("songs/{id}/audio.wav"));
        assert_eq!(
            catalog
                .playlists()
                .unwrap()
                .iter()
                .map(|list| list.track_ids.len())
                .sum::<usize>(),
            0
        );
    }

    #[test]
    fn an_upgrade_interrupted_after_a_move_still_files_every_song() {
        let root = legacy("interrupted");
        let step = root.join(SONGS_DIR).join("15 Step.wav");
        let hey = root.join(SONGS_DIR).join("Hey Jude.wav");
        write_tagged_sine(&step, 0.25, 1.0, "15 Step", "Radiohead", "In Rainbows");
        write_tagged_sine(&hey, 0.5, 1.0, "Hey Jude", "The Beatles", "Past Masters");

        let step_id = id_of(&step);
        let hey_id = id_of(&hey);

        fs::write(
            root.join(LEGACY_ARTWORK_DIR).join("cover.jpg"),
            b"the cover bytes".to_vec(),
        )
        .unwrap();
        write_index(
            &root,
            &[
                ("songs/15 Step.wav", "images/cover.jpg"),
                ("songs/Hey Jude.wav", "images/cover.jpg"),
            ],
            &[],
        );
        write_playlist(&root, "Road trip", &["songs/15 Step.wav", "songs/Hey Jude.wav"]);

        // The journal exactly as the upgrade writes it, before it moves
        // anything.
        let journal = Journal {
            backup: backup_dir(&root).unwrap().to_string_lossy().into_owned(),
            moves: plan(&loose_songs(&root).unwrap()).unwrap(),
        };
        write_journal(&root.join(CONFIG_DIR).join(JOURNAL_FILE), &journal).unwrap();

        let interrupted = &journal.moves[0];
        fs::create_dir_all(track_dir(&root, &interrupted.new_id)).unwrap();
        fs::rename(root.join(&interrupted.from), root.join(&interrupted.to)).unwrap();

        let (report, ids, _) = run_upgrade(&root);
        let report = report.expect("the upgrade picks the journal up");
        assert!(report.failures.is_empty(), "{:?}", report.failures);

        // Everything is filed, and nothing is left loose or duplicated.
        assert!(track_dir(&root, &step_id).join("audio.wav").is_file());
        assert!(track_dir(&root, &hey_id).join("audio.wav").is_file());
        assert!(loose_songs(&root).unwrap().is_empty());
        assert_eq!(fs::read_dir(root.join(SONGS_DIR)).unwrap().count(), 2);

        let catalog = Catalog::open(&root).unwrap();
        let filed = catalog.tracks().unwrap();
        let playlists = catalog.playlists().unwrap();
        let listed = playlists.first().map(|list| list.track_ids.clone());

        let mut problems: Vec<String> = Vec::new();
        for (id, name) in [(&step_id, "15 Step"), (&hey_id, "Hey Jude")] {
            if catalog.track(id).unwrap().is_none() {
                problems.push(format!(
                    "{name} is filed at songs/{id}/audio.wav but has no catalog row"
                ));
            }
        }
        if filed.len() != 2 {
            problems.push(format!("the catalog describes {} songs, expected 2", filed.len()));
        }
        if report.songs != 2 {
            problems.push(format!("the report claims {} songs, expected 2", report.songs));
        }
        if listed != Some(vec![step_id.clone(), hey_id.clone()]) {
            problems.push(format!(
                "the playlist holds {listed:?}, expected {:?}",
                vec![step_id.clone(), hey_id.clone()]
            ));
        }
        if ids.len() != 2 {
            problems.push(format!("the remap was handed {} songs, expected 2", ids.len()));
        }
        if !track_dir(&root, &step_id).join("cover.jpg").is_file() {
            problems.push(
                "the interrupted song's cover never reached its folder; it is only in the backup"
                    .to_string(),
            );
        }
        assert!(
            problems.is_empty(),
            "an interrupted upgrade did not finish the job:\n{}",
            problems.join("\n")
        );
    }

    #[test]
    fn identical_audio_collapses_to_one_song_and_keeps_the_stray_file() {
        let root = legacy("duplicate");
        let kept = root.join(SONGS_DIR).join("song.wav");
        let stray = root.join(SONGS_DIR).join("song copy.wav");
        write_sine(&kept, 0.5, 1.0);
        // Byte for byte the same audio under another name.
        fs::copy(&kept, &stray).unwrap();
        let id = id_of(&kept);

        write_playlist(&root, "Both", &["songs/song.wav", "songs/song copy.wav"]);

        let (report, ids, _) = run_upgrade(&root);
        let report = report.expect("the upgrade runs");

        let catalog = Catalog::open(&root).unwrap();
        assert_eq!(catalog.tracks().unwrap().len(), 1, "the two files are one song");
        assert!(catalog.track(&id).unwrap().is_some());

        // Both old ids land on the one song that was kept.
        assert_eq!(ids.len(), 2);
        assert_eq!(ids.get(&identity::legacy_id("songs/song.wav")), Some(&id));
        assert_eq!(
            ids.get(&identity::legacy_id("songs/song copy.wav")),
            Some(&id)
        );

        // The stray file is kept, not deleted, and it is the same audio.
        let filed = fs::read(track_dir(&root, &id).join("audio.wav")).unwrap();
        let backup = PathBuf::from(&report.backup);
        let kept_as_stray: Vec<String> = ["song.wav", "song copy.wav"]
            .iter()
            .filter(|name| backup.join(name).is_file())
            .map(|name| (*name).to_string())
            .collect();
        assert_eq!(
            kept_as_stray.len(),
            1,
            "exactly one of the two identical files is kept in {}",
            report.backup
        );
        assert_eq!(fs::read(backup.join(&kept_as_stray[0])).unwrap(), filed);

        // The playlist listed the audio twice, and holds it twice.
        let playlists = catalog.playlists().unwrap();
        assert_eq!(playlists.len(), 1);
        assert_eq!(playlists[0].track_ids, vec![id.clone(), id.clone()]);
    }

    #[test]
    fn two_songs_with_the_same_title_but_different_audio_stay_two_songs() {
        let root = legacy("same-title");
        let one = root.join(SONGS_DIR).join("one.wav");
        let two = root.join(SONGS_DIR).join("two.wav");
        write_tagged_sine(&one, 0.5, 1.0, "Same Title", "Artist One", "Album One");
        write_tagged_sine(&two, 0.25, 1.0, "Same Title", "Artist Two", "Album Two");

        let one_id = id_of(&one);
        let two_id = id_of(&two);
        assert_ne!(one_id, two_id);

        let (report, ids, _) = run_upgrade(&root);
        assert_eq!(report.expect("the upgrade runs").songs, 2);

        let catalog = Catalog::open(&root).unwrap();
        assert_eq!(catalog.tracks().unwrap().len(), 2);

        let first = catalog.track(&one_id).unwrap().expect("the first is kept");
        let second = catalog.track(&two_id).unwrap().expect("the second is kept");
        assert_eq!(first.title, "Same Title");
        assert_eq!(second.title, "Same Title");
        assert_eq!(first.artist.as_deref(), Some("Artist One"));
        assert_eq!(second.artist.as_deref(), Some("Artist Two"));
        assert_ne!(first.id, second.id);

        assert!(track_dir(&root, &one_id).join("audio.wav").is_file());
        assert!(track_dir(&root, &two_id).join("audio.wav").is_file());
        assert_eq!(ids.len(), 2);
    }

    #[test]
    fn every_old_image_and_lyric_survives_the_upgrade() {
        let root = legacy("sweep");
        let one = root.join(SONGS_DIR).join("one.wav");
        let two = root.join(SONGS_DIR).join("two.wav");
        write_tagged_sine(&one, 0.5, 1.0, "One", "An Artist", "An Album");
        write_tagged_sine(&two, 0.25, 1.0, "Two", "An Artist", "An Album");

        let one_id = id_of(&one);
        let two_id = id_of(&two);

        let shared = b"shared cover bytes".to_vec();
        let orphan = b"an unreferenced cover".to_vec();
        let words = b"[00:01.00] one".to_vec();
        fs::write(root.join(LEGACY_ARTWORK_DIR).join("shared.jpg"), &shared).unwrap();
        fs::write(root.join(LEGACY_ARTWORK_DIR).join("nobody.jpg"), &orphan).unwrap();
        fs::write(root.join(LEGACY_LYRICS_DIR).join("one.lrc"), &words).unwrap();

        // One cover, linked to two songs.
        write_index(
            &root,
            &[
                ("songs/one.wav", "images/shared.jpg"),
                ("songs/two.wav", "images/shared.jpg"),
            ],
            &[("songs/one.wav", "lyrics/one.lrc")],
        );

        let (report, ..) = run_upgrade(&root);
        let report = report.expect("the upgrade runs");
        let backup = PathBuf::from(&report.backup);

        // The cover linked to two songs is beside both of them.
        assert_eq!(fs::read(track_dir(&root, &one_id).join("cover.jpg")).unwrap(), shared);
        assert_eq!(fs::read(track_dir(&root, &two_id).join("cover.jpg")).unwrap(), shared);
        // The original is in the backup rather than deleted.
        assert_eq!(fs::read(backup.join("orphans").join("shared.jpg")).unwrap(), shared);

        // Lyrics are beside their song, and in the backup as well.
        assert_eq!(fs::read(track_dir(&root, &one_id).join("lyrics.lrc")).unwrap(), words);
        assert_eq!(fs::read(backup.join("orphans").join("one.lrc")).unwrap(), words);

        // A file the index never mentioned is not thrown away either.
        assert_eq!(fs::read(backup.join("orphans").join("nobody.jpg")).unwrap(), orphan);

        assert!(!root.join(LEGACY_ARTWORK_DIR).exists());
        assert!(!root.join(LEGACY_LYRICS_DIR).exists());
    }

    #[test]
    fn a_playlist_entry_whose_file_is_gone_does_not_stop_the_upgrade() {
        let root = legacy("gone");
        let one = root.join(SONGS_DIR).join("one.wav");
        write_tagged_sine(&one, 0.5, 1.0, "One", "An Artist", "An Album");
        let one_id = id_of(&one);

        write_playlist(
            &root,
            "Mixed",
            &["songs/Gone.wav", "songs/one.wav", "songs/Also Gone.wav"],
        );

        let (report, ids, _) = run_upgrade(&root);
        let report = report.expect("the upgrade runs with a missing song in a playlist");
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert_eq!(report.playlists, 1);
        assert_eq!(ids.len(), 1);

        let catalog = Catalog::open(&root).unwrap();
        let playlists = catalog.playlists().unwrap();
        assert_eq!(playlists.len(), 1);
        assert_eq!(playlists[0].name, "Mixed");
        assert_eq!(playlists[0].track_ids, vec![one_id]);
    }

    #[test]
    fn a_library_already_in_the_new_shape_is_not_renumbered() {
        let root = std::env::temp_dir().join("wave-migration-new-shape");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(CONFIG_DIR)).unwrap();

        let id = "8f0e0e7a-2b3c-4d5e-8f90-1a2b3c4d5e6f".to_string();
        let dir = track_dir(&root, &id);
        fs::create_dir_all(&dir).unwrap();
        write_sine(&dir.join("audio.wav"), 0.5, 1.0);
        fs::write(dir.join("cover.jpg"), b"a cover".to_vec()).unwrap();

        let catalog = Catalog::open(&root).unwrap();
        let row = library::describe(&root, &id, &dir.join("audio.wav"), "one.wav").unwrap();
        assert_eq!(
            row.cover_path.as_deref(),
            Some(format!("songs/{id}/cover.jpg").as_str())
        );
        catalog.upsert_track(&row).unwrap();

        let outcome = upgrade(&root, &catalog, None, |_, _| {
            panic!("a library in the new shape has nothing to renumber")
        })
        .unwrap();

        assert!(outcome.is_none());
        assert!(dir.join("audio.wav").is_file());
        assert_eq!(fs::read_dir(root.join(SONGS_DIR)).unwrap().count(), 1);
        let tracks = catalog.tracks().unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].id, id);
        assert_eq!(
            catalog.meta(crate::catalog::LAYOUT_VERSION_KEY).as_deref(),
            Some(crate::catalog::LAYOUT_VERSION)
        );
    }

    #[test]
    fn an_index_entry_pointing_at_a_missing_file_is_not_a_failure() {
        let root = legacy("missing-sidecar");
        let one = root.join(SONGS_DIR).join("one.wav");
        write_tagged_sine(&one, 0.5, 1.0, "One", "An Artist", "An Album");
        let one_id = id_of(&one);

        write_index(
            &root,
            &[("songs/one.wav", "images/gone.jpg")],
            &[("songs/one.wav", "lyrics/gone.lrc")],
        );

        let (report, ..) = run_upgrade(&root);
        let report = report.expect("the upgrade runs");

        assert_eq!(report.songs, 1);
        assert_eq!(report.covers, 0);
        assert_eq!(report.lyrics, 0);
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert!(Catalog::open(&root).unwrap().track(&one_id).unwrap().is_some());
    }

    #[test]
    fn a_library_with_no_playlist_folder_upgrades() {
        let root = legacy("no-playlists");
        fs::remove_dir_all(root.join(LEGACY_PLAYLISTS_DIR)).unwrap();
        let one = root.join(SONGS_DIR).join("one.wav");
        write_tagged_sine(&one, 0.5, 1.0, "One", "An Artist", "An Album");
        let one_id = id_of(&one);

        let (report, ..) = run_upgrade(&root);
        let report = report.expect("the upgrade runs");

        assert_eq!(report.songs, 1);
        assert_eq!(report.playlists, 0);
        assert!(report.failures.is_empty(), "{:?}", report.failures);
        assert!(Catalog::open(&root).unwrap().playlists().unwrap().is_empty());
        assert!(track_dir(&root, &one_id).join("audio.wav").is_file());
    }

    #[test]
    fn a_playlist_that_cannot_be_read_is_reported_rather_than_invented() {
        let root = legacy("broken-playlist");
        let one = root.join(SONGS_DIR).join("one.wav");
        write_tagged_sine(&one, 0.5, 1.0, "One", "An Artist", "An Album");

        fs::write(
            root.join(LEGACY_PLAYLISTS_DIR).join("Broken.json"),
            b"not json at all".to_vec(),
        )
        .unwrap();

        let (report, ..) = run_upgrade(&root);
        let report = report.expect("the upgrade runs");

        assert_eq!(report.songs, 1);
        assert_eq!(report.playlists, 0);
        assert_eq!(report.failures.len(), 1, "{:?}", report.failures);
        assert!(
            report.failures[0].contains("Broken"),
            "{:?}",
            report.failures
        );
        assert!(Catalog::open(&root).unwrap().playlists().unwrap().is_empty());
    }

    #[test]
    fn the_old_layout_is_not_left_beside_the_new_one() {
        let root = legacy("leftovers");
        let one = root.join(SONGS_DIR).join("one.wav");
        write_tagged_sine(&one, 0.5, 1.0, "One", "An Artist", "An Album");
        write_index(&root, &[], &[]);
        write_loudness(&root, &[("songs/one.wav", -9.5, 0.98)]);
        write_playlist(&root, "Road trip", &["songs/one.wav"]);

        let (report, ..) = run_upgrade(&root);
        assert!(report.expect("the upgrade runs").songs == 1);

        assert!(!root.join(CONFIG_DIR).join(LEGACY_INDEX_FILE).exists());
        assert!(!root.join(CONFIG_DIR).join(LEGACY_LOUDNESS_FILE).exists());

        let left = fs::read_dir(root.join(LEGACY_PLAYLISTS_DIR))
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        assert!(
            !root.join(LEGACY_PLAYLISTS_DIR).exists(),
            "playlists/ is still in the library, holding {left:?}"
        );
    }

    #[test]
    fn a_migrated_cover_and_lyrics_are_recorded_in_the_catalog() {
        let root = legacy("sidecars-linked");
        let one = root.join(SONGS_DIR).join("one.wav");
        write_tagged_sine(&one, 0.5, 1.0, "One", "An Artist", "An Album");
        let one_id = id_of(&one);

        fs::write(
            root.join(LEGACY_ARTWORK_DIR).join("cover.jpg"),
            b"the cover bytes".to_vec(),
        )
        .unwrap();
        fs::write(
            root.join(LEGACY_LYRICS_DIR).join("one.lrc"),
            b"[00:01.00] one".to_vec(),
        )
        .unwrap();
        write_index(
            &root,
            &[("songs/one.wav", "images/cover.jpg")],
            &[("songs/one.wav", "lyrics/one.lrc")],
        );

        let (report, ..) = run_upgrade(&root);
        let report = report.expect("the upgrade runs");
        assert_eq!(report.covers, 1);
        assert_eq!(report.lyrics, 1);

        assert!(track_dir(&root, &one_id).join("cover.jpg").is_file());
        assert!(track_dir(&root, &one_id).join("lyrics.lrc").is_file());

        let catalog = Catalog::open(&root).unwrap();
        let row = catalog.track(&one_id).unwrap().expect("the song is in the catalog");
        assert_eq!(
            row.cover_path.as_deref(),
            Some(format!("songs/{one_id}/cover.jpg").as_str())
        );
        assert_eq!(
            row.lyrics_path.as_deref(),
            Some(format!("songs/{one_id}/lyrics.lrc").as_str())
        );
    }
}
