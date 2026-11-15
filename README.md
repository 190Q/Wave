# Wave

Wave is a local-first music player for Windows, Linux and Android. Import your
music into a library, organise it into playlists, and listen with synced lyrics,
an equaliser and a theme that follows the artwork.

## Features

- **Local library:** Import a music folder into Wave's own library, including
  tags, artwork and lyric files. Duplicate audio is skipped.
- **Audio formats:** Import MP3, FLAC, M4A, M4B, AAC, OGG, Opus, WAV, AIFF and
  WMA. Playback support depends on the codecs available on your device.
- **Browse and search:** Find songs and browse playlists, artists, albums and
  genres. Choose from seven search methods, including fuzzy and phonetic search.
- **Playlists and likes:** Create and reorder playlists, save liked songs, and
  select multiple tracks to like, move, remove or delete together.
- **Playlist transfer:** Export a collection as a `.wavelist` and import it
  into another Wave library. The file contains song metadata, not audio.
- **Playback:** Use the queue, shuffle, repeat, seek and volume controls. Wave
  can restore the queue and position from your last session.
- **Volume normalisation:** Measure tracks and adjust their playback level so
  quieter and louder songs are closer together. Unmeasurable tracks play at
  their original level.
- **Equaliser:** Adjust bands, save curves, import AutoEq or Equalizer APO
  profiles, and apply presets based on the output, playlist, album, artist or
  genre. Android shows the presets and rules rather than the band editor;
  equaliser and output selection support depends on the webview.
- **Lyrics and metadata:** Read synced `.lrc` lyrics and look up missing lyrics,
  cover art and genres for a collection.
- **Link imports:** On desktop, import Spotify, Deezer or YouTube links. Spotify
  and Deezer provide the track information; Wave searches YouTube for matching
  audio. YouTube links are downloaded directly.
- **Generated playlists:** Make a mix from your listening or a genre using
  Deezer's catalogue. Songs not already in your library can be downloaded on
  desktop. A mix based on your taste needs enough listening history first.
- **Wave Swell:** See listening time and your top songs, artists, albums and
  genres for the month, year or all time. Listening history is stored locally
  and can be disabled or cleared in **Settings → Wave Swell**.
- **Appearance:** Use an accent colour from the current artwork or pick your
  own, and adjust motion effects.
- **Desktop window and shortcuts:** Use the always-on-top mini player, remember
  window position, and assign actions to nine keyboard shortcut slots.
- **System controls and Discord:** Control playback from the system media
  controls or media keys. Desktop Discord presence is available as an opt-in
  setting.
- **Phone layout:** Use touch-friendly controls on Android and Linux phones.
  Android also provides notification and lock-screen playback controls.
- **Updates:** Check for new releases from settings. Windows, AppImage and
  Android installations can launch the update from Wave; other Linux packages
  are updated manually.

### For developers

- **Local HTTP API:** Control playback and work with the library, playlists,
  settings and listening history from a local program. See [API
  documentation](docs/api.md).
- **Command line:** Import music, search the library, manage playlists and run
  other tasks without opening the window. Run `wave help` for the full list.
- **Phone simulator:** Preview the interface in a browser with a mock library
  using `npm run dev:phone`, without a phone or the Rust backend.
- **Development builds:** The interface uses TypeScript and the DOM; the backend
  uses Rust and Tauri 2. Desktop and Android development commands are below.

## Install

Download the latest version from the [releases
page](https://github.com/190Q/Wave/releases/latest).

- **Windows 10/11:** Install the `-setup.exe` file. An MSI is also available.
- **Linux:** Choose a `.deb`, `.rpm` or `.AppImage` for x86_64 or aarch64.
  Linux phones can use the aarch64 packages; Alpine and postmarketOS have an
  aarch64 musl tarball.
- **Android:** Install `Wave_x.y.z_arm64.apk` on an arm64 device.

macOS is not supported. The normal desktop builds include yt-dlp, ffmpeg and
Deno for downloads. The smaller `-slim` builds omit them, so install those
tools separately and make them available on `PATH` if you want link imports.

The desktop installers can also be run from a terminal:

```powershell
irm https://raw.githubusercontent.com/190Q/Wave/main/install.ps1 | iex
```

```sh
curl -fsSL https://raw.githubusercontent.com/190Q/Wave/main/install.sh | sh
```

## Getting started

Open **Import** and choose a music folder. Wave copies the audio into its own
library; it does not play directly from the original folder. On Android, you
can also pick individual audio files, scan the phone's music folders, or
import a copied Wave `songs` folder with its artwork and lyrics.

To move a playlist, export a collection from **Settings → Library** on desktop
and import the resulting `.wavelist` from **Import**. Desktop can download songs
that are missing from the destination library. On Android, import the audio
separately: the playlist matches songs already in the library and keeps missing
entries until their audio is imported.

Link imports are not available on Android. To transfer music to a phone, copy
and import the audio files separately.

Local playback works offline. Imports can look up missing metadata online, and
update checks and generated playlists also use the network.

### Spotify setup

Spotify link imports need your own developer app. Deezer and YouTube do not
need an account setup.

1. Create an app in the [Spotify developer
   dashboard](https://developer.spotify.com/dashboard).
2. Add `http://127.0.0.1:45678` as a redirect URI in the app's settings.
3. In Wave, open **Import → Spotify → Set up → Open the config folder** and
   enter the app's Client ID and Client Secret in the `.env` file:

   ```dotenv
   SPOTIFY_CLIENT_ID=your_client_id
   SPOTIFY_CLIENT_SECRET=your_client_secret
   ```

4. Import a Spotify link and sign in when prompted. Spotify's API allows your
   own and collaborative playlists but does not provide its editorial playlists.

The import dialog reports missing download tools and can open the download
log. To use your own copies instead of bundled tools, set `YTDLP_PATH`,
`FFMPEG_PATH` or `DENO_PATH` in the same `.env` file.

## Development

Wave requires Node.js 20.19+ or 22.12+, npm, and Rust stable 1.87 or newer.
Windows also needs the Microsoft C++ Build Tools and WebView2. Linux needs
WebKitGTK 4.1, GTK 3, OpenSSL and other Tauri dependencies; see the [Tauri
prerequisites](https://tauri.app/start/prerequisites/) for your distribution.
Android builds also require the Android SDK and NDK.

```sh
git clone https://github.com/190Q/Wave.git
cd Wave
npm install
npm run tauri dev
```

Other useful commands:

```sh
npm run build              # Type-check and build the frontend
npm run tauri build        # Build the desktop app and installers
npm run dev:phone          # Browser phone simulator with mock data
npm run phone              # Tauri window with the Linux phone layout
npx tauri android dev      # Run on an Android device or emulator
```

`npm run tauri build` fetches the bundled download tools as needed. Run
`node scripts/release.mjs slim` for a desktop build without them. For an
Android debug APK, use `npx tauri android build --apk --debug -t aarch64`.

### CLI and API

The desktop executable accepts commands such as:

```sh
wave help
wave list --json
wave search "artist name"
wave import "path/to/music"
wave help import
```

The executable must be on `PATH`, or invoked by its full path. Windows
installers do not add it to `PATH`. Commands use the same library and config as
the app and require a desktop session on Linux.

While Wave is running, the API listens on `127.0.0.1:45679` by default. It has
no authentication, so local processes can access it. Set `WAVE_API=0` or
`WAVE_API_PORT` in the config `.env` and restart Wave to disable it or change
the port. See [docs/api.md](docs/api.md) for endpoints and examples.

## Troubleshooting

- **A download fails:** Open the download log in the import dialog. Check that
  yt-dlp, ffmpeg and Deno are available, especially with a slim build.
- **A YouTube download needs sign-in:** Set `YTDLP_COOKIES_FROM_BROWSER` or
  `YTDLP_COOKIES` in the config `.env`, then try again.
- **A song will not play on Linux:** Install the GStreamer plugins for its
  format. The packaged builds include or depend on the usual plugins.
- **Spotify or Deezer cannot open a playlist:** Spotify's editorial playlists
  are unavailable through its API; Deezer playlists must be public.
- **Android playback stops with the screen off:** This has been observed on an
  emulator even with the foreground service running. Try playback with the
  screen awake.

## License

Wave is released under the [MIT License](LICENSE).
