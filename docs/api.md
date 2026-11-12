# The local API

While Wave runs it serves a small HTTP API on the loopback interface, so a script, a test harness or a companion tool can drive the copy that is already open. It is on by default: the app binds `127.0.0.1:45679` when it starts and nothing has to be switched on. The port is a fixed default because Spotify's OAuth callback already owns 45678.

Nothing leaves the machine. The server binds the loopback address only, and there is no token: it checks the `Host` header against `127.0.0.1` and `localhost`, so a page that resolves a name to 127.0.0.1 (DNS rebinding) cannot reach it, and it sends no CORS headers, so a browser cannot read a reply. It is an API for programs on the same machine.

Everything Rust owns is answered in Rust. Playback is the exception, because the player lives in the window: a playback command is relayed to the window and the reply is what the window reports back. See [Playback commands and the window](#playback-commands-and-the-window).

## Turning it off and moving the port

Both switches live in the config `.env`, the same file the Spotify credentials and the tool overrides use. Wave writes a commented template there on first run, and the import dialog's **Spotify** section has an **Open the config folder** button. The file is:

- Windows: `%APPDATA%\com.wave.app\library\config\.env`
- Linux: `~/.local/share/com.wave.app/library/config/.env`

A script does not have to hard-code that path. `GET /api/library` returns it as `config`, and so does `GET /api/tools`.

```dotenv
# Switches the local API off. 0 or off, in any case, means off; anything else,
# or leaving the key out, leaves it on.
WAVE_API=0

# Moves the API to another port.
WAVE_API_PORT=45700
```

Both keys are read when Wave starts, so a change takes effect the next time the app opens. If the port is already taken, Wave says so on stderr and carries on without the server: nothing about the app depends on it, and `WAVE_API_PORT` is the way out.

## Replies and errors

Every reply is JSON, with `Content-Type: application/json`. A reply that worked is `200` with the object or array the endpoint describes.

A reply that did not is a single `error` field holding a sentence:

```json
{ "error": "nothing in the library answers to duality" }
```

The codes:

- `400` the request could not be read: a body that is not JSON, a field of the wrong type, or a value out of range.
- `404` there is nothing at that id or path.
- `409` the request cannot be done in the state the app is in, such as a playlist name that is already taken.
- `500` something failed while doing the work.
- `503` a playback command the window did not acknowledge in time, and nothing was changed. See below.

## Playback commands and the window

Every `POST` and `DELETE` under `/api/player` is applied by the window, not by the server. Rust sends the command over and waits up to 500 ms for the window to report it as applied. The reply is then the player state as it stands after the command, the same object `GET /api/player` returns, so `POST /api/player/play` answers with what is playing rather than "accepted". A window that does not answer within that time is a `503`, and the error says the command was not applied, so a script fails fast instead of waiting forever and never has to guess whether the command landed.

A command that needs the library, such as `{trackId}` on `POST /api/player/play`, is resolved in Rust before it is sent, so a song that is not there is a `404` and never reaches the window.

## Meta

### GET /api

The endpoint index: every path the API serves, each with its method and a description. This is the list the rest of this document walks through.

```sh
curl -s http://127.0.0.1:45679/api
```

```json
[
  { "method": "GET", "path": "/api/health", "description": "What this is, and how long it has been up" },
  { "method": "GET", "path": "/api/player", "description": "What the player is showing and doing" }
]
```

### GET /api/health

What this is, which version of Wave is answering, the API version, the port it is on, and how long the server has been up.

```sh
curl -s http://127.0.0.1:45679/api/health
```

```json
{ "name": "Wave", "version": "0.1.4", "api": 1, "port": 45679, "uptimeMs": 184223 }
```

## Player

Every `POST` and `DELETE` here is applied by the window and answers with the fresh player state; [Playback commands and the window](#playback-commands-and-the-window) says what happens when the window does not answer.

### GET /api/player

What the player is showing and doing, as the window last reported it.

`ready` is `false` until the window has reported at all, which is the case for a moment after launch; nothing else in the object means much until it is `true`. `track` is the current song, in the song shape the Library section gives, or `null` when nothing is loaded. `queue` is the play order as track ids. `repeat` is `off` or `all`. `volume` is `0` to `100`.

```sh
curl -s http://127.0.0.1:45679/api/player
```

```json
{
  "ready": true,
  "track": {
    "id": "6f0a3c1e-2b9d-4f7a-9c31-8d5e0a4b7c12",
    "title": "Duality",
    "artist": "Slipknot",
    "album": "Vol. 3: (The Subliminal Verses)",
    "durationMs": 214000
  },
  "sourceId": "liked",
  "sourceName": "Liked Songs",
  "queue": ["6f0a3c1e-2b9d-4f7a-9c31-8d5e0a4b7c12", "9c1d5b70-4e18-4a2f-8d63-1b7c9e0f4a58"],
  "positionMs": 41250,
  "durationMs": 214000,
  "playing": true,
  "shuffle": false,
  "repeat": "off",
  "volume": 70,
  "muted": false
}
```

### GET /api/player/queue

The queue in play order, each entry resolved to a song, with the current one marked. An array, in the order the songs play. Answered from the last report Rust holds, so it does not wait on the window.

```sh
curl -s http://127.0.0.1:45679/api/player/queue
```

```json
[
  { "id": "6f0a3c1e-2b9d-4f7a-9c31-8d5e0a4b7c12", "current": true, "track": { "id": "6f0a3c1e-2b9d-4f7a-9c31-8d5e0a4b7c12", "title": "Duality", "artist": "Slipknot" } },
  { "id": "9c1d5b70-4e18-4a2f-8d63-1b7c9e0f4a58", "current": false, "track": { "id": "9c1d5b70-4e18-4a2f-8d63-1b7c9e0f4a58", "title": "Eyeless", "artist": "Slipknot" } }
]
```

`track` is `null` for an id the library no longer holds, so the queue can be read back even when a song has gone.

### POST /api/player/play

Three ways to start something, and the body says which:

- `{}`, or no body at all: resume the queue where it left off.
- `{ "trackId": "..." }`: play that song in its own context, which is what clicking it in the window does.
- `{ "query": "..." }`: play the song a search finds. The search is the one the whole app agrees on, the same matching `wave search` uses: a track id is itself, and anything else is matched on title, artist and album together, folded so case, accents and stray spacing do not matter. A query that finds nothing is a `404`. A query that finds several plays the first of them, which is the one the search ranks first, so a search for an artist plays a song by that artist rather than refusing.

```sh
curl -s -X POST http://127.0.0.1:45679/api/player/play \
  -H "Content-Type: application/json" \
  -d '{"query":"duality"}'
```

Returns the fresh player state.

### POST /api/player/pause

Pauses. Takes no body. Returns the fresh player state.

```sh
curl -s -X POST http://127.0.0.1:45679/api/player/pause
```

### POST /api/player/toggle

Pauses if it is playing and plays if it is not. Takes no body. Returns the fresh player state.

```sh
curl -s -X POST http://127.0.0.1:45679/api/player/toggle
```

### POST /api/player/next

The next song in the queue. Takes no body. Returns the fresh player state.

```sh
curl -s -X POST http://127.0.0.1:45679/api/player/next
```

### POST /api/player/previous

The previous song in the queue. Takes no body. Returns the fresh player state.

```sh
curl -s -X POST http://127.0.0.1:45679/api/player/previous
```

### POST /api/player/stop

Stops: the song stays loaded and the position goes back to the start. Takes no body. Returns the fresh player state.

```sh
curl -s -X POST http://127.0.0.1:45679/api/player/stop
```

### POST /api/player/seek

Moves the position. Send exactly one of:

- `{ "positionMs": 60000 }` an absolute position in milliseconds.
- `{ "fraction": 0.5 }` a fraction of the song, `0` to `1`.
- `{ "byMs": -10000 }` a step from where it is now, positive or negative.

```sh
curl -s -X POST http://127.0.0.1:45679/api/player/seek \
  -H "Content-Type: application/json" \
  -d '{"fraction":0.5}'
```

Returns the fresh player state.

### POST /api/player/volume

Sets the volume. Send exactly one of:

- `{ "volume": 40 }` an absolute level, `0` to `100`.
- `{ "by": -5 }` a step from the level it is at now.

```sh
curl -s -X POST http://127.0.0.1:45679/api/player/volume \
  -H "Content-Type: application/json" \
  -d '{"volume":40}'
```

Returns the fresh player state. The level is saved in settings as well, so it is where the user left it next time.

### POST /api/player/mute

Mutes or unmutes, from `{ "muted": true }`.

```sh
curl -s -X POST http://127.0.0.1:45679/api/player/mute \
  -H "Content-Type: application/json" \
  -d '{"muted":true}'
```

Returns the fresh player state.

### POST /api/player/shuffle

Turns shuffle on or off, from `{ "on": true }`.

```sh
curl -s -X POST http://127.0.0.1:45679/api/player/shuffle \
  -H "Content-Type: application/json" \
  -d '{"on":true}'
```

Returns the fresh player state.

### POST /api/player/repeat

Sets repeat from `{ "mode": "all" }`. The mode is `off` or `all`.

```sh
curl -s -X POST http://127.0.0.1:45679/api/player/repeat \
  -H "Content-Type: application/json" \
  -d '{"mode":"all"}'
```

Returns the fresh player state.

### POST /api/player/queue

Replaces the queue from `{ "trackIds": [...], "sourceId": "...", "sourceName": "...", "startTrackId": "..." }`.

`trackIds` is the queue in the order it should play. `sourceId` and `sourceName` name the collection it came from, which is what the window shows as the current source; a queue built by hand can leave both out. `startTrackId` says which song to start on, and defaults to the first.

```sh
curl -s -X POST http://127.0.0.1:45679/api/player/queue \
  -H "Content-Type: application/json" \
  -d '{"trackIds":["6f0a3c1e-2b9d-4f7a-9c31-8d5e0a4b7c12","9c1d5b70-4e18-4a2f-8d63-1b7c9e0f4a58"],"sourceId":"liked","sourceName":"Liked Songs"}'
```

Returns the fresh player state.

### POST /api/player/queue/append

Puts one song on the end of the queue, from `{ "trackId": "..." }`.

```sh
curl -s -X POST http://127.0.0.1:45679/api/player/queue/append \
  -H "Content-Type: application/json" \
  -d '{"trackId":"6f0a3c1e-2b9d-4f7a-9c31-8d5e0a4b7c12"}'
```

Returns the fresh player state.

### POST /api/player/queue/next

Puts one song straight after the current one, from `{ "trackId": "..." }`.

```sh
curl -s -X POST http://127.0.0.1:45679/api/player/queue/next \
  -H "Content-Type: application/json" \
  -d '{"trackId":"6f0a3c1e-2b9d-4f7a-9c31-8d5e0a4b7c12"}'
```

Returns the fresh player state.

### DELETE /api/player/queue/{trackId}

Takes one song out of the queue. `{trackId}` is the song's id.

```sh
curl -s -X DELETE http://127.0.0.1:45679/api/player/queue/6f0a3c1e-2b9d-4f7a-9c31-8d5e0a4b7c12
```

Returns the fresh player state.

### POST /api/player/collections/{id}/play

Plays a collection: a playlist, an album, an artist, the whole library or Liked Songs. Takes no body.

`{id}` is the collection id the window uses:

- `all` the whole library
- `liked` Liked Songs
- a playlist id
- `album:<name>`, `artist:<name>` or `genre:<name>`, with the name in lower case

A name with a space or a colon in it is percent-encoded in the URL.

```sh
curl -s -X POST http://127.0.0.1:45679/api/player/collections/liked/play
curl -s -X POST "http://127.0.0.1:45679/api/player/collections/album:vol.%203%3A%20(the%20subliminal%20verses)/play"
```

Returns the fresh player state. An id the window does not know is a `404`.

### POST /api/player/collections/{id}/open

Loads a collection without starting it: the queue is replaced and the player holds it, paused at the first song. Takes no body, and takes the same ids as `/play`.

```sh
curl -s -X POST http://127.0.0.1:45679/api/player/collections/liked/open
```

Returns the fresh player state.

## Library

Songs are returned in one shape, the same one `wave list --json` prints. Every field is always there; the ones the tags do not carry are `null`.

```json
{
  "id": "6f0a3c1e-2b9d-4f7a-9c31-8d5e0a4b7c12",
  "path": "C:\\Users\\you\\AppData\\Roaming\\com.wave.app\\library\\songs\\6f0a3c1e-2b9d-4f7a-9c31-8d5e0a4b7c12\\audio.mp3",
  "relativePath": "songs/6f0a3c1e-2b9d-4f7a-9c31-8d5e0a4b7c12/audio.mp3",
  "title": "Duality",
  "artist": "Slipknot",
  "album": "Vol. 3: (The Subliminal Verses)",
  "albumArtist": "Slipknot",
  "trackNo": 1,
  "discNo": 1,
  "year": 2004,
  "genre": "Metal",
  "durationMs": 214000,
  "codec": "MP3",
  "bitrate": 320,
  "sampleRate": 44100,
  "artworkPath": "C:\\Users\\you\\AppData\\Roaming\\com.wave.app\\library\\songs\\6f0a3c1e-2b9d-4f7a-9c31-8d5e0a4b7c12\\cover.jpg",
  "lyricsPath": null,
  "hasEmbeddedArt": true,
  "lufs": -8.4,
  "peak": 0.98
}
```

`lufs` and `peak` are the loudness measurement, and are `null` until the song has been measured.

### GET /api/library

Where the library is and what it holds: the library root, how many songs it has, how many of them are missing, the size of the catalog in bytes, and the paths of the state file, the config and the import log.

```sh
curl -s http://127.0.0.1:45679/api/library
```

```json
{
  "root": "C:\\Users\\you\\AppData\\Roaming\\com.wave.app\\library",
  "songs": 412,
  "missing": 2,
  "databaseBytes": 1823456,
  "state": "C:\\Users\\you\\AppData\\Roaming\\com.wave.app\\state.json",
  "config": "C:\\Users\\you\\AppData\\Roaming\\com.wave.app\\library\\config\\.env",
  "log": "C:\\Users\\you\\AppData\\Roaming\\com.wave.app\\logs\\import.log"
}
```

### GET /api/tracks

The library in title order, as the count and the songs themselves.

- `q` a search. It is matched exactly as `wave search` matches it, so a track id is itself and anything else is matched on title, artist and album together, folded so case, accents and stray spacing do not matter.
- `limit` the most songs to return.
- `offset` how many songs to skip first, for paging.

All three are optional. Without `limit`, every match is returned. `total` is how many the query matched, before `limit` and `offset` are applied, so it is what a script pages against.

```sh
curl -s "http://127.0.0.1:45679/api/tracks?q=slipknot&limit=10"
```

```json
{
  "total": 2,
  "tracks": [
    { "id": "6f0a3c1e-...", "title": "Duality", "artist": "Slipknot", "durationMs": 214000 },
    { "id": "9c1d5b70-...", "title": "Eyeless", "artist": "Slipknot", "durationMs": 196000 }
  ]
}
```

### GET /api/tracks/{id}

One song, in the shape above. There is no such song is a `404`.

```sh
curl -s http://127.0.0.1:45679/api/tracks/6f0a3c1e-2b9d-4f7a-9c31-8d5e0a4b7c12
```

### POST /api/library/scan

Re-reads the library folder and brings the catalog in line with what is on disk. Takes no body. Returns the summary the window's own scan returns: the songs it found, the root it read, how many files it left alone because they are not music, and anything that went wrong.

The window is told as well, so it applies the result exactly as if it had scanned itself.

```sh
curl -s -X POST http://127.0.0.1:45679/api/library/scan
```

```json
{
  "tracks": [ { "id": "6f0a3c1e-...", "title": "Duality" } ],
  "root": "C:\\Users\\you\\AppData\\Roaming\\com.wave.app\\library",
  "skipped": 3,
  "errors": []
}
```

### POST /api/likes

Puts songs into Liked Songs or takes them out again, from `{ "trackIds": [...], "liked": true }`. `liked` is `true` to like them and `false` to unlike them.

```sh
curl -s -X POST http://127.0.0.1:45679/api/likes \
  -H "Content-Type: application/json" \
  -d '{"trackIds":["6f0a3c1e-2b9d-4f7a-9c31-8d5e0a4b7c12"],"liked":true}'
```

Returns the whole persisted state, with the likes as they now are. The window follows the change from the same state.

### DELETE /api/tracks

Deletes songs and their files, from `{ "trackIds": [...] }`. Their entries in playlists and their likes go with them.

```sh
curl -s -X DELETE http://127.0.0.1:45679/api/tracks \
  -H "Content-Type: application/json" \
  -d '{"trackIds":["6f0a3c1e-2b9d-4f7a-9c31-8d5e0a4b7c12"]}'
```

Returns the whole persisted state. If none of the ids are in the library it is a `404` and nothing is deleted.

### GET /api/logs/import

The path of the download log and the tail of it, so a download that went wrong can be read back. The file holds the last import only.

- `lines` how many of the last lines to return, `200` by default.

```sh
curl -s "http://127.0.0.1:45679/api/logs/import?lines=50"
```

```json
{
  "path": "C:\\Users\\you\\AppData\\Roaming\\com.wave.app\\logs\\import.log",
  "tail": ["Wave download log", "Started 2026-11-12 20:14:02", "Source: spotify"]
}
```

`tail` is the last `lines` lines, oldest first. A log that is not there yet is an empty array, not an error.

## Playlists

A playlist is returned as:

```json
{
  "id": "3a7e1c94-5b02-4d18-8f6a-2c9b7e0d4f31",
  "name": "Hindsight",
  "trackIds": ["6f0a3c1e-..."],
  "createdAt": 1762800000000,
  "kind": "custom",
  "entries": ["6f0a3c1e-...", "b41c8e20-..."],
  "pending": []
}
```

`kind` is `custom` for one built by hand and `generated` for one Wave filled. `entries` is the playlist in play order and includes songs that are not downloaded yet; `trackIds` is the ones the library actually holds. `pending` carries the metadata of the entries the library does not hold yet, so they can still be named.

### GET /api/playlists

Every playlist.

```sh
curl -s http://127.0.0.1:45679/api/playlists
```

```json
[
  { "id": "3a7e1c94-...", "name": "Hindsight", "trackIds": ["6f0a3c1e-..."], "createdAt": 1762800000000, "kind": "custom", "entries": ["6f0a3c1e-..."], "pending": [] }
]
```

### GET /api/playlists/{id}

One playlist and its songs in play order, with the entries the library is still waiting on marked. `playlist` is the playlist as the Playlists section above gives it; `entries` is the play order, each entry resolved to its song. There is no such playlist is a `404`.

```sh
curl -s http://127.0.0.1:45679/api/playlists/3a7e1c94-5b02-4d18-8f6a-2c9b7e0d4f31
```

```json
{
  "playlist": {
    "id": "3a7e1c94-5b02-4d18-8f6a-2c9b7e0d4f31",
    "name": "Hindsight",
    "kind": "generated",
    "createdAt": 1762800000000,
    "trackIds": ["6f0a3c1e-..."],
    "entries": ["6f0a3c1e-...", "b41c8e20-..."],
    "pending": [ { "id": "b41c8e20-...", "title": "Hindsight", "artists": ["Built to Spill"] } ]
  },
  "entries": [
    { "id": "6f0a3c1e-...", "pending": false, "track": { "id": "6f0a3c1e-...", "title": "Duality", "artist": "Slipknot" } },
    { "id": "b41c8e20-...", "pending": true, "track": null }
  ]
}
```

`pending` is `true` for an entry the playlist is still waiting to download, and `track` is `null` for one, so a waiting entry can still be listed and named from the `pending` metadata on the playlist itself.

### POST /api/playlists

Creates an empty playlist from `{ "name": "..." }`. A name that is already taken is a `409`.

```sh
curl -s -X POST http://127.0.0.1:45679/api/playlists \
  -H "Content-Type: application/json" \
  -d '{"name":"Hindsight"}'
```

Returns the whole persisted state, which is where the new playlist appears.

### PATCH /api/playlists/{id}

Renames a playlist from `{ "name": "..." }`. A name that is already taken is a `409`; there is no such playlist is a `404`.

```sh
curl -s -X PATCH http://127.0.0.1:45679/api/playlists/3a7e1c94-5b02-4d18-8f6a-2c9b7e0d4f31 \
  -H "Content-Type: application/json" \
  -d '{"name":"Hindsight 2"}'
```

Returns the whole persisted state.

### DELETE /api/playlists/{id}

Deletes a playlist. The songs stay in the library.

```sh
curl -s -X DELETE http://127.0.0.1:45679/api/playlists/3a7e1c94-5b02-4d18-8f6a-2c9b7e0d4f31
```

Returns the whole persisted state.

### POST /api/playlists/{id}/tracks

Adds songs to a playlist, from `{ "trackIds": [...] }`.

```sh
curl -s -X POST http://127.0.0.1:45679/api/playlists/3a7e1c94-5b02-4d18-8f6a-2c9b7e0d4f31/tracks \
  -H "Content-Type: application/json" \
  -d '{"trackIds":["6f0a3c1e-2b9d-4f7a-9c31-8d5e0a4b7c12"]}'
```

Returns the whole persisted state.

### DELETE /api/playlists/{id}/tracks

Takes songs out of a playlist, from `{ "trackIds": [...] }`. The songs stay in the library.

```sh
curl -s -X DELETE http://127.0.0.1:45679/api/playlists/3a7e1c94-5b02-4d18-8f6a-2c9b7e0d4f31/tracks \
  -H "Content-Type: application/json" \
  -d '{"trackIds":["6f0a3c1e-2b9d-4f7a-9c31-8d5e0a4b7c12"]}'
```

Returns the whole persisted state.

### PUT /api/playlists/{id}/tracks

Sets the order of a playlist, from `{ "trackIds": [...] }`. The list is the whole playlist in the order wanted, not a move: send every id the playlist should hold, in the sequence it should hold them.

```sh
curl -s -X PUT http://127.0.0.1:45679/api/playlists/3a7e1c94-5b02-4d18-8f6a-2c9b7e0d4f31/tracks \
  -H "Content-Type: application/json" \
  -d '{"trackIds":["9c1d5b70-4e18-4a2f-8d63-1b7c9e0f4a58","6f0a3c1e-2b9d-4f7a-9c31-8d5e0a4b7c12"]}'
```

Returns the whole persisted state.

## Settings and state

### GET /api/settings

The settings, as they are saved.

```sh
curl -s http://127.0.0.1:45679/api/settings
```

```json
{
  "theme": "adaptive",
  "volume": 70,
  "normalizeVolume": true,
  "recentColours": [],
  "resumeOnLaunch": true,
  "reduceMotion": "system",
  "rememberWindow": true,
  "alwaysOnTop": false,
  "miniPlayer": false,
  "miniCorner": 4,
  "searchAlgorithm": "substring",
  "shortcutSlots": [],
  "analyticsEnabled": true,
  "systemMediaControls": true,
  "discordPresence": false,
  "autoUpdate": true
}
```

`reduceMotion` is `system`, `on` or `off`. `searchAlgorithm` names one of the matching algorithms the window offers. `miniCorner` is `1` to `4`. `shortcutSlots` is the nine `Ctrl+Shift+1..9` action slots, empty strings where a slot is unset.

### PATCH /api/settings

A partial settings object, merged onto the current one, so only the keys that should change need sending. The merge is shallow: a key that is sent replaces what was there, and a key that is not sent is left alone.

```sh
curl -s -X PATCH http://127.0.0.1:45679/api/settings \
  -H "Content-Type: application/json" \
  -d '{"volume":40,"discordPresence":true}'
```

Returns the whole persisted state, with the merged settings in it. The window follows the change from the same state, and `volume` is applied to the player as well, so the level it is playing at follows.

### GET /api/state

The whole persisted state: settings, playlists, likes, artwork colours, the last session, the window's geometry and its saved slots, the last few imports, the Spotify answer and the newer release last found.

```sh
curl -s http://127.0.0.1:45679/api/state
```

```json
{
  "settings": { "theme": "adaptive", "volume": 70 },
  "playlists": [ { "id": "3a7e1c94-...", "name": "Hindsight" } ],
  "likes": ["6f0a3c1e-..."],
  "artworkColours": { "6f0a3c1e-...": "#8e6fd0" },
  "session": {
    "playback": { "sourceId": "liked", "sourceName": "Liked Songs", "sourceOrder": [], "order": [], "cursor": 0, "positionMs": 0, "shuffle": false, "repeat": "off", "muted": false },
    "recents": [],
    "filter": "all",
    "sort": "name",
    "queueOpen": false
  },
  "window": { "width": 900, "height": 655, "x": 120, "y": 80, "monitor": "\\\\.\\DISPLAY1", "maximized": false },
  "windowSlots": [],
  "recentImports": [],
  "spotify": null,
  "update": null
}
```

## Tools and the listening record

### GET /api/tools

The download tools and the config, the same report `wave tools --json` prints: whether yt-dlp, ffmpeg and Deno were found and where each came from, whether the Spotify credentials are set, the path of the config, and what is missing if anything is.

```sh
curl -s http://127.0.0.1:45679/api/tools
```

```json
{
  "ytDlp": true,
  "ytDlpSource": "yt-dlp (bundled with Wave)",
  "ffmpeg": true,
  "deno": true,
  "denoSource": "bundled with Wave",
  "spotify": true,
  "config": "C:\\Users\\you\\AppData\\Roaming\\com.wave.app\\library\\config\\.env",
  "problem": null
}
```

### GET /api/analytics/stats

What the listening record holds: where the database is and how big it is, and how many plays, songs, sittings and events it has, with the total time listened and the first and last play.

```sh
curl -s http://127.0.0.1:45679/api/analytics/stats
```

```json
{
  "path": "C:\\Users\\you\\AppData\\Roaming\\com.wave.app\\analytics.db",
  "sizeBytes": 442368,
  "plays": 1820,
  "tracks": 412,
  "sessions": 96,
  "events": 214,
  "msListened": 214800000,
  "firstPlayAt": 1759000000000,
  "lastPlayAt": 1762900000000
}
```

`firstPlayAt` and `lastPlayAt` are Unix times in milliseconds, and are `null` while the record is empty.

### GET /api/analytics/top-songs

The songs listened to most in a window, each with its stream count and how much of it was heard.

- `from` and `to` Unix times in milliseconds. `from` is included and `to` is not. Left out, the whole record is read.
- `limit` how many songs to return, `100` by default.

A play counts as a stream when the song was played to the end, or when at least 30 seconds of it were heard.

```sh
curl -s "http://127.0.0.1:45679/api/analytics/top-songs?from=1761900000000&to=1762900000000&limit=10"
```

```json
[
  { "trackId": "6f0a3c1e-...", "title": "Duality", "artist": "Slipknot", "album": "Vol. 3: (The Subliminal Verses)", "plays": 42, "ms": 8988000 }
]
```

### GET /api/analytics/swell

Everything the Wave Swell pane shows for one window: the minutes listened and the time listened, split by music, audiobooks and podcasts; the stream and listen counts; the unique songs and artists; the first and last play; and the top songs, artists, genres and albums, with the top five artists bucket by bucket.

- `from` and `to` Unix times in milliseconds. `from` is included and `to` is not. Left out, the whole record is read.
- `bucket` the size of the buckets the artist movement is grouped into: `day`, `month` or `year`. `month` is the default.

```sh
curl -s "http://127.0.0.1:45679/api/analytics/swell?from=1761900000000&to=1762900000000&bucket=day"
```

```json
{
  "from": 1761900000000,
  "to": 1762900000000,
  "minutesListened": 3580.0,
  "msListened": 214800000,
  "plays": 1820,
  "listens": 2104,
  "uniqueTracks": 288,
  "uniqueArtists": 61,
  "firstPlayAt": 1761904212000,
  "lastPlayAt": 1762898711000,
  "byMediaType": [ { "mediaType": "music", "plays": 1801, "ms": 212300000 } ],
  "topSongs": [ { "trackId": "6f0a3c1e-...", "title": "Duality", "artist": "Slipknot", "album": "Vol. 3: (The Subliminal Verses)", "plays": 42, "ms": 8988000 } ],
  "topArtists": [ { "artist": "Slipknot", "plays": 118, "ms": 25208000 } ],
  "artistSprint": [ { "artist": "Slipknot", "points": [ { "key": "2026-11-12", "count": 9 } ] } ],
  "topGenres": [ { "genre": "Metal", "plays": 402, "ms": 86028000 } ],
  "genresExplored": 14,
  "topAlbums": [ { "album": "Vol. 3: (The Subliminal Verses)", "albumArtist": "Slipknot", "plays": 42, "ms": 8988000 } ]
}
```

A bucket key is `2026-11-12` for a day, `2026-11` for a month and `2026` for a year.

### GET /api/analytics/seeds

The raw material a recommender would work from: the artists, genres and songs ranked by a recency-weighted score, the pairs of songs heard in the same sitting, the likes, the songs abandoned early, and the recent ones.

- `limit` how many entries each ranking keeps, `50` by default.

```sh
curl -s "http://127.0.0.1:45679/api/analytics/seeds?limit=20"
```

```json
{
  "artists": [ { "name": "Slipknot", "plays": 118, "ms": 25208000, "score": 14.2 } ],
  "genres": [ { "name": "Metal", "plays": 402, "ms": 86028000, "score": 41.7 } ],
  "tracks": [ { "trackId": "6f0a3c1e-...", "title": "Duality", "artist": "Slipknot", "plays": 42, "ms": 8988000, "score": 6.1 } ],
  "coPlayed": [ { "a": "6f0a3c1e-...", "b": "9c1d5b70-...", "count": 7 } ],
  "liked": ["6f0a3c1e-..."],
  "skipped": ["9c1d5b70-..."],
  "recent": ["6f0a3c1e-..."]
}
```

### DELETE /api/analytics

Clears the listening record: every play, sitting, snapshot and event goes, leaving the file and its schema in place. There is no undo. Takes no body.

```sh
curl -s -X DELETE http://127.0.0.1:45679/api/analytics
```

Returns `null`.

## Two notes about the examples

The ids and the paths in the examples are placeholders. Real ids come from `GET /api/tracks` and `GET /api/playlists`; a path is whatever the machine it is running on reports.

The examples use `curl`, which is the command on Linux. On Windows PowerShell `curl` is an alias for `Invoke-WebRequest`, which takes different options; type `curl.exe` instead. The examples work as written with that one change.
