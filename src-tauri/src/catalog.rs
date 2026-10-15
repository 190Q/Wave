use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::identity;
use crate::library::CONFIG_DIR;
use crate::state::Playlist;

pub const CATALOG_FILE: &str = "library.db";
const SCHEMA_VERSION: i64 = 1;
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

/// One row of `tracks`, as the database holds it. The wire type the UI sees is
/// [`crate::library::Track`], which is built from this.
#[derive(Debug, Clone, Default)]
pub struct TrackRow {
    pub id: String,
    /// The audio file, relative to the library root.
    pub rel_path: String,
    /// The name the file arrived under, kept only to describe it to the user.
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
    /// The cover beside the audio, relative to the library root.
    pub cover_path: Option<String>,
    /// The lyrics beside the audio, relative to the library root.
    pub lyrics_path: Option<String>,
    pub lufs: Option<f32>,
    pub peak: Option<f32>,
    /// The size the loudness reading was taken from, so a changed file can be
    /// measured again.
    pub loudness_bytes: Option<u64>,
    /// True when the audio file is gone. The row is kept, so likes, playlists
    /// and history survive a song being moved away or deleted outside Wave.
    pub missing: bool,
    pub added_at: i64,
    pub updated_at: i64,
}

/// The library's own records. One connection, behind a lock: every command that
/// touches the library goes through here.
pub struct Catalog {
    root: PathBuf,
    path: PathBuf,
    connection: Mutex<Connection>,
}

impl Catalog {
    /// Opens the catalog for a library root, creating it on first use.
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
                .execute_batch(SCHEMA)
                .map_err(|e| format!("could not create the catalog: {e}"))?;
            connection
                .execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))
                .map_err(|e| format!("could not stamp the catalog version: {e}"))?;
        }

        Ok(())
    }

    fn guard(&self) -> MutexGuard<'_, Connection> {
        // A poisoned lock only means another command panicked mid-write.
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The library this catalog describes.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The size of the database file, for the settings panel.
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

    /// Every song whose audio is where the catalog expects it.
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
    
    pub fn find_by_tags(&self, title: &str, artist: &str, album: &str) -> Result<Vec<TrackRow>, String> {
        self.query_tracks(
            &format!(
                "SELECT {TRACK_COLUMNS} FROM tracks \
                 WHERE missing = 0 AND lower(trim(title)) = ?1 \
                   AND lower(trim(coalesce(artist, ''))) = ?2 \
                   AND lower(trim(coalesce(album, ''))) = ?3"
            ),
            params![
                fold(title),
                fold(artist),
                fold(album),
            ],
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

    /// Removes songs outright: the rows, and their places in every playlist.
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

    /// Every playlist, in name order, each holding only the songs the library
    /// still has.
    pub fn playlists(&self) -> Result<Vec<Playlist>, String> {
        let connection = self.guard();

        let mut entries: Vec<(String, String, i64)> = Vec::new();
        {
            let mut statement = connection
                .prepare("SELECT id, name, created_at FROM playlists")
                .map_err(|e| format!("could not read the playlists: {e}"))?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .map_err(|e| format!("could not read the playlists: {e}"))?;
            for row in rows {
                entries.push(row.map_err(|e| format!("could not read a playlist: {e}"))?);
            }
        }

        // One query for every playlist's songs, rather than one per playlist.
        let mut contents: HashMap<String, Vec<String>> = HashMap::new();
        {
            let mut statement = connection
                .prepare(
                    "SELECT pt.playlist_id, pt.track_id FROM playlist_tracks pt \
                     JOIN tracks t ON t.id = pt.track_id \
                     WHERE t.missing = 0 \
                     ORDER BY pt.playlist_id, pt.position",
                )
                .map_err(|e| format!("could not read the playlists: {e}"))?;
            let rows = statement
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| format!("could not read the playlists: {e}"))?;
            for row in rows {
                let (playlist_id, track_id) =
                    row.map_err(|e| format!("could not read a playlist entry: {e}"))?;
                contents.entry(playlist_id).or_default().push(track_id);
            }
        }

        let mut playlists: Vec<Playlist> = entries
            .into_iter()
            .map(|(id, name, created_at)| Playlist {
                track_ids: contents.remove(&id).unwrap_or_default(),
                id,
                name,
                created_at: created_at.max(0) as u64,
            })
            .collect();

        playlists.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(playlists)
    }

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
        // The entries go with it: the table is declared with `ON DELETE CASCADE`.
        self.guard()
            .execute("DELETE FROM playlists WHERE id = ?1", params![id])
            .map(|_| ())
            .map_err(|e| format!("could not delete the playlist: {e}"))
    }

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

    /// Replaces a playlist's contents with exactly these songs, in this order.
    pub fn set_playlist_entries(&self, id: &str, track_ids: &[String]) -> Result<(), String> {
        let mut connection = self.guard();
        let transaction = connection
            .transaction()
            .map_err(|e| format!("could not start a catalog write: {e}"))?;

        transaction
            .execute("DELETE FROM playlist_tracks WHERE playlist_id = ?1", params![id])
            .map_err(|e| format!("could not rewrite the playlist: {e}"))?;

        for (position, track_id) in track_ids.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
                    params![id, track_id, position as i64],
                )
                .map_err(|e| format!("could not write the playlist: {e}"))?;
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

    /// Adds songs to the end of a playlist, ignoring ones already in it.
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
                    "INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3) \
                     ON CONFLICT(id) DO UPDATE SET name = excluded.name",
                    params![playlist.id, playlist.name, playlist.created_at as i64],
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

/// Folds a tag down to what makes two songs the same song: case and stray
/// spacing are not differences.
fn fold(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wave-catalog-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The one playlist the catalog holds under an id.
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

        // Reopening finds the same library, so nothing is rebuilt on launch.
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

        // The scan writes the row again, with no reading of its own.
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

        // Tags are matched folded, so case and stray spacing do not hide a song.
        let found = catalog
            .find_by_tags("  hey   jude ", "AN ARTIST", "")
            .unwrap();
        assert_eq!(found.len(), 1);
        // A different artist is a different song, which is the whole point.
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

        // Adding is idempotent, and lands at the end.
        catalog.add_to_playlist(&id, &["two".into(), "one".into()]).unwrap();
        assert_eq!(one_playlist(&catalog, &id).track_ids, vec!["three", "one", "two"]);

        // A song the library no longer has disappears from the list but keeps
        // its place, so it comes back if the audio does.
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
        // The song itself is untouched.
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
}
