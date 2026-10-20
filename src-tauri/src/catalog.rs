use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::identity;
use crate::library::CONFIG_DIR;
use crate::state::{PendingTrack, Playlist, GENERATED_KIND};

pub const CATALOG_FILE: &str = "library.db";

const SCHEMA_VERSION: i64 = 4;

pub const LAYOUT_VERSION_KEY: &str = "layout_version";
pub const LAYOUT_VERSION: &str = "2";

const TRACK_COLUMNS: &str = "id, rel_path, original_name, bytes, modified_ms, content_hash, \
     title, artist, album, album_artist, track_no, disc_no, year, genre, duration_ms, codec, \
     bitrate, sample_rate, has_embedded_art, cover_path, lyrics_path, lufs, peak, \
     loudness_bytes, missing, added_at, updated_at";

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS tracks (
  id               TEXT PRIMARY KEY,
  rel_path         TEXT NOT NULL,
  original_name    TEXT NOT NULL DEFAULT '',
  bytes            INTEGER NOT NULL DEFAULT 0,
  modified_ms      INTEGER NOT NULL DEFAULT 0,
  content_hash     TEXT,
  title            TEXT NOT NULL DEFAULT '',
  artist           TEXT,
  album            TEXT,
  album_artist     TEXT,
  track_no         INTEGER,
  disc_no          INTEGER,
  year             INTEGER,
  genre            TEXT,
  duration_ms      INTEGER NOT NULL DEFAULT 0,
  codec            TEXT NOT NULL DEFAULT '',
  bitrate          INTEGER,
  sample_rate      INTEGER,
  has_embedded_art INTEGER NOT NULL DEFAULT 0,
  cover_path       TEXT,
  lyrics_path      TEXT,
  lufs             REAL,
  peak             REAL,
  loudness_bytes   INTEGER,
  missing          INTEGER NOT NULL DEFAULT 0,
  added_at         INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS tracks_rel_path ON tracks (rel_path);
CREATE INDEX IF NOT EXISTS tracks_content_hash ON tracks (content_hash);
CREATE TABLE IF NOT EXISTS playlists (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'custom',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
  track_id    TEXT NOT NULL,
  position    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, position)
);
CREATE INDEX IF NOT EXISTS playlist_tracks_track ON playlist_tracks (track_id);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

const PENDING_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS pending_tracks (
  id           TEXT PRIMARY KEY,
  playlist_id  TEXT NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT '',
  artists      TEXT NOT NULL DEFAULT '',
  album        TEXT NOT NULL DEFAULT '',
  album_artist TEXT NOT NULL DEFAULT '',
  genres       TEXT NOT NULL DEFAULT '',
  isrc         TEXT NOT NULL DEFAULT '',
  cover_url    TEXT,
  cover_path   TEXT,
  release_date TEXT NOT NULL DEFAULT '',
  track_number INTEGER,
  disc_number  INTEGER,
  source       TEXT NOT NULL DEFAULT '',
  source_id    TEXT NOT NULL DEFAULT '',
  added_at     INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS pending_tracks_playlist ON pending_tracks (playlist_id);
"#;

const PENDING_COLUMNS: &str = "id, title, artists, album, album_artist, genres, isrc, cover_url, \
     cover_path, release_date, track_number, disc_number, source, source_id, duration_ms";

#[derive(Debug, Clone, Default)]
pub struct TrackRow {
    pub id: String,
    /// The audio file, relative to the library root.
    pub rel_path: String,
    /// The name the file arrived under. Never used to identify anything.
    pub original_name: String,
    pub bytes: u64,
    pub modified_ms: i64,
    pub content_hash: Option<String>,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track_no: Option<u32>,
    pub disc_no: Option<u32>,
    pub year: Option<u16>,
    pub genre: Option<String>,
    pub duration_ms: u64,
    pub codec: String,
    pub bitrate: Option<u32>,
    pub sample_rate: Option<u32>,
    pub has_embedded_art: bool,
    pub cover_path: Option<String>,
    pub lyrics_path: Option<String>,
    pub lufs: Option<f32>,
    pub peak: Option<f32>,
    /// The size the loudness reading was taken from.
    pub loudness_bytes: Option<u64>,
    /// Set when the audio is not where the row expects it. The row stays, so
    /// likes, playlists and history survive a file being moved away.
    pub missing: bool,
    pub added_at: i64,
    pub updated_at: i64,
}

pub struct Catalog {
    root: PathBuf,
    path: PathBuf,
    connection: Mutex<Connection>,
}

impl Catalog {
    pub fn open(root: &Path) -> Result<Self, String> {
        let dir = root.join(CONFIG_DIR);
        std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        let path = dir.join(CATALOG_FILE);

        let connection = Connection::open(&path)
            .map_err(|e| format!("could not open {}: {e}", path.display()))?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| format!("could not prepare {}: {e}", path.display()))?;

        let catalog = Self {
            root: root.to_path_buf(),
            path,
            connection: Mutex::new(connection),
        };
        catalog.create_schema()?;
        Ok(catalog)
    }

    /// A throwaway catalog, so the app still runs when the real one cannot be
    /// opened. Nothing written to it is kept.
    pub fn in_memory() -> Result<Self, String> {
        let connection =
            Connection::open_in_memory().map_err(|e| format!("could not open a catalog: {e}"))?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| format!("could not prepare a catalog: {e}"))?;

        let catalog = Self {
            root: PathBuf::new(),
            path: PathBuf::new(),
            connection: Mutex::new(connection),
        };
        catalog.create_schema()?;
        Ok(catalog)
    }

    fn create_schema(&self) -> Result<(), String> {
        let connection = self.guard();
        let found: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| format!("could not read the catalog version: {e}"))?;

        if found == 0 {
            connection
                .execute_batch(&format!("{SCHEMA}{PENDING_TABLE}"))
                .map_err(|e| format!("could not create the catalog: {e}"))?;
            return stamp(&connection);
        }

        if found < SCHEMA_VERSION {
            if !has_column(&connection, "playlists", "kind") {
                connection
                    .execute_batch(
                        "ALTER TABLE playlists ADD COLUMN kind TEXT NOT NULL DEFAULT 'custom'",
                    )
                    .map_err(|e| format!("could not add the playlist kind: {e}"))?;
            }
            connection
                .execute_batch(PENDING_TABLE)
                .map_err(|e| format!("could not add the waiting songs: {e}"))?;
            if !has_column(&connection, "pending_tracks", "cover_path") {
                connection
                    .execute_batch("ALTER TABLE pending_tracks ADD COLUMN cover_path TEXT")
                    .map_err(|e| format!("could not add the waiting covers: {e}"))?;
            }
            if !has_column(&connection, "pending_tracks", "duration_ms") {
                connection
                    .execute_batch("ALTER TABLE pending_tracks ADD COLUMN duration_ms INTEGER")
                    .map_err(|e| format!("could not add the waiting lengths: {e}"))?;
            }
            return stamp(&connection);
        }

        Ok(())
    }

    fn guard(&self) -> MutexGuard<'_, Connection> {
        // A poisoned lock only means another command panicked mid-write.
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn file_size(&self) -> u64 {
        std::fs::metadata(&self.path).map(|meta| meta.len()).unwrap_or(0)
    }

    pub fn meta(&self, key: &str) -> Option<String> {
        self.guard()
            .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |row| {
                row.get(0)
            })
            .optional()
            .ok()
            .flatten()
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), String> {
        self.guard()
            .execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map(|_| ())
            .map_err(|e| format!("could not record {key}: {e}"))
    }

    pub fn tracks(&self) -> Result<Vec<TrackRow>, String> {
        self.query_tracks(
            &format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE missing = 0"),
            params![],
        )
    }

    pub fn track(&self, id: &str) -> Result<Option<TrackRow>, String> {
        Ok(self
            .query_tracks(
                &format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE id = ?1"),
                params![id],
            )?
            .into_iter()
            .next())
    }

    /// The row holding this audio, preferring one whose file is still there.
    pub fn find_by_hash(&self, hash: &str) -> Result<Option<TrackRow>, String> {
        Ok(self
            .query_tracks(
                &format!(
                    "SELECT {TRACK_COLUMNS} FROM tracks WHERE content_hash = ?1 \
                     ORDER BY missing ASC, added_at ASC LIMIT 1"
                ),
                params![hash],
            )?
            .into_iter()
            .next())
    }

    /// Songs sharing these tags, which is what makes an import a near miss
    /// rather than a duplicate.
    pub fn find_by_tags(&self, title: &str, artist: &str, album: &str) -> Result<Vec<TrackRow>, String> {
        self.query_tracks(
            &format!(
                "SELECT {TRACK_COLUMNS} FROM tracks \
                 WHERE missing = 0 AND lower(trim(title)) = ?1 \
                   AND lower(trim(coalesce(artist, ''))) = ?2 \
                   AND lower(trim(coalesce(album, ''))) = ?3"
            ),
            params![fold(title), fold(artist), fold(album)],
        )
    }

    fn query_tracks(&self, sql: &str, parameters: impl rusqlite::Params) -> Result<Vec<TrackRow>, String> {
        let connection = self.guard();
        let mut statement = connection
            .prepare(sql)
            .map_err(|e| format!("could not read the catalog: {e}"))?;
        let rows = statement
            .query_map(parameters, read_track)
            .map_err(|e| format!("could not read the catalog: {e}"))?;

        let mut tracks = Vec::new();
        for row in rows {
            tracks.push(row.map_err(|e| format!("could not read a catalog row: {e}"))?);
        }
        Ok(tracks)
    }

    pub fn upsert_track(&self, row: &TrackRow) -> Result<(), String> {
        self.upsert_tracks(std::slice::from_ref(row))
    }

    pub fn upsert_tracks(&self, rows: &[TrackRow]) -> Result<(), String> {
        let mut connection = self.guard();
        let transaction = connection
            .transaction()
            .map_err(|e| format!("could not start a catalog write: {e}"))?;

        for row in rows {
            write_row(&transaction, row)?;
        }

        transaction
            .commit()
            .map_err(|e| format!("could not finish a catalog write: {e}"))
    }

    /// Every song is marked gone, then each one the scan found is written back,
    /// in one transaction. A song the scan did not see keeps its row.
    pub fn sync_scan(&self, rows: &[TrackRow]) -> Result<(), String> {
        let mut connection = self.guard();
        let transaction = connection
            .transaction()
            .map_err(|e| format!("could not start a catalog write: {e}"))?;

        transaction
            .execute("UPDATE tracks SET missing = 1 WHERE missing = 0", [])
            .map_err(|e| format!("could not update the catalog: {e}"))?;

        for row in rows {
            write_row(&transaction, row)?;
        }

        transaction
            .commit()
            .map_err(|e| format!("could not finish a catalog write: {e}"))
    }

    pub fn set_cover(&self, id: &str, cover: Option<&str>) -> Result<(), String> {
        self.guard()
            .execute(
                "UPDATE tracks SET cover_path = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, cover, identity::now_ms()],
            )
            .map(|_| ())
            .map_err(|e| format!("could not link a cover: {e}"))
    }

    pub fn set_lyrics(&self, id: &str, lyrics: Option<&str>) -> Result<(), String> {
        self.guard()
            .execute(
                "UPDATE tracks SET lyrics_path = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, lyrics, identity::now_ms()],
            )
            .map(|_| ())
            .map_err(|e| format!("could not link lyrics: {e}"))
    }

    pub fn set_loudness(&self, id: &str, lufs: f32, peak: f32, bytes: u64) -> Result<(), String> {
        self.guard()
            .execute(
                "UPDATE tracks SET lufs = ?2, peak = ?3, loudness_bytes = ?4 WHERE id = ?1",
                params![id, f64::from(lufs), f64::from(peak), bytes as i64],
            )
            .map(|_| ())
            .map_err(|e| format!("could not save a loudness reading: {e}"))
    }

    pub fn delete_tracks(&self, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }

        let mut connection = self.guard();
        let transaction = connection
            .transaction()
            .map_err(|e| format!("could not start a catalog write: {e}"))?;

        for id in ids {
            transaction
                .execute("DELETE FROM playlist_tracks WHERE track_id = ?1", params![id])
                .map_err(|e| format!("could not drop a playlist entry: {e}"))?;
            transaction
                .execute("DELETE FROM tracks WHERE id = ?1", params![id])
                .map_err(|e| format!("could not drop a song: {e}"))?;
        }

        transaction
            .commit()
            .map_err(|e| format!("could not finish a catalog write: {e}"))
    }

    /// Songs present, and rows waiting for their audio to come back.
    pub fn counts(&self) -> (usize, usize) {
        let connection = self.guard();
        let present: i64 = connection
            .query_row("SELECT COUNT(*) FROM tracks WHERE missing = 0", [], |row| row.get(0))
            .unwrap_or(0);
        let missing: i64 = connection
            .query_row("SELECT COUNT(*) FROM tracks WHERE missing = 1", [], |row| row.get(0))
            .unwrap_or(0);
        (present as usize, missing as usize)
    }

    pub fn playlists(&self) -> Result<Vec<Playlist>, String> {
        let connection = self.guard();

        let mut rows: Vec<(String, String, String, i64)> = Vec::new();
        {
            let mut statement = connection
                .prepare("SELECT id, name, kind, created_at FROM playlists")
                .map_err(|e| format!("could not read the playlists: {e}"))?;
            let found = statement
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .map_err(|e| format!("could not read the playlists: {e}"))?;
            for row in found {
                rows.push(row.map_err(|e| format!("could not read a playlist: {e}"))?);
            }
        }

        let mut contents: HashMap<String, Vec<String>> = HashMap::new();
        {
            let mut statement = connection
                .prepare(
                    "SELECT playlist_id, track_id FROM playlist_tracks \
                     ORDER BY playlist_id, position",
                )
                .map_err(|e| format!("could not read the playlists: {e}"))?;
            let found = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| format!("could not read the playlists: {e}"))?;
            for row in found {
                let (playlist_id, entry) =
                    row.map_err(|e| format!("could not read a playlist entry: {e}"))?;
                contents.entry(playlist_id).or_default().push(entry);
            }
        }

        let present = present_ids(&connection)?;

        let mut waiting: HashMap<String, PendingTrack> = HashMap::new();
        {
            let mut statement = connection
                .prepare(&format!("SELECT {PENDING_COLUMNS} FROM pending_tracks"))
                .map_err(|e| format!("could not read the waiting songs: {e}"))?;
            let found = statement
                .query_map([], read_pending)
                .map_err(|e| format!("could not read the waiting songs: {e}"))?;
            for row in found {
                let track = row.map_err(|e| format!("could not read a waiting song: {e}"))?;
                waiting.insert(track.id.clone(), track);
            }
        }

        let mut playlists: Vec<Playlist> = rows
            .into_iter()
            .map(|(id, name, kind, created_at)| {
                let mut entries = Vec::new();
                let mut track_ids = Vec::new();
                let mut pending = Vec::new();

                for entry in contents.remove(&id).unwrap_or_default() {
                    if let Some(track) = waiting.get(&entry) {
                        entries.push(entry);
                        let mut track = track.clone();
                        track.cover_path = absolute(&self.root, track.cover_path.as_deref());
                        pending.push(track);
                    } else if present.contains(&entry) {
                        entries.push(entry.clone());
                        track_ids.push(entry);
                    }
                }

                Playlist {
                    id,
                    name,
                    track_ids,
                    created_at: created_at.max(0) as u64,
                    kind,
                    entries,
                    pending,
                }
            })
            .collect();

        playlists.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(playlists)
    }

    /// Names are not identities any more, but two playlists nobody can tell
    /// apart are still worth refusing.
    pub fn playlist_name_taken(&self, name: &str, except: Option<&str>) -> bool {
        self.guard()
            .query_row(
                "SELECT id FROM playlists WHERE lower(trim(name)) = ?1",
                params![fold(name)],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
            .is_some_and(|found| Some(found.as_str()) != except)
    }

    pub fn create_playlist(&self, name: &str) -> Result<String, String> {
        let id = identity::new_id();
        let now = identity::now_ms();
        self.guard()
            .execute(
                "INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
                params![id, name, now],
            )
            .map_err(|e| format!("could not create the playlist: {e}"))?;
        Ok(id)
    }

    pub fn rename_playlist(&self, id: &str, name: &str) -> Result<(), String> {
        let changed = self
            .guard()
            .execute(
                "UPDATE playlists SET name = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, name, identity::now_ms()],
            )
            .map_err(|e| format!("could not rename the playlist: {e}"))?;

        if changed == 0 {
            return Err("that playlist is gone".to_string());
        }
        Ok(())
    }

    pub fn delete_playlist(&self, id: &str) -> Result<(), String> {
        // The entries go with it, through `ON DELETE CASCADE`.
        self.guard()
            .execute("DELETE FROM playlists WHERE id = ?1", params![id])
            .map(|_| ())
            .map_err(|e| format!("could not delete the playlist: {e}"))
    }

    /// The songs a playlist holds, including any the library no longer has.
    /// Only the editing commands use this; readers get the filtered list.
    pub fn playlist_entries(&self, id: &str) -> Result<Vec<String>, String> {
        let connection = self.guard();
        let mut statement = connection
            .prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position")
            .map_err(|e| format!("could not read the playlist: {e}"))?;
        let rows = statement
            .query_map(params![id], |row| row.get::<_, String>(0))
            .map_err(|e| format!("could not read the playlist: {e}"))?;

        let mut tracks = Vec::new();
        for row in rows {
            tracks.push(row.map_err(|e| format!("could not read a playlist entry: {e}"))?);
        }
        Ok(tracks)
    }

    pub fn set_playlist_entries(&self, id: &str, track_ids: &[String]) -> Result<(), String> {
        let mut connection = self.guard();
        let transaction = connection
            .transaction()
            .map_err(|e| format!("could not start a catalog write: {e}"))?;

        write_entries(&transaction, id, track_ids)?;

        transaction
            .execute(
                "UPDATE playlists SET updated_at = ?2 WHERE id = ?1",
                params![id, identity::now_ms()],
            )
            .map_err(|e| format!("could not stamp the playlist: {e}"))?;

        transaction
            .commit()
            .map_err(|e| format!("could not finish a catalog write: {e}"))
    }

    /// The songs a playlist is still waiting on.
    pub fn pending_tracks(&self, playlist_id: &str) -> Result<Vec<PendingTrack>, String> {
        let connection = self.guard();
        let mut statement = connection
            .prepare(&format!(
                "SELECT {PENDING_COLUMNS} FROM pending_tracks WHERE playlist_id = ?1 \
                 ORDER BY added_at, id"
            ))
            .map_err(|e| format!("could not read the waiting songs: {e}"))?;
        let rows = statement
            .query_map(params![playlist_id], read_pending)
            .map_err(|e| format!("could not read the waiting songs: {e}"))?;

        let mut found = Vec::new();
        for row in rows {
            let mut track = row.map_err(|e| format!("could not read a waiting song: {e}"))?;
            track.cover_path = absolute(&self.root, track.cover_path.as_deref());
            found.push(track);
        }
        Ok(found)
    }

    /// Writes a generated playlist and its waiting songs in one go, so a
    /// half-written playlist can never be read.
    pub fn create_generated_playlist(
        &self,
        name: &str,
        entries: &[String],
        pending: &[PendingTrack],
    ) -> Result<String, String> {
        let id = identity::new_id();
        let now = identity::now_ms();
        let mut connection = self.guard();
        let transaction = connection
            .transaction()
            .map_err(|e| format!("could not start a catalog write: {e}"))?;

        transaction
            .execute(
                "INSERT INTO playlists (id, name, kind, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                params![id, name, GENERATED_KIND, now],
            )
            .map_err(|e| format!("could not create the playlist: {e}"))?;

        write_entries(&transaction, &id, entries)?;
        for track in pending {
            write_pending(&transaction, &id, track)?;
        }

        transaction
            .commit()
            .map_err(|e| format!("could not finish a catalog write: {e}"))?;
        Ok(id)
    }

    /// Rewrites a playlist's entries and drops the waiting songs they no longer
    /// need, in one write.
    pub fn resolve_pending(
        &self,
        id: &str,
        entries: &[String],
        resolved: &[String],
    ) -> Result<(), String> {
        let mut connection = self.guard();
        let transaction = connection
            .transaction()
            .map_err(|e| format!("could not start a catalog write: {e}"))?;

        write_entries(&transaction, id, entries)?;

        for pending_id in resolved {
            transaction
                .execute(
                    "DELETE FROM pending_tracks WHERE playlist_id = ?1 AND id = ?2",
                    params![id, pending_id],
                )
                .map_err(|e| format!("could not drop a waiting song: {e}"))?;
        }

        transaction
            .execute(
                "UPDATE playlists SET updated_at = ?2 WHERE id = ?1",
                params![id, identity::now_ms()],
            )
            .map_err(|e| format!("could not stamp the playlist: {e}"))?;

        transaction
            .commit()
            .map_err(|e| format!("could not finish a catalog write: {e}"))
    }

    pub fn add_to_playlist(&self, id: &str, track_ids: &[String]) -> Result<(), String> {
        let mut entries = self.playlist_entries(id)?;
        for track_id in track_ids {
            if !entries.contains(track_id) {
                entries.push(track_id.clone());
            }
        }
        self.set_playlist_entries(id, &entries)
    }

    pub fn remove_from_playlist(&self, id: &str, track_ids: &[String]) -> Result<(), String> {
        let entries: Vec<String> = self
            .playlist_entries(id)?
            .into_iter()
            .filter(|track_id| !track_ids.contains(track_id))
            .collect();
        self.set_playlist_entries(id, &entries)
    }

    /// Writes playlists wholesale, for the migration.
    pub fn insert_playlists(&self, playlists: &[Playlist]) -> Result<(), String> {
        let mut connection = self.guard();
        let transaction = connection
            .transaction()
            .map_err(|e| format!("could not start a catalog write: {e}"))?;

        for playlist in playlists {
            transaction
                .execute(
                    "INSERT INTO playlists (id, name, kind, created_at, updated_at) \
                     VALUES (?1, ?2, ?3, ?4, ?4) \
                     ON CONFLICT(id) DO UPDATE SET name = excluded.name",
                    params![
                        playlist.id,
                        playlist.name,
                        playlist.kind,
                        playlist.created_at as i64
                    ],
                )
                .map_err(|e| format!("could not write a playlist: {e}"))?;

            transaction
                .execute(
                    "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
                    params![playlist.id],
                )
                .map_err(|e| format!("could not rewrite a playlist: {e}"))?;

            for (position, track_id) in playlist.track_ids.iter().enumerate() {
                transaction
                    .execute(
                        "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
                        params![playlist.id, track_id, position as i64],
                    )
                    .map_err(|e| format!("could not write a playlist entry: {e}"))?;
            }
        }

        transaction
            .commit()
            .map_err(|e| format!("could not finish a catalog write: {e}"))
    }
}

/// Case and stray spacing are not differences between two songs.
fn fold(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// One row written. The loudness columns are absent from both the insert and the
/// update, so writing a row can never wipe a reading taken earlier.
fn write_row(transaction: &rusqlite::Transaction<'_>, row: &TrackRow) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO tracks (
                id, rel_path, original_name, bytes, modified_ms, content_hash, title,
                artist, album, album_artist, track_no, disc_no, year, genre, duration_ms,
                codec, bitrate, sample_rate, has_embedded_art, cover_path, lyrics_path,
                missing, added_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24
             )
             ON CONFLICT(id) DO UPDATE SET
                rel_path = excluded.rel_path,
                original_name = excluded.original_name,
                bytes = excluded.bytes,
                modified_ms = excluded.modified_ms,
                content_hash = excluded.content_hash,
                title = excluded.title,
                artist = excluded.artist,
                album = excluded.album,
                album_artist = excluded.album_artist,
                track_no = excluded.track_no,
                disc_no = excluded.disc_no,
                year = excluded.year,
                genre = excluded.genre,
                duration_ms = excluded.duration_ms,
                codec = excluded.codec,
                bitrate = excluded.bitrate,
                sample_rate = excluded.sample_rate,
                has_embedded_art = excluded.has_embedded_art,
                cover_path = excluded.cover_path,
                lyrics_path = excluded.lyrics_path,
                missing = excluded.missing,
                updated_at = excluded.updated_at",
            params![
                row.id,
                row.rel_path,
                row.original_name,
                row.bytes as i64,
                row.modified_ms,
                row.content_hash,
                row.title,
                row.artist,
                row.album,
                row.album_artist,
                row.track_no.map(i64::from),
                row.disc_no.map(i64::from),
                row.year.map(i64::from),
                row.genre,
                row.duration_ms as i64,
                row.codec,
                row.bitrate.map(i64::from),
                row.sample_rate.map(i64::from),
                i64::from(row.has_embedded_art),
                row.cover_path,
                row.lyrics_path,
                i64::from(row.missing),
                row.added_at,
                row.updated_at,
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("could not write {}: {e}", row.title))
}

fn read_track(row: &Row<'_>) -> rusqlite::Result<TrackRow> {
    Ok(TrackRow {
        id: row.get(0)?,
        rel_path: row.get(1)?,
        original_name: row.get(2)?,
        bytes: row.get::<_, i64>(3)? as u64,
        modified_ms: row.get(4)?,
        content_hash: row.get(5)?,
        title: row.get(6)?,
        artist: row.get(7)?,
        album: row.get(8)?,
        album_artist: row.get(9)?,
        track_no: row.get::<_, Option<i64>>(10)?.map(|value| value as u32),
        disc_no: row.get::<_, Option<i64>>(11)?.map(|value| value as u32),
        year: row.get::<_, Option<i64>>(12)?.map(|value| value as u16),
        genre: row.get(13)?,
        duration_ms: row.get::<_, i64>(14)? as u64,
        codec: row.get(15)?,
        bitrate: row.get::<_, Option<i64>>(16)?.map(|value| value as u32),
        sample_rate: row.get::<_, Option<i64>>(17)?.map(|value| value as u32),
        has_embedded_art: row.get::<_, i64>(18)? != 0,
        cover_path: row.get(19)?,
        lyrics_path: row.get(20)?,
        lufs: row.get::<_, Option<f64>>(21)?.map(|value| value as f32),
        peak: row.get::<_, Option<f64>>(22)?.map(|value| value as f32),
        loudness_bytes: row.get::<_, Option<i64>>(23)?.map(|value| value as u64),
        missing: row.get::<_, i64>(24)? != 0,
        added_at: row.get(25)?,
        updated_at: row.get(26)?,
    })
}

fn read_pending(row: &Row<'_>) -> rusqlite::Result<PendingTrack> {
    Ok(PendingTrack {
        id: row.get(0)?,
        title: row.get(1)?,
        artists: read_list(row.get(2)?),
        album: row.get(3)?,
        album_artist: row.get(4)?,
        genres: read_list(row.get(5)?),
        isrc: row.get(6)?,
        cover_url: row.get(7)?,
        cover_path: row.get(8)?,
        release_date: row.get(9)?,
        track_number: row.get::<_, Option<i64>>(10)?.map(|value| value as u32),
        disc_number: row.get::<_, Option<i64>>(11)?.map(|value| value as u32),
        source: row.get(12)?,
        source_id: row.get(13)?,
        duration_ms: row.get::<_, Option<i64>>(14)?.map(|value| value as u64),
    })
}

fn absolute(root: &Path, relative: Option<&str>) -> Option<String> {
    relative.map(|path| root.join(path).to_string_lossy().into_owned())
}

/// The lists are stored as JSON, so a genre holding a comma survives.
fn read_list(text: String) -> Vec<String> {
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_list(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".to_string())
}

/// The entries of a playlist, rewritten in one go.
fn write_entries(
    transaction: &rusqlite::Transaction<'_>,
    id: &str,
    entries: &[String],
) -> Result<(), String> {
    transaction
        .execute("DELETE FROM playlist_tracks WHERE playlist_id = ?1", params![id])
        .map_err(|e| format!("could not rewrite the playlist: {e}"))?;

    for (position, entry) in entries.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
                params![id, entry, position as i64],
            )
            .map_err(|e| format!("could not write the playlist: {e}"))?;
    }

    Ok(())
}

fn write_pending(
    transaction: &rusqlite::Transaction<'_>,
    playlist_id: &str,
    track: &PendingTrack,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO pending_tracks (id, playlist_id, title, artists, album, album_artist, \
             genres, isrc, cover_url, cover_path, release_date, track_number, disc_number, source, \
             source_id, added_at, duration_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                track.id,
                playlist_id,
                track.title,
                write_list(&track.artists),
                track.album,
                track.album_artist,
                write_list(&track.genres),
                track.isrc,
                track.cover_url,
                track.cover_path,
                track.release_date,
                track.track_number.map(i64::from),
                track.disc_number.map(i64::from),
                track.source,
                track.source_id,
                identity::now_ms(),
                track.duration_ms.map(|value| value as i64),
            ],
        )
        .map(|_| ())
        .map_err(|e| format!("could not write a waiting song: {e}"))
}

/// The library songs whose audio is still where the row expects it.
fn present_ids(connection: &Connection) -> Result<HashSet<String>, String> {
    let mut statement = connection
        .prepare("SELECT id FROM tracks WHERE missing = 0")
        .map_err(|e| format!("could not read the catalog: {e}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("could not read the catalog: {e}"))?;

    let mut found = HashSet::new();
    for row in rows {
        found.insert(row.map_err(|e| format!("could not read a catalog row: {e}"))?);
    }
    Ok(found)
}

fn stamp(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))
        .map_err(|e| format!("could not stamp the catalog version: {e}"))
}

/// Whether a table already has a column, which is what makes an upgrade safe to
/// run twice.
fn has_column(connection: &Connection, table: &str, column: &str) -> bool {
    let Ok(mut statement) = connection.prepare(&format!("PRAGMA table_info({table})")) else {
        return false;
    };
    statement
        .query_map([], |row| row.get::<_, String>(1))
        .map(|names| names.flatten().any(|name| name == column))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::CUSTOM_KIND;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wave-catalog-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn one_playlist(catalog: &Catalog, id: &str) -> Playlist {
        catalog
            .playlists()
            .unwrap()
            .into_iter()
            .find(|list| list.id == id)
            .expect("the playlist is there")
    }

    fn song(id: &str, title: &str, hash: &str) -> TrackRow {
        TrackRow {
            id: id.to_string(),
            rel_path: format!("songs/{id}/audio.mp3"),
            original_name: format!("{title}.mp3"),
            bytes: 1024,
            modified_ms: 5,
            content_hash: Some(hash.to_string()),
            title: title.to_string(),
            artist: Some("An Artist".to_string()),
            duration_ms: 1000,
            codec: "MP3".to_string(),
            added_at: 1,
            updated_at: 1,
            ..TrackRow::default()
        }
    }

    #[test]
    fn round_trips_a_track() {
        let root = scratch("round-trip");
        let catalog = Catalog::open(&root).unwrap();

        let mut row = song("one", "One", "hash-one");
        row.artist = Some("An Artist".to_string());
        row.album = Some("An Album".to_string());
        row.track_no = Some(3);
        row.disc_no = Some(2);
        row.year = Some(1997);
        row.genre = Some("Rock".to_string());
        row.bitrate = Some(320);
        row.sample_rate = Some(44_100);
        row.has_embedded_art = true;
        catalog.upsert_track(&row).unwrap();

        let read = catalog.track("one").unwrap().unwrap();
        assert_eq!(read.title, "One");
        assert_eq!(read.track_no, Some(3));
        assert_eq!(read.disc_no, Some(2));
        assert_eq!(read.year, Some(1997));
        assert_eq!(read.genre.as_deref(), Some("Rock"));
        assert_eq!(read.bitrate, Some(320));
        assert_eq!(read.sample_rate, Some(44_100));
        assert!(read.has_embedded_art);
        assert!(!read.missing);
        assert_eq!(catalog.counts(), (1, 0));

        drop(catalog);
        let again = Catalog::open(&root).unwrap();
        assert_eq!(again.tracks().unwrap().len(), 1);
    }

    #[test]
    fn a_scan_never_wipes_a_loudness_reading() {
        let root = scratch("loudness");
        let catalog = Catalog::open(&root).unwrap();
        catalog.upsert_track(&song("one", "One", "h")).unwrap();
        catalog.set_loudness("one", -9.5, 0.98, 1024).unwrap();

        catalog.upsert_track(&song("one", "One", "h")).unwrap();

        let read = catalog.track("one").unwrap().unwrap();
        assert_eq!(read.lufs, Some(-9.5));
        assert_eq!(read.peak, Some(0.98));
        assert_eq!(read.loudness_bytes, Some(1024));
    }

    #[test]
    fn a_missing_song_keeps_its_row_but_leaves_the_library() {
        let root = scratch("missing");
        let catalog = Catalog::open(&root).unwrap();
        catalog.upsert_track(&song("one", "One", "h")).unwrap();

        catalog.sync_scan(&[]).unwrap();
        assert!(catalog.tracks().unwrap().is_empty());
        assert_eq!(catalog.counts(), (0, 1));
        assert!(catalog.track("one").unwrap().is_some());

        catalog.upsert_track(&song("one", "One", "h")).unwrap();
        assert_eq!(catalog.tracks().unwrap().len(), 1);
    }

    #[test]
    fn finds_a_song_by_its_audio_and_by_its_tags() {
        let root = scratch("lookup");
        let catalog = Catalog::open(&root).unwrap();
        catalog.upsert_track(&song("one", "Hey Jude", "hash-one")).unwrap();

        assert!(catalog.find_by_hash("hash-one").unwrap().is_some());
        assert!(catalog.find_by_hash("nothing").unwrap().is_none());

        let found = catalog.find_by_tags("  hey   jude ", "AN ARTIST", "").unwrap();
        assert_eq!(found.len(), 1);
        // A different artist is a different song.
        assert!(catalog
            .find_by_tags("Hey Jude", "Someone Else", "")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn playlists_keep_their_order_and_drop_songs_the_library_lost() {
        let root = scratch("playlists");
        let catalog = Catalog::open(&root).unwrap();
        for id in ["one", "two", "three"] {
            catalog.upsert_track(&song(id, id, id)).unwrap();
        }

        let id = catalog.create_playlist("A playlist").unwrap();
        assert!(catalog.playlist_name_taken("a PLAYLIST", None));
        assert!(!catalog.playlist_name_taken("A playlist", Some(&id)));

        catalog
            .set_playlist_entries(&id, &["three".into(), "one".into(), "two".into()])
            .unwrap();
        let read = one_playlist(&catalog, &id);
        assert_eq!(read.track_ids, vec!["three", "one", "two"]);
        assert_eq!(read.name, "A playlist");

        catalog.add_to_playlist(&id, &["two".into(), "one".into()]).unwrap();
        assert_eq!(one_playlist(&catalog, &id).track_ids, vec!["three", "one", "two"]);

        // A song the library no longer has leaves the list but keeps its place.
        catalog.sync_scan(&[]).unwrap();
        catalog.upsert_track(&song("one", "one", "one")).unwrap();
        assert_eq!(one_playlist(&catalog, &id).track_ids, vec!["one"]);
        assert_eq!(catalog.playlist_entries(&id).unwrap().len(), 3);

        catalog.remove_from_playlist(&id, &["one".into()]).unwrap();
        assert_eq!(
            catalog.playlist_entries(&id).unwrap(),
            vec!["three".to_string(), "two".to_string()]
        );
    }

    #[test]
    fn deleting_a_song_removes_it_from_every_playlist() {
        let root = scratch("delete");
        let catalog = Catalog::open(&root).unwrap();
        catalog.upsert_track(&song("one", "One", "h")).unwrap();
        let id = catalog.create_playlist("A playlist").unwrap();
        catalog.set_playlist_entries(&id, &["one".into()]).unwrap();

        catalog.delete_tracks(&["one".to_string()]).unwrap();
        assert!(catalog.track("one").unwrap().is_none());
        assert!(catalog.playlist_entries(&id).unwrap().is_empty());
    }

    #[test]
    fn a_deleted_playlist_takes_its_entries_with_it() {
        let root = scratch("cascade");
        let catalog = Catalog::open(&root).unwrap();
        catalog.upsert_track(&song("one", "One", "h")).unwrap();
        let id = catalog.create_playlist("A playlist").unwrap();
        catalog.set_playlist_entries(&id, &["one".into()]).unwrap();

        catalog.delete_playlist(&id).unwrap();
        assert!(catalog.playlists().unwrap().is_empty());
        assert!(catalog.playlist_entries(&id).unwrap().is_empty());
        assert!(catalog.track("one").unwrap().is_some());
    }

    #[test]
    fn remembers_where_the_storage_layout_has_got_to() {
        let root = scratch("meta");
        let catalog = Catalog::open(&root).unwrap();

        assert!(catalog.meta(LAYOUT_VERSION_KEY).is_none());
        catalog.set_meta(LAYOUT_VERSION_KEY, LAYOUT_VERSION).unwrap();
        assert_eq!(
            catalog.meta(LAYOUT_VERSION_KEY).as_deref(),
            Some(LAYOUT_VERSION)
        );
    }

    fn waiting(id: &str, title: &str) -> PendingTrack {
        PendingTrack {
            id: id.to_string(),
            title: title.to_string(),
            artists: vec!["An Artist".to_string()],
            album: "An Album".to_string(),
            genres: vec!["Trip-Hop".to_string()],
            cover_url: Some("https://cdn/cover.jpg".to_string()),
            track_number: Some(4),
            source: "deezer".to_string(),
            source_id: "116348632".to_string(),
            ..PendingTrack::default()
        }
    }

    #[test]
    fn a_generated_playlist_keeps_its_waiting_songs_in_place() {
        let root = scratch("pending");
        let catalog = Catalog::open(&root).unwrap();
        catalog.upsert_track(&song("one", "One", "h")).unwrap();

        let id = catalog
            .create_generated_playlist(
                "Made for you",
                &["one".to_string(), "waiting".to_string()],
                &[waiting("waiting", "Two")],
            )
            .unwrap();

        let read = one_playlist(&catalog, &id);
        assert_eq!(read.kind, GENERATED_KIND);
        assert_eq!(read.entries, vec!["one", "waiting"]);
        // Only the downloaded song is a library song.
        assert_eq!(read.track_ids, vec!["one"]);
        assert_eq!(read.pending.len(), 1);
        assert_eq!(read.pending[0].title, "Two");
        assert_eq!(read.pending[0].genres, vec!["Trip-Hop"]);
        assert_eq!(read.pending[0].track_number, Some(4));

        // A download lands on the entry the waiting song held.
        catalog.upsert_track(&song("two", "Two", "h2")).unwrap();
        catalog
            .resolve_pending(
                &id,
                &["one".to_string(), "two".to_string()],
                &["waiting".to_string()],
            )
            .unwrap();

        let read = one_playlist(&catalog, &id);
        assert_eq!(read.entries, vec!["one", "two"]);
        assert_eq!(read.track_ids, vec!["one", "two"]);
        assert!(read.pending.is_empty());
        assert!(catalog.pending_tracks(&id).unwrap().is_empty());

        // A custom playlist still says so.
        let plain = catalog.create_playlist("By hand").unwrap();
        assert_eq!(one_playlist(&catalog, &plain).kind, CUSTOM_KIND);
    }

    #[test]
    fn a_version_one_catalog_gains_the_waiting_table() {
        let root = scratch("upgrade");
        let dir = root.join(CONFIG_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(CATALOG_FILE);

        // The catalog as it stood before generated playlists.
        {
            let old = Connection::open(&path).unwrap();
            old.execute_batch(
                "CREATE TABLE tracks (id TEXT PRIMARY KEY, missing INTEGER NOT NULL DEFAULT 0);\
                 CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, \
                   created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);\
                 CREATE TABLE playlist_tracks (playlist_id TEXT NOT NULL, track_id TEXT NOT NULL, \
                   position INTEGER NOT NULL, PRIMARY KEY (playlist_id, position));\
                 PRAGMA user_version = 1;",
            )
            .unwrap();
            old.execute(
                "INSERT INTO playlists (id, name, created_at, updated_at) VALUES ('p', 'Old', 1, 1)",
                [],
            )
            .unwrap();
        }

        let catalog = Catalog::open(&root).unwrap();
        let lists = catalog.playlists().unwrap();
        assert_eq!(lists.len(), 1);
        assert_eq!(lists[0].name, "Old");
        assert_eq!(lists[0].kind, CUSTOM_KIND);
        assert!(lists[0].pending.is_empty());
        drop(catalog);

        // A stamp that did not land leaves the upgrade to run again.
        {
            let again = Connection::open(&path).unwrap();
            again.execute_batch("PRAGMA user_version = 1;").unwrap();
        }

        let catalog = Catalog::open(&root).unwrap();
        assert_eq!(catalog.playlists().unwrap().len(), 1);
    }

    #[test]
    fn a_version_two_catalog_gains_the_waiting_covers() {
        let root = scratch("upgrade-covers");
        let dir = root.join(CONFIG_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(CATALOG_FILE);

        // The catalog as it stood with generated playlists but no covers.
        {
            let old = Connection::open(&path).unwrap();
            old.execute_batch(
                "CREATE TABLE tracks (id TEXT PRIMARY KEY, missing INTEGER NOT NULL DEFAULT 0);\
                 CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, \
                   kind TEXT NOT NULL DEFAULT 'custom', created_at INTEGER NOT NULL DEFAULT 0, \
                   updated_at INTEGER NOT NULL DEFAULT 0);\
                 CREATE TABLE playlist_tracks (playlist_id TEXT NOT NULL, track_id TEXT NOT NULL, \
                   position INTEGER NOT NULL, PRIMARY KEY (playlist_id, position));\
                 CREATE TABLE pending_tracks (id TEXT PRIMARY KEY, playlist_id TEXT NOT NULL, \
                   title TEXT NOT NULL DEFAULT '', artists TEXT NOT NULL DEFAULT '', \
                   album TEXT NOT NULL DEFAULT '', album_artist TEXT NOT NULL DEFAULT '', \
                   genres TEXT NOT NULL DEFAULT '', isrc TEXT NOT NULL DEFAULT '', \
                   cover_url TEXT, release_date TEXT NOT NULL DEFAULT '', \
                   track_number INTEGER, disc_number INTEGER, \
                   source TEXT NOT NULL DEFAULT '', source_id TEXT NOT NULL DEFAULT '', \
                   added_at INTEGER NOT NULL DEFAULT 0);\
                 PRAGMA user_version = 2;",
            )
            .unwrap();
            old.execute(
                "INSERT INTO playlists (id, name, kind, created_at, updated_at) \
                 VALUES ('p', 'Made for you', 'generated', 1, 1)",
                [],
            )
            .unwrap();
            old.execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ('p', 'w', 0)",
                [],
            )
            .unwrap();
            old.execute(
                "INSERT INTO pending_tracks (id, playlist_id, title, artists) \
                 VALUES ('w', 'p', 'A pick', '[\"An Artist\"]')",
                [],
            )
            .unwrap();
        }

        let catalog = Catalog::open(&root).unwrap();
        let read = one_playlist(&catalog, "p");
        assert_eq!(read.entries, vec!["w"]);
        assert_eq!(read.pending.len(), 1);
        assert_eq!(read.pending[0].title, "A pick");
        assert_eq!(read.pending[0].artists, vec!["An Artist"]);
        // The new column is there, and the row that predates it still reads.
        assert!(read.pending[0].cover_path.is_none());
        drop(catalog);

        // A stamp that did not land leaves the upgrade to run again.
        {
            let again = Connection::open(&path).unwrap();
            again.execute_batch("PRAGMA user_version = 2;").unwrap();
        }

        let catalog = Catalog::open(&root).unwrap();
        assert_eq!(catalog.playlists().unwrap().len(), 1);
    }
}
