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

/// The old library's own records, all of which the catalog replaces.
const LEGACY_INDEX_FILE: &str = "index.json";
const LEGACY_LOUDNESS_FILE: &str = "loudness.json";
const LEGACY_PLAYLISTS_DIR: &str = "playlists";
const LEGACY_ARTWORK_DIR: &str = "images";
const LEGACY_LYRICS_DIR: &str = "lyrics";

const JOURNAL_FILE: &str = "migration.json";

/// The old index: a song's path, and the copies filed for it.
#[derive(Debug, Default, Deserialize)]
struct LegacyIndex {
    #[serde(default)]
    songs: HashMap<String, String>,
    #[serde(default)]
    lyrics: HashMap<String, String>,
}

/// The old loudness readings, by song path.
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

/// One song's move, recorded so the upgrade can be picked up again.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PlannedMove {
    /// The id the old library minted from the song's path.
    old_id: String,
    /// The id the song has now.
    new_id: String,
    /// Where the audio is, relative to the library root.
    from: String,
    /// Where it is going, relative to the library root.
    to: String,
    /// The name the file arrived under.
    name: String,
    /// True when another file already holds this audio, so there is nothing to
    /// move and this song's history belongs on that one.
    duplicate: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Journal {
    /// Where the old metadata was copied before anything was touched.
    backup: String,
    moves: Vec<PlannedMove>,
}

/// What the upgrade did.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub songs: usize,
    pub covers: usize,
    pub lyrics: usize,
    pub playlists: usize,
    /// Where the old records were put, in case anything has to be checked.
    pub backup: String,
    pub failures: Vec<String>,
}

/// Upgrades a library built by an older version, once. Returns `None` when
/// there is nothing to do.
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
                // Nothing to upgrade: either a library that has never held a
                // song, or one already in the new shape.
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

    // The layout is recorded before the journal goes, so a crash in between
    // leaves a journal that is simply ignored.
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

    // Where each song's history now belongs, old id to new id.
    let mut ids: HashMap<String, String> = HashMap::new();
    for planned in &journal.moves {
        ids.insert(planned.old_id.clone(), planned.new_id.clone());
    }

    // The move comes first, so a song is described from where it actually is.
    for planned in &journal.moves {
        if planned.duplicate {
            // The audio is already here under another name: this song's likes,
            // playlists and history belong on the copy that was kept.
            let stray = root.join(&planned.from);
            if stray.is_file() {
                let _ = move_file(&stray, &backup.join(&planned.name));
            }
            continue;
        }

        let target = root.join(&planned.to);
        if target.is_file() {
            continue; // already moved by an earlier run
        }
        let source = root.join(&planned.from);
        if !source.is_file() {
            report
                .failures
                .push(format!("{} is missing", planned.name));
            continue;
        }

        let dir = track_dir(root, &planned.new_id);
        fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        move_file(&source, &target)?;

        match library::describe(root, &planned.new_id, &target, &planned.name) {
            Ok(mut row) => {
                row.added_at = identity::now_ms();
                catalog.upsert_track(&row)?;
                report.songs += 1;

                if let Some(reading) = loudness.songs.get(&planned.from) {
                    catalog.set_loudness(&planned.new_id, reading.lufs, reading.peak, row.bytes)?;
                }
                if copy_cover(&index, root, planned)? {
                    report.covers += 1;
                }
                if copy_lyrics(&index, root, planned)? {
                    report.lyrics += 1;
                }
            }
            Err(error) => report.failures.push(format!("{}: {error}", planned.name)),
        }
    }

    let (playlists, playlist_ids) = legacy_playlists(root, &ids)?;
    if !playlists.is_empty() {
        catalog.insert_playlists(&playlists)?;
        report.playlists = playlists.len();
    }

    // Everything that was filed by name is renumbered, so likes, artwork
    // colours, the queue and the listening record survive the upgrade.
    remap(&ids, &playlist_ids)?;

    sweep(root, &backup)?;
    Ok(report)
}

/// Copies the records the catalog replaces into the backup folder, before
/// anything is moved or deleted.
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

/// Files sitting directly in the songs folder, which is where the old layout
/// kept them.
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

/// Works out where every loose song is going, before anything moves.
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

        // The old id was a hash of the path the song lived at, which is exactly
        // what has to be reproduced to find its likes and its playlists.
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

/// Files the cover the old index linked, beside the song it belongs to.
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

    // Copied rather than moved: the old index could point two songs at one
    // cover, and whatever is left behind goes to the backup.
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

/// The old playlist files, with their paths turned into the ids the songs have
/// now. Returns the playlists and the name-to-id map the queue is renumbered by.
fn legacy_playlists(
    root: &Path,
    ids: &HashMap<String, String>,
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

        let files: Vec<String> = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();

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
            track_ids,
            created_at,
        });
    }

    playlists.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok((playlists, names))
}

/// The id a playlist from the old library gets. Derived from its name, so a
/// migration that is run twice does not leave two copies of it behind.
fn playlist_id(name: &str) -> String {
    identity::id_for_hash(&format!("wave:playlist:{}", name.to_lowercase()))
}

/// Puts whatever is left of the old layout into the backup, so nothing is lost
/// even if the index did not mention it.
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
    let _ = fs::remove_dir(root.join(LEGACY_PLAYLISTS_DIR));

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

/// Where the old records are kept, named by the moment the upgrade ran.
fn backup_dir(root: &Path) -> Result<PathBuf, String> {
    let dir = root
        .join(CONFIG_DIR)
        .join(format!("legacy-{}", identity::now_ms()));
    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// A rename where that works, and a copy where it does not, so a library on
/// another volume is still upgradable.
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

        let (playlists, names) = legacy_playlists(&root, &ids).unwrap();

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
