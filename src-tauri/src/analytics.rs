use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

const DB_FILE: &str = "analytics.db";

/// A gap longer than this starts a new listening session.
const SESSION_GAP_MS: i64 = 30 * 60 * 1000;

/// How many songs `analytics_top_songs` ranks by default.
pub const TOP_SONGS_LIMIT: usize = 100;

/// How many entries a ranking keeps unless the caller asks otherwise.
const DEFAULT_LIMIT: usize = 5;

const SCHEMA_VERSION: i64 = 1;

const RANGE_COND: &str = "p.started_at >= ?1 AND p.started_at < ?2";

const STREAM_COND: &str = "(p.completed = 1 OR p.ms_played >= 30000)";

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS plays (
  listen_id   TEXT PRIMARY KEY,
  track_id    TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  ms_played   INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  completed   INTEGER NOT NULL DEFAULT 0,
  reason      TEXT NOT NULL DEFAULT 'open',
  source_id   TEXT,
  source_name TEXT,
  source_kind TEXT,
  shuffle     INTEGER NOT NULL DEFAULT 0,
  repeat      TEXT,
  session_id  INTEGER REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  plays INTEGER NOT NULL DEFAULT 0,
  ms_played INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tracks (
  track_id TEXT PRIMARY KEY,
  title TEXT,
  artist TEXT,
  album TEXT,
  album_artist TEXT,
  genre TEXT,
  year INTEGER,
  duration_ms INTEGER,
  media_type TEXT,
  codec TEXT,
  first_seen_at INTEGER,
  last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  track_id TEXT,
  playlist_id TEXT,
  value TEXT
);
CREATE INDEX IF NOT EXISTS plays_started_at ON plays (started_at);
CREATE INDEX IF NOT EXISTS plays_track_id ON plays (track_id);
CREATE INDEX IF NOT EXISTS plays_session_id ON plays (session_id);
CREATE INDEX IF NOT EXISTS tracks_artist ON tracks (artist);
CREATE INDEX IF NOT EXISTS tracks_genre ON tracks (genre);
CREATE INDEX IF NOT EXISTS tracks_album ON tracks (album);
CREATE INDEX IF NOT EXISTS events_at ON events (at);
CREATE INDEX IF NOT EXISTS events_track_id ON events (track_id);
"#;

/// What the frontend knows about a song, kept so history outlives the file.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackSnapshot {
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<u16>,
    pub duration_ms: u64,
    /// `music`, `audiobook` or `podcast`.
    pub media_type: String,
    pub codec: String,
}

/// One listen. Sent twice for a long song: an open checkpoint, then the end.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayRecord {
    pub listen_id: String,
    pub track_id: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub ms_played: i64,
    pub duration_ms: i64,
    pub completed: bool,
    /// `open`, `ended`, `skipped`, `stopped` or `error`.
    pub reason: String,
    pub source_id: Option<String>,
    pub source_name: Option<String>,
    pub source_kind: Option<String>,
    pub shuffle: bool,
    pub repeat: Option<String>,
}

/// A discrete signal that is not a play: a like, a playlist edit, and so on.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub at: i64,
    pub kind: String,
    pub track_id: Option<String>,
    pub playlist_id: Option<String>,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaTotal {
    pub media_type: String,
    pub plays: i64,
    pub ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopSong {
    pub track_id: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub plays: i64,
    pub ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopArtist {
    pub artist: String,
    pub plays: i64,
    pub ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopGenre {
    pub genre: String,
    pub plays: i64,
    pub ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopAlbum {
    pub album: String,
    pub album_artist: Option<String>,
    pub plays: i64,
    pub ms: i64,
}

/// One bucket of an artist's activity: the label the database produced, and how
/// many streams landed in it. The caller knows the bucket size it asked for.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SprintPoint {
    /// `2026-03-14`, `2026-03` or `2026`, depending on the bucket asked for.
    pub key: String,
    pub count: i64,
}

/// One artist's streams, bucket by bucket, for the ranking-over-time chart.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistSprint {
    pub artist: String,
    pub points: Vec<SprintPoint>,
}

/// Everything the Wave Swell pane shows for one window of time.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwellSummary {
    pub from: i64,
    pub to: i64,
    pub minutes_listened: f64,
    pub ms_listened: i64,
    pub plays: i64,
    pub listens: i64,
    pub unique_tracks: i64,
    pub unique_artists: i64,
    pub first_play_at: Option<i64>,
    pub last_play_at: Option<i64>,
    /// Music, audiobooks and podcasts, so the three can be shown apart.
    pub by_media_type: Vec<MediaTotal>,
    /// The top hundred, each with its stream count.
    pub top_songs: Vec<TopSong>,
    pub top_artists: Vec<TopArtist>,
    pub artist_sprint: Vec<ArtistSprint>,
    pub top_genres: Vec<TopGenre>,
    pub genres_explored: i64,
    pub top_albums: Vec<TopAlbum>,
}

/// One row of an affinity ranking, with a recency-weighted score.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Affinity {
    pub name: String,
    pub plays: i64,
    pub ms: i64,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackAffinity {
    pub track_id: String,
    pub title: String,
    pub artist: Option<String>,
    pub plays: i64,
    pub ms: i64,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoPlayed {
    pub a: String,
    pub b: String,
    pub count: i64,
}

/// The raw material for a recommender. Nothing consumes this yet.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendationSeeds {
    pub artists: Vec<Affinity>,
    pub genres: Vec<Affinity>,
    pub tracks: Vec<TrackAffinity>,
    /// Track pairs heard in the same sitting, most often first.
    pub co_played: Vec<CoPlayed>,
    pub liked: Vec<String>,
    /// Songs abandoned early, most often first.
    pub skipped: Vec<String>,
    pub recent: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsStats {
    /// Where the database lives, empty for the in-memory fallback.
    pub path: String,
    pub size_bytes: u64,
    pub plays: i64,
    pub tracks: i64,
    pub sessions: i64,
    pub events: i64,
    pub ms_listened: i64,
    pub first_play_at: Option<i64>,
    pub last_play_at: Option<i64>,
}

/// The database, guarded for the command handlers.
pub struct Analytics {
    conn: Mutex<Connection>,
    path: PathBuf,
}

impl Analytics {
    /// Opens the database, creating it and its folder on first run.
    pub fn open<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("could not resolve the app data directory: {e}"))?;
        fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

        let path = dir.join(DB_FILE);
        let conn = Connection::open(&path)
            .map_err(|e| format!("could not open {}: {e}", path.display()))?;
        Self::prepare(&conn).map_err(|e| format!("could not prepare {}: {e}", path.display()))?;

        Ok(Self {
            conn: Mutex::new(conn),
            path,
        })
    }

    /// A throwaway database, used when the real one cannot be opened so the app
    /// still runs. Nothing written to it is kept.
    pub fn in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("an in-memory database always opens");
        let _ = Self::prepare(&conn);
        Self {
            conn: Mutex::new(conn),
            path: PathBuf::new(),
        }
    }

    fn prepare(conn: &Connection) -> rusqlite::Result<()> {
        // WAL keeps a write from blocking the reads that draw the UI.
        let _ = conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()));
        conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")?;

        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version < 1 {
            conn.execute_batch(SCHEMA)?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        Ok(())
    }

    fn guard(&self) -> MutexGuard<'_, Connection> {
        // A poisoned lock only means another command panicked mid-write.
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn remap_track_ids(&self, map: &HashMap<String, String>) -> Result<(), String> {
        if map.is_empty() {
            return Ok(());
        }

        let mut conn = self.guard();
        let tx = conn.transaction().map_err(db_error)?;

        for (old, new) in map {
            if old == new {
                continue;
            }

            tx.execute(
                "DELETE FROM tracks WHERE track_id = ?1 \
                 AND EXISTS (SELECT 1 FROM tracks WHERE track_id = ?2)",
                params![old, new],
            )
            .map_err(db_error)?;
            tx.execute(
                "UPDATE tracks SET track_id = ?2 WHERE track_id = ?1",
                params![old, new],
            )
            .map_err(db_error)?;
            tx.execute(
                "UPDATE plays SET track_id = ?2 WHERE track_id = ?1",
                params![old, new],
            )
            .map_err(db_error)?;
            tx.execute(
                "UPDATE events SET track_id = ?2 WHERE track_id = ?1",
                params![old, new],
            )
            .map_err(db_error)?;
        }

        tx.commit().map_err(db_error)
    }

    /// Snapshots the library, so a song that is later deleted still has a name.
    pub fn remember_tracks(&self, tracks: &[TrackSnapshot]) -> Result<(), String> {
        if tracks.is_empty() {
            return Ok(());
        }
        let now = now_ms();
        let mut conn = self.guard();
        let tx = conn.transaction().map_err(db_error)?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO tracks (track_id, title, artist, album, album_artist, genre, \
                     year, duration_ms, media_type, codec, first_seen_at, last_seen_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11) \
                     ON CONFLICT(track_id) DO UPDATE SET \
                       title = excluded.title, artist = excluded.artist, \
                       album = excluded.album, album_artist = excluded.album_artist, \
                       genre = excluded.genre, year = excluded.year, \
                       duration_ms = excluded.duration_ms, \
                       media_type = excluded.media_type, codec = excluded.codec, \
                       last_seen_at = excluded.last_seen_at",
                )
                .map_err(db_error)?;

            for track in tracks {
                stmt.execute(params![
                    track.id,
                    track.title,
                    track.artist,
                    track.album,
                    track.album_artist,
                    track.genre,
                    track.year.map(i64::from),
                    track.duration_ms as i64,
                    media_type(&track.media_type),
                    track.codec,
                    now,
                ])
                .map_err(db_error)?;
            }
        }
        tx.commit().map_err(db_error)
    }

    /// Writes a listen, or updates the row the same listen already has.
    pub fn record_play(&self, play: &PlayRecord) -> Result<(), String> {
        let mut conn = self.guard();
        let tx = conn.transaction().map_err(db_error)?;

        let existing: Option<Option<i64>> = tx
            .query_row(
                "SELECT session_id FROM plays WHERE listen_id = ?1",
                params![play.listen_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;

        let session_id = match existing {
            Some(session_id) => {
                tx.execute(
                    "UPDATE plays SET \
                       ended_at = excluded.ended_at, \
                       ms_played = MAX(plays.ms_played, excluded.ms_played), \
                       duration_ms = excluded.duration_ms, \
                       completed = excluded.completed, \
                       reason = excluded.reason \
                     FROM (SELECT ?2 AS ended_at, ?3 AS ms_played, ?4 AS duration_ms, \
                                  ?5 AS completed, ?6 AS reason) AS excluded \
                     WHERE plays.listen_id = ?1 \
                       AND (plays.reason = 'open' OR excluded.reason <> 'open')",
                    params![
                        play.listen_id,
                        play.ended_at,
                        play.ms_played.max(0),
                        play.duration_ms.max(0),
                        i64::from(play.completed),
                        play.reason,
                    ],
                )
                .map_err(db_error)?;
                session_id
            }
            None => {
                let session_id = session_for(&tx, play.started_at, play.ended_at)?;
                tx.execute(
                    "INSERT INTO plays (listen_id, track_id, started_at, ended_at, ms_played, \
                     duration_ms, completed, reason, source_id, source_name, source_kind, \
                     shuffle, repeat, session_id) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                    params![
                        play.listen_id,
                        play.track_id,
                        play.started_at,
                        play.ended_at,
                        play.ms_played.max(0),
                        play.duration_ms.max(0),
                        i64::from(play.completed),
                        play.reason,
                        play.source_id,
                        play.source_name,
                        play.source_kind,
                        i64::from(play.shuffle),
                        play.repeat,
                        session_id,
                    ],
                )
                .map_err(db_error)?;
                Some(session_id)
            }
        };

        if let Some(session_id) = session_id {
            refresh_session(&tx, session_id)?;
        }
        tx.commit().map_err(db_error)
    }

    pub fn record_events(&self, events: &[EventRecord]) -> Result<(), String> {
        if events.is_empty() {
            return Ok(());
        }
        let mut conn = self.guard();
        let tx = conn.transaction().map_err(db_error)?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO events (at, kind, track_id, playlist_id, value) \
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )
                .map_err(db_error)?;
            for event in events {
                stmt.execute(params![
                    event.at,
                    event.kind,
                    event.track_id,
                    event.playlist_id,
                    event.value,
                ])
                .map_err(db_error)?;
            }
        }
        tx.commit().map_err(db_error)
    }

    /// The top songs in a window, each with its stream count.
    pub fn top_songs(&self, from: i64, to: i64, limit: usize) -> Result<Vec<TopSong>, String> {
        let conn = self.guard();
        top_songs(&conn, from, to, limit).map_err(db_error)
    }

    /// Every Wave Swell metric for one window, in a single read.
    pub fn swell(&self, from: i64, to: i64, bucket: &str) -> Result<SwellSummary, String> {
        let conn = self.guard();
        swell(&conn, from, to, bucket).map_err(db_error)
    }

    pub fn recommendation_seeds(&self, limit: usize) -> Result<RecommendationSeeds, String> {
        let conn = self.guard();
        recommendation_seeds(&conn, limit).map_err(db_error)
    }

    pub fn stats(&self) -> Result<AnalyticsStats, String> {
        let conn = self.guard();
        let (plays, ms, first, last): (i64, i64, Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(ms_played), 0), MIN(started_at), MAX(started_at) \
                 FROM plays",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(db_error)?;
        let tracks = count(&conn, "SELECT COUNT(*) FROM tracks")?;
        let sessions = count(&conn, "SELECT COUNT(*) FROM sessions")?;
        let events = count(&conn, "SELECT COUNT(*) FROM events")?;

        Ok(AnalyticsStats {
            path: self.path.to_string_lossy().into_owned(),
            size_bytes: database_size(&self.path),
            plays,
            tracks,
            sessions,
            events,
            ms_listened: ms,
            first_play_at: first,
            last_play_at: last,
        })
    }

    /// Drops every row, leaving the file and its schema in place.
    pub fn clear(&self) -> Result<(), String> {
        let conn = self.guard();
        // Plays point at sessions, so they go first.
        conn.execute_batch(
            "DELETE FROM plays; DELETE FROM events; DELETE FROM sessions; DELETE FROM tracks;",
        )
        .map_err(db_error)?;
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        Ok(())
    }
}

/// Puts a listen in the sitting it belongs to, opening one if need be.
fn session_for(conn: &Connection, started_at: i64, ended_at: Option<i64>) -> Result<i64, String> {
    let end = ended_at.unwrap_or(started_at).max(started_at);

    let last: Option<(i64, i64)> = conn
        .query_row(
            "SELECT id, ended_at FROM sessions ORDER BY ended_at DESC LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(db_error)?;

    let id = match last {
        Some((id, last_end)) if (started_at - last_end).abs() <= SESSION_GAP_MS => id,
        _ => {
            conn.execute(
                "INSERT INTO sessions (started_at, ended_at) VALUES (?1, ?2)",
                params![started_at, end],
            )
            .map_err(db_error)?;
            conn.last_insert_rowid()
        }
    };

    conn.execute(
        "UPDATE sessions SET started_at = MIN(started_at, ?1), ended_at = MAX(ended_at, ?2) \
         WHERE id = ?3",
        params![started_at, end, id],
    )
    .map_err(db_error)?;

    Ok(id)
}

/// Recomputes a sitting's totals from the listens that landed in it.
fn refresh_session(conn: &Connection, session_id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE sessions SET \
           plays = (SELECT COUNT(*) FROM plays WHERE session_id = ?1), \
           ms_played = (SELECT COALESCE(SUM(ms_played), 0) FROM plays WHERE session_id = ?1) \
         WHERE id = ?1",
        params![session_id],
    )
    .map_err(db_error)?;
    Ok(())
}

fn bucket_format(bucket: &str) -> &'static str {
    match bucket {
        "day" => "%Y-%m-%d",
        "year" => "%Y",
        _ => "%Y-%m",
    }
}

fn top_songs(
    conn: &Connection,
    from: i64,
    to: i64,
    limit: usize,
) -> rusqlite::Result<Vec<TopSong>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT p.track_id, COALESCE(t.title, p.track_id), t.artist, t.album, \
                COUNT(*) AS plays, COALESCE(SUM(p.ms_played), 0) AS ms \
         FROM plays p LEFT JOIN tracks t ON t.track_id = p.track_id \
         WHERE {RANGE_COND} AND {STREAM_COND} \
         GROUP BY p.track_id \
         ORDER BY plays DESC, ms DESC, COALESCE(t.title, p.track_id) COLLATE NOCASE ASC \
         LIMIT ?3"
    ))?;

    stmt.query_map(params![from, to, limit as i64], |row| {
        Ok(TopSong {
            track_id: row.get(0)?,
            title: row.get(1)?,
            artist: row.get(2)?,
            album: row.get(3)?,
            plays: row.get(4)?,
            ms: row.get(5)?,
        })
    })?
    .collect()
}

fn swell(conn: &Connection, from: i64, to: i64, bucket: &str) -> rusqlite::Result<SwellSummary> {
    let (plays, listens, ms, unique_tracks, first, last): (
        i64,
        i64,
        i64,
        i64,
        Option<i64>,
        Option<i64>,
    ) = conn.query_row(
        &format!(
            "SELECT COALESCE(SUM(CASE WHEN {STREAM_COND} THEN 1 ELSE 0 END), 0), \
                    COUNT(*), \
                    COALESCE(SUM(p.ms_played), 0), \
                    COUNT(DISTINCT CASE WHEN {STREAM_COND} THEN p.track_id END), \
                    MIN(p.started_at), MAX(p.started_at) \
             FROM plays p WHERE {RANGE_COND}"
        ),
        params![from, to],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        },
    )?;

    let unique_artists = conn.query_row(
        &format!(
            "SELECT COUNT(DISTINCT LOWER(TRIM(t.artist))) \
             FROM plays p JOIN tracks t ON t.track_id = p.track_id \
             WHERE {RANGE_COND} AND {STREAM_COND} \
               AND t.artist IS NOT NULL AND TRIM(t.artist) <> ''"
        ),
        params![from, to],
        |row| row.get(0),
    )?;

    let genres_explored = conn.query_row(
        &format!(
            "SELECT COUNT(DISTINCT LOWER(TRIM(t.genre))) \
             FROM plays p JOIN tracks t ON t.track_id = p.track_id \
             WHERE {RANGE_COND} AND {STREAM_COND} \
               AND t.genre IS NOT NULL AND TRIM(t.genre) <> ''"
        ),
        params![from, to],
        |row| row.get(0),
    )?;

    let by_media_type = {
        let mut stmt = conn.prepare(&format!(
            "SELECT COALESCE(t.media_type, 'music') AS media_type, \
                    SUM(CASE WHEN {STREAM_COND} THEN 1 ELSE 0 END), \
                    COALESCE(SUM(p.ms_played), 0) \
             FROM plays p LEFT JOIN tracks t ON t.track_id = p.track_id \
             WHERE {RANGE_COND} \
             GROUP BY media_type \
             ORDER BY 3 DESC"
        ))?;
        stmt.query_map(params![from, to], |row| {
            Ok(MediaTotal {
                media_type: row.get(0)?,
                plays: row.get(1)?,
                ms: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let top_artists = {
        let mut stmt = conn.prepare(&format!(
            "SELECT MIN(TRIM(t.artist)), COUNT(*), COALESCE(SUM(p.ms_played), 0) \
             FROM plays p JOIN tracks t ON t.track_id = p.track_id \
             WHERE {RANGE_COND} AND {STREAM_COND} \
               AND t.artist IS NOT NULL AND TRIM(t.artist) <> '' \
             GROUP BY LOWER(TRIM(t.artist)) \
             ORDER BY 2 DESC, 3 DESC \
             LIMIT ?3"
        ))?;
        stmt.query_map(params![from, to, DEFAULT_LIMIT as i64], |row| {
            Ok(TopArtist {
                artist: row.get(0)?,
                plays: row.get(1)?,
                ms: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let top_genres = {
        let mut stmt = conn.prepare(&format!(
            "SELECT MIN(TRIM(t.genre)), COUNT(*), COALESCE(SUM(p.ms_played), 0) \
             FROM plays p JOIN tracks t ON t.track_id = p.track_id \
             WHERE {RANGE_COND} AND {STREAM_COND} \
               AND t.genre IS NOT NULL AND TRIM(t.genre) <> '' \
             GROUP BY LOWER(TRIM(t.genre)) \
             ORDER BY 2 DESC, 3 DESC \
             LIMIT ?3"
        ))?;
        stmt.query_map(params![from, to, DEFAULT_LIMIT as i64], |row| {
            Ok(TopGenre {
                genre: row.get(0)?,
                plays: row.get(1)?,
                ms: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let top_albums = {
        let mut stmt = conn.prepare(&format!(
            "SELECT MIN(TRIM(t.album)), MIN(COALESCE(t.album_artist, '')), COUNT(*), \
                    COALESCE(SUM(p.ms_played), 0) \
             FROM plays p JOIN tracks t ON t.track_id = p.track_id \
             WHERE {RANGE_COND} AND {STREAM_COND} \
               AND t.album IS NOT NULL AND TRIM(t.album) <> '' \
             GROUP BY LOWER(TRIM(t.album)), LOWER(COALESCE(t.album_artist, '')) \
             ORDER BY 3 DESC, 4 DESC \
             LIMIT ?3"
        ))?;
        stmt.query_map(params![from, to, DEFAULT_LIMIT as i64], |row| {
            let album_artist: String = row.get(1)?;
            Ok(TopAlbum {
                album: row.get(0)?,
                album_artist: if album_artist.is_empty() {
                    None
                } else {
                    Some(album_artist)
                },
                plays: row.get(2)?,
                ms: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };

    // The chart wants the five artists as they moved through the window, so each
    // one is counted per bucket on top of the ranking above.
    let pattern = bucket_format(bucket);
    let mut artist_sprint = Vec::with_capacity(top_artists.len());
    for artist in &top_artists {
        let mut stmt = conn.prepare(&format!(
            "SELECT strftime('{pattern}', p.started_at / 1000, 'unixepoch', 'localtime'), \
                    COUNT(*) \
             FROM plays p JOIN tracks t ON t.track_id = p.track_id \
             WHERE {RANGE_COND} AND {STREAM_COND} \
               AND LOWER(TRIM(t.artist)) = LOWER(TRIM(?3)) \
             GROUP BY 1 ORDER BY 1"
        ))?;
        let points = stmt
            .query_map(params![from, to, artist.artist], |row| {
                Ok(SprintPoint {
                    key: row.get(0)?,
                    count: row.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        artist_sprint.push(ArtistSprint {
            artist: artist.artist.clone(),
            points,
        });
    }

    Ok(SwellSummary {
        from,
        to,
        minutes_listened: ms as f64 / 60_000.0,
        ms_listened: ms,
        plays,
        listens,
        unique_tracks,
        unique_artists,
        first_play_at: first,
        last_play_at: last,
        by_media_type,
        top_songs: top_songs(conn, from, to, TOP_SONGS_LIMIT)?,
        top_artists,
        artist_sprint,
        top_genres,
        genres_explored,
        top_albums,
    })
}

fn recommendation_seeds(
    conn: &Connection,
    limit: usize,
) -> rusqlite::Result<RecommendationSeeds> {
    let limit = limit as i64;

    // A play is worth less the older it is: half a month's half-life, roughly,
    // without needing SQLite's optional math functions.
    let decay = "COALESCE(SUM(1.0 / (1.0 + MAX(0.0, julianday('now') - \
                 julianday(p.started_at / 1000, 'unixepoch')) / 30.0)), 0.0)";

    let artists = {
        let mut stmt = conn.prepare(&format!(
            "SELECT MIN(TRIM(t.artist)), COUNT(*), COALESCE(SUM(p.ms_played), 0), {decay} \
             FROM plays p JOIN tracks t ON t.track_id = p.track_id \
             WHERE t.artist IS NOT NULL AND TRIM(t.artist) <> '' \
             GROUP BY LOWER(TRIM(t.artist)) \
             ORDER BY 4 DESC, 2 DESC LIMIT ?1"
        ))?;
        stmt.query_map(params![limit], |row| {
            Ok(Affinity {
                name: row.get(0)?,
                plays: row.get(1)?,
                ms: row.get(2)?,
                score: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let genres = {
        let mut stmt = conn.prepare(&format!(
            "SELECT MIN(TRIM(t.genre)), COUNT(*), COALESCE(SUM(p.ms_played), 0), {decay} \
             FROM plays p JOIN tracks t ON t.track_id = p.track_id \
             WHERE t.genre IS NOT NULL AND TRIM(t.genre) <> '' \
             GROUP BY LOWER(TRIM(t.genre)) \
             ORDER BY 4 DESC, 2 DESC LIMIT ?1"
        ))?;
        stmt.query_map(params![limit], |row| {
            Ok(Affinity {
                name: row.get(0)?,
                plays: row.get(1)?,
                ms: row.get(2)?,
                score: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let tracks = {
        let mut stmt = conn.prepare(&format!(
            "SELECT p.track_id, COALESCE(t.title, p.track_id), t.artist, COUNT(*), \
                    COALESCE(SUM(p.ms_played), 0), {decay} \
             FROM plays p LEFT JOIN tracks t ON t.track_id = p.track_id \
             GROUP BY p.track_id \
             ORDER BY 6 DESC, 4 DESC LIMIT ?1"
        ))?;
        stmt.query_map(params![limit], |row| {
            Ok(TrackAffinity {
                track_id: row.get(0)?,
                title: row.get(1)?,
                artist: row.get(2)?,
                plays: row.get(3)?,
                ms: row.get(4)?,
                score: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let co_played = {
        let mut stmt = conn.prepare(
            "SELECT a.track_id, b.track_id, COUNT(*) AS together \
             FROM plays a JOIN plays b \
               ON b.session_id = a.session_id AND b.track_id > a.track_id \
             GROUP BY a.track_id, b.track_id \
             ORDER BY together DESC, a.track_id LIMIT ?1",
        )?;
        stmt.query_map(params![limit], |row| {
            Ok(CoPlayed {
                a: row.get(0)?,
                b: row.get(1)?,
                count: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let liked = {
        let mut stmt = conn.prepare(
            "SELECT track_id FROM ( \
               SELECT track_id, \
                      SUM(CASE WHEN kind = 'like' THEN 1 ELSE 0 END) - \
                      SUM(CASE WHEN kind = 'unlike' THEN 1 ELSE 0 END) AS net \
               FROM events WHERE track_id IS NOT NULL GROUP BY track_id \
             ) WHERE net > 0 ORDER BY track_id",
        )?;
        stmt.query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let skipped = {
        let mut stmt = conn.prepare(
            "SELECT p.track_id FROM plays p \
             WHERE p.completed = 0 AND p.duration_ms > 0 AND p.ms_played * 2 < p.duration_ms \
             GROUP BY p.track_id ORDER BY COUNT(*) DESC, p.track_id LIMIT ?1",
        )?;
        stmt.query_map(params![limit], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let recent = {
        let mut stmt = conn.prepare(
            "SELECT p.track_id FROM plays p GROUP BY p.track_id \
             ORDER BY MAX(p.started_at) DESC LIMIT ?1",
        )?;
        stmt.query_map(params![limit], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };

    Ok(RecommendationSeeds {
        artists,
        genres,
        tracks,
        co_played,
        liked,
        skipped,
        recent,
    })
}

fn count(conn: &Connection, sql: &str) -> Result<i64, String> {
    conn.query_row(sql, [], |row| row.get(0)).map_err(db_error)
}

/// The database plus its write-ahead log, which is what the disk holds.
fn database_size(path: &Path) -> u64 {
    let mut total = 0;
    for suffix in ["", "-wal", "-shm"] {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        if let Ok(meta) = fs::metadata(PathBuf::from(name)) {
            total += meta.len();
        }
    }
    total
}

fn media_type(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "music".to_string()
    } else {
        trimmed.to_lowercase()
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn db_error(error: rusqlite::Error) -> String {
    format!("analytics database error: {error}")
}

/// Renumbers the listening record, for a library whose ids have changed.
pub fn remap_track_ids(app: &AppHandle, map: &HashMap<String, String>) -> Result<(), String> {
    let analytics = app.state::<Analytics>();
    analytics.remap_track_ids(map)
}

#[tauri::command(async)]
pub fn analytics_remember_tracks(
    analytics: State<'_, Analytics>,
    tracks: Vec<TrackSnapshot>,
) -> Result<(), String> {
    analytics.remember_tracks(&tracks)
}

#[tauri::command]
pub fn analytics_record_play(analytics: State<'_, Analytics>, play: PlayRecord) -> Result<(), String> {
    analytics.record_play(&play)
}

#[tauri::command]
pub fn analytics_record_events(
    analytics: State<'_, Analytics>,
    events: Vec<EventRecord>,
) -> Result<(), String> {
    analytics.record_events(&events)
}

#[tauri::command(async)]
pub fn analytics_swell(
    analytics: State<'_, Analytics>,
    from: i64,
    to: i64,
    bucket: String,
) -> Result<SwellSummary, String> {
    analytics.swell(from, to, &bucket)
}

#[tauri::command(async)]
pub fn analytics_top_songs(
    analytics: State<'_, Analytics>,
    from: i64,
    to: i64,
    limit: Option<usize>,
) -> Result<Vec<TopSong>, String> {
    analytics.top_songs(from, to, limit.unwrap_or(TOP_SONGS_LIMIT))
}

#[tauri::command(async)]
pub fn analytics_recommendation_seeds(
    analytics: State<'_, Analytics>,
    limit: Option<usize>,
) -> Result<RecommendationSeeds, String> {
    analytics.recommendation_seeds(limit.unwrap_or(50))
}

#[tauri::command(async)]
pub fn analytics_stats(analytics: State<'_, Analytics>) -> Result<AnalyticsStats, String> {
    analytics.stats()
}

#[tauri::command]
pub fn analytics_clear(analytics: State<'_, Analytics>) -> Result<(), String> {
    analytics.clear()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Analytics {
        Analytics::in_memory()
    }

    fn track(id: &str, artist: &str, album: &str, genre: &str, media_type: &str) -> TrackSnapshot {
        TrackSnapshot {
            id: id.to_string(),
            title: format!("Song {id}"),
            artist: Some(artist.to_string()),
            album: Some(album.to_string()),
            album_artist: Some(artist.to_string()),
            genre: Some(genre.to_string()),
            year: Some(2024),
            duration_ms: 180_000,
            media_type: media_type.to_string(),
            codec: "MP3".to_string(),
        }
    }

    fn play(
        listen_id: &str,
        track_id: &str,
        started_at: i64,
        ms_played: i64,
        completed: bool,
        reason: &str,
    ) -> PlayRecord {
        PlayRecord {
            listen_id: listen_id.to_string(),
            track_id: track_id.to_string(),
            started_at,
            ended_at: Some(started_at + ms_played),
            ms_played,
            duration_ms: 180_000,
            completed,
            reason: reason.to_string(),
            source_id: Some("all".to_string()),
            source_name: Some("All songs".to_string()),
            source_kind: Some("all".to_string()),
            shuffle: false,
            repeat: Some("off".to_string()),
        }
    }

    /// A window wide enough to hold every timestamp a test writes.
    fn span(at: i64) -> (i64, i64) {
        (at - 60 * 60_000, at + 24 * 60 * 60_000)
    }

    fn session_count(store: &Analytics) -> i64 {
        let conn = store.guard();
        count(&conn, "SELECT COUNT(*) FROM sessions").unwrap()
    }

    #[test]
    fn a_play_is_counted_once_and_can_be_finalised() {
        let store = store();
        store
            .remember_tracks(&[track("a", "Artist", "Album", "Pop", "music")])
            .unwrap();

        let at = now_ms();
        // The checkpoint a long song sends part-way through.
        store
            .record_play(&PlayRecord {
                ended_at: None,
                completed: false,
                reason: "open".to_string(),
                ..play("listen-1", "a", at, 30_000, false, "open")
            })
            .unwrap();
        // Then the end of the song.
        store
            .record_play(&play("listen-1", "a", at, 180_000, true, "ended"))
            .unwrap();

        let (from, to) = span(at);
        let summary = store.swell(from, to, "month").unwrap();
        assert_eq!(summary.plays, 1, "a checkpoint and its end are one play");
        assert_eq!(summary.ms_listened, 180_000);
        assert_eq!(summary.top_songs.len(), 1);
        assert_eq!(summary.top_songs[0].plays, 1);
        assert_eq!(summary.top_artists[0].artist, "Artist");
        assert_eq!(summary.top_genres[0].genre, "Pop");
        assert_eq!(summary.top_albums[0].album, "Album");
        assert_eq!(summary.genres_explored, 1);
        assert_eq!(summary.minutes_listened, 3.0);
    }

    #[test]
    fn a_late_checkpoint_cannot_reopen_a_finished_play() {
        let store = store();
        store
            .remember_tracks(&[track("a", "Artist", "Album", "Pop", "music")])
            .unwrap();

        let at = now_ms();
        store
            .record_play(&play("listen-1", "a", at, 180_000, true, "ended"))
            .unwrap();
        store
            .record_play(&PlayRecord {
                ended_at: None,
                completed: false,
                reason: "open".to_string(),
                ..play("listen-1", "a", at, 1_000, false, "open")
            })
            .unwrap();

        let conn = store.guard();
        let (ms, reason, completed): (i64, String, i64) = conn
            .query_row("SELECT ms_played, reason, completed FROM plays", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(ms, 180_000);
        assert_eq!(reason, "ended");
        assert_eq!(completed, 1);
    }

    #[test]
    fn sittings_split_on_a_long_gap() {
        let store = store();
        store
            .remember_tracks(&[track("a", "Artist", "Album", "Pop", "music")])
            .unwrap();

        let at = now_ms();
        store.record_play(&play("one", "a", at, 60_000, true, "ended")).unwrap();
        store
            .record_play(&play("two", "a", at + 5 * 60_000, 60_000, true, "ended"))
            .unwrap();
        assert_eq!(session_count(&store), 1, "five minutes is the same sitting");

        store
            .record_play(&play("three", "a", at + 3 * 60 * 60_000, 60_000, true, "ended"))
            .unwrap();
        assert_eq!(session_count(&store), 2, "three hours is a new sitting");
    }

    #[test]
    fn minutes_are_split_by_media_type() {
        let store = store();
        store
            .remember_tracks(&[
                track("a", "Artist", "Album", "Pop", "music"),
                track("b", "Author", "Book", "Fiction", "audiobook"),
            ])
            .unwrap();

        let at = now_ms();
        store.record_play(&play("one", "a", at, 120_000, true, "ended")).unwrap();
        store
            .record_play(&play("two", "b", at + 60_000, 240_000, true, "ended"))
            .unwrap();

        let (from, to) = span(at);
        let summary = store.swell(from, to, "month").unwrap();
        let music = summary
            .by_media_type
            .iter()
            .find(|total| total.media_type == "music")
            .unwrap();
        let audiobook = summary
            .by_media_type
            .iter()
            .find(|total| total.media_type == "audiobook")
            .unwrap();
        assert_eq!(music.ms, 120_000);
        assert_eq!(audiobook.ms, 240_000);
    }

    #[test]
    fn history_survives_a_song_leaving_the_library() {
        let store = store();
        store
            .remember_tracks(&[track("a", "Artist", "Album", "Pop", "music")])
            .unwrap();
        let at = now_ms();
        store.record_play(&play("one", "a", at, 60_000, true, "ended")).unwrap();

        // A rescan of an emptied library leaves the snapshot alone.
        store.remember_tracks(&[]).unwrap();

        let (from, to) = span(at);
        let summary = store.swell(from, to, "month").unwrap();
        assert_eq!(summary.top_songs[0].title, "Song a");
        assert_eq!(summary.top_artists[0].artist, "Artist");
    }

    #[test]
    fn seeds_carry_likes_skips_and_pairs() {
        let store = store();
        store
            .remember_tracks(&[
                track("a", "Artist", "Album", "Pop", "music"),
                track("b", "Artist", "Album", "Pop", "music"),
            ])
            .unwrap();

        let at = now_ms();
        store.record_play(&play("one", "a", at, 180_000, true, "ended")).unwrap();
        store
            .record_play(&play("two", "b", at + 1_000, 10_000, false, "skipped"))
            .unwrap();
        store
            .record_events(&[
                EventRecord {
                    at,
                    kind: "like".to_string(),
                    track_id: Some("a".to_string()),
                    playlist_id: None,
                    value: None,
                },
                EventRecord {
                    at,
                    kind: "unlike".to_string(),
                    track_id: Some("b".to_string()),
                    playlist_id: None,
                    value: None,
                },
            ])
            .unwrap();

        let seeds = store.recommendation_seeds(10).unwrap();
        assert_eq!(seeds.liked, vec!["a".to_string()]);
        assert_eq!(seeds.skipped, vec!["b".to_string()]);
        assert_eq!(seeds.co_played.len(), 1);
        assert_eq!(seeds.co_played[0].count, 1);
        assert_eq!(seeds.artists[0].name, "Artist");
        assert!(seeds.artists[0].score > 0.0);
    }

    #[test]
    fn clearing_empties_every_table() {
        let store = store();
        store
            .remember_tracks(&[track("a", "Artist", "Album", "Pop", "music")])
            .unwrap();
        let at = now_ms();
        store.record_play(&play("one", "a", at, 60_000, true, "ended")).unwrap();

        store.clear().unwrap();

        let stats = store.stats().unwrap();
        assert_eq!(stats.plays, 0);
        assert_eq!(stats.tracks, 0);
        assert_eq!(stats.sessions, 0);

        let (from, to) = span(at);
        assert!(store.swell(from, to, "month").unwrap().top_songs.is_empty());
    }

    #[test]
    fn a_short_listen_is_kept_but_is_not_a_stream() {
        let store = store();
        store
            .remember_tracks(&[track("a", "Artist", "Album", "Pop", "music")])
            .unwrap();

        let at = now_ms();
        // Ten seconds of a song, then a skip: it counts as time, not as a play.
        store
            .record_play(&play("one", "a", at, 10_000, false, "skipped"))
            .unwrap();

        let (from, to) = span(at);
        let summary = store.swell(from, to, "month").unwrap();
        assert_eq!(summary.listens, 1);
        assert_eq!(summary.plays, 0);
        assert_eq!(summary.ms_listened, 10_000);
        assert!(summary.top_songs.is_empty());
    }

    #[test]
    fn the_sprint_is_bucketed_by_the_unit_asked_for() {
        let store = store();
        store
            .remember_tracks(&[track("a", "Artist", "Album", "Pop", "music")])
            .unwrap();

        let at = now_ms();
        store
            .record_play(&play("one", "a", at, 180_000, true, "ended"))
            .unwrap();

        let (from, to) = span(at);

        let days = store.swell(from, to, "day").unwrap();
        assert_eq!(days.artist_sprint[0].points.len(), 1);
        assert_eq!(days.artist_sprint[0].points[0].count, 1);
        assert_eq!(days.artist_sprint[0].points[0].key.len(), 10, "a day is YYYY-MM-DD");

        let months = store.swell(from, to, "month").unwrap();
        assert_eq!(months.artist_sprint[0].points[0].key.len(), 7);

        let years = store.swell(from, to, "year").unwrap();
        assert_eq!(years.artist_sprint[0].points[0].key.len(), 4);
    }

    #[test]
    fn a_play_outside_the_window_is_left_out() {
        let store = store();
        store
            .remember_tracks(&[track("a", "Artist", "Album", "Pop", "music")])
            .unwrap();

        let at = now_ms();
        store
            .record_play(&play("one", "a", at, 180_000, true, "ended"))
            .unwrap();

        // A window that closes before the play started.
        let summary = store
            .swell(at - 10 * 60_000, at - 5 * 60_000, "month")
            .unwrap();
        assert_eq!(summary.listens, 0);
        assert_eq!(summary.plays, 0);
        assert!(summary.top_artists.is_empty());
    }
}
