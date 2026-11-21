use rusqlite::{Connection, Row, params};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use tauri::{AppHandle, Manager};

use crate::analytics::Analytics;
use crate::catalog::Catalog;
use crate::import_source;
use crate::source::TrackMeta;
use crate::transfer;

#[derive(Debug, Serialize, Deserialize)]
struct Backup {
    format: String,
    version: u32,
    tracks: Vec<Track>,
    sessions: Vec<Session>,
    plays: Vec<Play>,
    events: Vec<Event>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Track {
    id: String,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    album_artist: Option<String>,
    genre: Option<String>,
    year: Option<i64>,
    duration_ms: Option<i64>,
    media_type: Option<String>,
    codec: Option<String>,
    first_seen_at: Option<i64>,
    last_seen_at: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Session {
    id: i64,
    started_at: i64,
    ended_at: i64,
    plays: i64,
    ms_played: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct Play {
    listen_id: String,
    track_id: String,
    started_at: i64,
    ended_at: Option<i64>,
    ms_played: i64,
    duration_ms: i64,
    completed: bool,
    reason: String,
    source_id: Option<String>,
    source_name: Option<String>,
    source_kind: Option<String>,
    shuffle: bool,
    repeat: Option<String>,
    session_id: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Event {
    id: i64,
    at: i64,
    kind: String,
    track_id: Option<String>,
    playlist_id: Option<String>,
    value: Option<String>,
}

fn rows<T>(
    conn: &Connection,
    sql: &str,
    map: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
) -> rusqlite::Result<Vec<T>> {
    conn.prepare(sql)?.query_map([], map)?.collect()
}

fn snapshot(analytics: &Analytics) -> Result<Backup, String> {
    let conn = analytics.guard();
    let read = || -> rusqlite::Result<Backup> {
        Ok(Backup {
            format: "wave-analytics".into(),
            version: 1,
            tracks: rows(
                &conn,
                "SELECT track_id, title, artist, album, album_artist, genre, year, duration_ms, media_type, codec, first_seen_at, last_seen_at FROM tracks",
                |r| {
                    Ok(Track {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        artist: r.get(2)?,
                        album: r.get(3)?,
                        album_artist: r.get(4)?,
                        genre: r.get(5)?,
                        year: r.get(6)?,
                        duration_ms: r.get(7)?,
                        media_type: r.get(8)?,
                        codec: r.get(9)?,
                        first_seen_at: r.get(10)?,
                        last_seen_at: r.get(11)?,
                    })
                },
            )?,
            sessions: rows(
                &conn,
                "SELECT id, started_at, ended_at, plays, ms_played FROM sessions",
                |r| {
                    Ok(Session {
                        id: r.get(0)?,
                        started_at: r.get(1)?,
                        ended_at: r.get(2)?,
                        plays: r.get(3)?,
                        ms_played: r.get(4)?,
                    })
                },
            )?,
            plays: rows(
                &conn,
                "SELECT listen_id, track_id, started_at, ended_at, ms_played, duration_ms, completed, reason, source_id, source_name, source_kind, shuffle, repeat, session_id FROM plays",
                |r| {
                    Ok(Play {
                        listen_id: r.get(0)?,
                        track_id: r.get(1)?,
                        started_at: r.get(2)?,
                        ended_at: r.get(3)?,
                        ms_played: r.get(4)?,
                        duration_ms: r.get(5)?,
                        completed: r.get(6)?,
                        reason: r.get(7)?,
                        source_id: r.get(8)?,
                        source_name: r.get(9)?,
                        source_kind: r.get(10)?,
                        shuffle: r.get(11)?,
                        repeat: r.get(12)?,
                        session_id: r.get(13)?,
                    })
                },
            )?,
            events: rows(
                &conn,
                "SELECT id, at, kind, track_id, playlist_id, value FROM events",
                |r| {
                    Ok(Event {
                        id: r.get(0)?,
                        at: r.get(1)?,
                        kind: r.get(2)?,
                        track_id: r.get(3)?,
                        playlist_id: r.get(4)?,
                        value: r.get(5)?,
                    })
                },
            )?,
        })
    };
    read().map_err(|e| format!("Could not read the listening record: {e}"))
}

fn match_tracks(backup: &mut Backup, catalog: &Catalog) -> Result<(), String> {
    let present: HashSet<String> = catalog
        .tracks()?
        .into_iter()
        .map(|track| track.id)
        .collect();
    let imported: HashSet<&str> = backup
        .tracks
        .iter()
        .map(|track| track.id.as_str())
        .collect();
    let index = import_source::catalog_index(catalog)?;
    let candidates: Vec<(String, String)> = backup
        .tracks
        .iter()
        .filter(|track| !present.contains(&track.id))
        .filter_map(|track| {
            let meta = TrackMeta {
                title: track.title.clone().unwrap_or_default(),
                artists: track.artist.clone().into_iter().collect(),
                album: track.album.clone().unwrap_or_default(),
                album_artist: track.album_artist.clone().unwrap_or_default(),
                release_date: track.year.map(|year| year.to_string()).unwrap_or_default(),
                duration_ms: track.duration_ms.and_then(|ms| u64::try_from(ms).ok()),
                ..TrackMeta::default()
            };
            let id = import_source::held(&index, &meta)?;
            (!imported.contains(id.as_str())).then(|| (track.id.clone(), id.clone()))
        })
        .collect();
    let mut counts = HashMap::new();
    for (_, id) in &candidates {
        *counts.entry(id.clone()).or_insert(0usize) += 1;
    }
    let matches: HashMap<String, String> = candidates
        .into_iter()
        .filter(|(_, id)| counts[id] == 1)
        .collect();
    for track in &mut backup.tracks {
        if let Some(id) = matches.get(&track.id) {
            track.id = id.clone();
        }
    }
    for play in &mut backup.plays {
        if let Some(id) = matches.get(&play.track_id) {
            play.track_id = id.clone();
        }
    }
    for event in &mut backup.events {
        if let Some(id) = event.track_id.as_ref().and_then(|id| matches.get(id)) {
            event.track_id = Some(id.clone());
        }
    }
    Ok(())
}

fn restore(analytics: &Analytics, catalog: &Catalog, bytes: &[u8]) -> Result<(), String> {
    let mut backup: Backup = serde_json::from_slice(bytes)
        .map_err(|e| format!("Could not read the listening record export: {e}"))?;
    if backup.format != "wave-analytics" || backup.version != 1 {
        return Err("This is not a supported Wave listening record export.".into());
    }
    if backup.tracks.iter().any(|track| track.id.is_empty())
        || backup.plays.iter().any(|play| {
            play.listen_id.is_empty()
                || play.track_id.is_empty()
                || play.ms_played < 0
                || play.duration_ms < 0
        })
        || backup
            .sessions
            .iter()
            .any(|session| session.plays < 0 || session.ms_played < 0)
    {
        return Err("The listening record export contains invalid data.".into());
    }
    match_tracks(&mut backup, catalog)?;
    let mut conn = analytics.guard();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let write = || -> rusqlite::Result<()> {
        tx.execute_batch(
            "DELETE FROM plays; DELETE FROM events; DELETE FROM sessions; DELETE FROM tracks;",
        )?;
        {
            let mut stmt = tx.prepare("INSERT INTO tracks (track_id, title, artist, album, album_artist, genre, year, duration_ms, media_type, codec, first_seen_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)")?;
            for t in &backup.tracks {
                stmt.execute(params![
                    t.id,
                    t.title,
                    t.artist,
                    t.album,
                    t.album_artist,
                    t.genre,
                    t.year,
                    t.duration_ms,
                    t.media_type,
                    t.codec,
                    t.first_seen_at,
                    t.last_seen_at
                ])?;
            }
        }
        {
            let mut stmt = tx.prepare("INSERT INTO sessions (id, started_at, ended_at, plays, ms_played) VALUES (?1, ?2, ?3, ?4, ?5)")?;
            for s in &backup.sessions {
                stmt.execute(params![
                    s.id,
                    s.started_at,
                    s.ended_at,
                    s.plays,
                    s.ms_played
                ])?;
            }
        }
        {
            let mut stmt = tx.prepare("INSERT INTO plays (listen_id, track_id, started_at, ended_at, ms_played, duration_ms, completed, reason, source_id, source_name, source_kind, shuffle, repeat, session_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)")?;
            for p in &backup.plays {
                stmt.execute(params![
                    p.listen_id,
                    p.track_id,
                    p.started_at,
                    p.ended_at,
                    p.ms_played,
                    p.duration_ms,
                    p.completed,
                    p.reason,
                    p.source_id,
                    p.source_name,
                    p.source_kind,
                    p.shuffle,
                    p.repeat,
                    p.session_id
                ])?;
            }
        }
        {
            let mut stmt = tx.prepare("INSERT INTO events (id, at, kind, track_id, playlist_id, value) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?;
            for e in &backup.events {
                stmt.execute(params![
                    e.id,
                    e.at,
                    e.kind,
                    e.track_id,
                    e.playlist_id,
                    e.value
                ])?;
            }
        }
        Ok(())
    };
    write().map_err(|e| format!("Could not import the listening record: {e}"))?;
    tx.commit()
        .map_err(|e| format!("Could not import the listening record: {e}"))
}

#[tauri::command]
pub async fn export_analytics(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let analytics = app.state::<Analytics>();
        if !analytics.path().as_os_str().is_empty()
            && fs::canonicalize(&path)
                .ok()
                .zip(fs::canonicalize(analytics.path()).ok())
                .is_some_and(|(target, database)| target == database)
        {
            return Err("Choose a different file from the listening database.".into());
        }
        let bytes = serde_json::to_vec(&snapshot(&analytics)?).map_err(|e| e.to_string())?;
        transfer::write_bytes(&app, &path, &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn populated() -> Analytics {
        let analytics = Analytics::in_memory();
        analytics.guard().execute_batch("
            INSERT INTO tracks VALUES ('song', 'Title', 'Artist', 'Album', 'Artist', 'Rock', 2020, 180000, 'music', 'MP3', 10, 20);
            INSERT INTO sessions VALUES (7, 1000, 61000, 1, 60000);
            INSERT INTO plays VALUES ('listen', 'song', 1000, 61000, 60000, 180000, 1, 'ended', 'all', 'All songs', 'all', 1, 'off', 7);
            INSERT INTO events VALUES (5, 2000, 'like', 'song', NULL, NULL);
        ").unwrap();
        analytics
    }

    #[test]
    fn round_trip_replaces_all_rows_and_keeps_session_links() {
        let source = populated();
        let bytes = serde_json::to_vec(&snapshot(&source).unwrap()).unwrap();
        let target = populated();
        target
            .guard()
            .execute("INSERT INTO events (at, kind) VALUES (9, 'unlike')", [])
            .unwrap();
        restore(&target, &Catalog::in_memory().unwrap(), &bytes).unwrap();
        assert_eq!(
            serde_json::to_value(snapshot(&source).unwrap()).unwrap(),
            serde_json::to_value(snapshot(&target).unwrap()).unwrap()
        );
        let stats = target.stats().unwrap();
        assert_eq!(
            (
                stats.tracks,
                stats.plays,
                stats.sessions,
                stats.events,
                stats.ms_listened
            ),
            (1, 1, 1, 1, 60000)
        );
        assert_eq!(target.play_counts().unwrap().get("song"), Some(&1));
    }

    #[test]
    fn invalid_imports_leave_the_existing_record_untouched() {
        let target = populated();
        let before = serde_json::to_value(snapshot(&target).unwrap()).unwrap();
        let mut invalid = before.clone();
        invalid["version"] = 2.into();
        let catalog = Catalog::in_memory().unwrap();
        assert!(restore(&target, &catalog, &serde_json::to_vec(&invalid).unwrap()).is_err());
        assert!(restore(&target, &catalog, b"not json").is_err());
        invalid = before.clone();
        invalid["plays"][0]["session_id"] = 999.into();
        assert!(restore(&target, &catalog, &serde_json::to_vec(&invalid).unwrap()).is_err());
        invalid = before.clone();
        let duplicate = invalid["events"][0].clone();
        invalid["events"].as_array_mut().unwrap().push(duplicate);
        assert!(restore(&target, &catalog, &serde_json::to_vec(&invalid).unwrap()).is_err());
        assert_eq!(
            serde_json::to_value(snapshot(&target).unwrap()).unwrap(),
            before
        );
    }

    #[test]
    fn matches_history_to_a_single_library_track_without_guessing_ambiguous_matches() {
        let source = populated();
        let bytes = serde_json::to_vec(&snapshot(&source).unwrap()).unwrap();
        let catalog = Catalog::in_memory().unwrap();
        let row = |id: &str| crate::catalog::TrackRow {
            id: id.into(),
            rel_path: format!("{id}.mp3"),
            title: "Title".into(),
            artist: Some("Artist".into()),
            album: Some("Album".into()),
            album_artist: Some("Artist".into()),
            year: Some(2020),
            duration_ms: 180000,
            ..crate::catalog::TrackRow::default()
        };
        catalog.upsert_track(&row("new")).unwrap();
        let target = Analytics::in_memory();
        restore(&target, &catalog, &bytes).unwrap();
        let backup = snapshot(&target).unwrap();
        assert_eq!(backup.tracks[0].id, "new");
        assert_eq!(backup.plays[0].track_id, "new");
        assert_eq!(backup.events[0].track_id.as_deref(), Some("new"));

        catalog.upsert_track(&row("another")).unwrap();
        restore(&target, &catalog, &bytes).unwrap();
        let backup = snapshot(&target).unwrap();
        assert_eq!(backup.tracks[0].id, "song");
        assert_eq!(backup.plays[0].track_id, "song");
    }
}

#[tauri::command]
pub async fn import_analytics(app: AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = transfer::read_bytes(&app, &path)?;
        restore(&app.state::<Analytics>(), &app.state::<Catalog>(), &bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}
