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
- **Link imports:** Import YouTube videos or playlists on Android and desktop.
  On desktop, Spotify and Deezer links are also supported. Spotify
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
  are updated manually. On Android, allow installs from Wave if prompted and
  confirm the update in the system installer. APK updates must be signed with
  the same key as the installed app.

### For developers

- **Local HTTP API:** Control playback and work with the library, playlists,
  settings and listening history from a local program. See [API
  documentation](docs/api.md).
- **Command line:** Import music, search the library, manage playlists and run
  other tasks without opening the window. Run `wave help` for the full list.
- **Phone simulator:** Preview the interface in a browser with a mock library
  using `npm run dev:phone`, without a phone or the Rust backend. Select
  `linuxPhone` and a small or landscape device size to test its popups. Android
  requests portrait orientation on phone-sized screens.
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

### Linux phones (Alpine and postmarketOS)

On aarch64 musl systems, the Linux installer selects the phone tarball and
installs WebKitGTK 4.1, the other runtime libraries, and GStreamer audio
plugins using `apk`. It may ask for `sudo` or `doas`. The executable and
launcher are installed under `~/.local/bin`; set `WAVE_PREFIX` or use
`--dir` with a saved copy of the installer to change the prefix. The installer
also creates a desktop entry. Its `--uninstall` option removes Wave but leaves
the shared system dependencies installed.

The tarball is not self-contained: a manual installation also needs
`webkit2gtk-4.1`, `libayatana-appindicator`, `librsvg`, `xdotool`, `openssl`,
`gst-plugins-base`, `gst-plugins-good`, and `gst-libav`. Extract both `wave`
and `wave-bin` into the same directory and run `wave`. The musl build does not
include yt-dlp, ffmpeg or Deno; install compatible copies separately for link
imports.

WebKitGTK normally uses the helper executables installed with its own library.
If they are elsewhere, set `WAVE_WEBKIT_HELPER_DIR` to the directory containing
`WebKitNetworkProcess` and `WebKitWebProcess` before launching Wave. The
helpers must match the installed WebKitGTK library version. The launcher uses
Bubblewrap and an unprivileged mount namespace to expose that directory at the
path expected by WebKit, without changing system files. The default expected
path is `/usr/libexec/webkit2gtk-4.1`; set `WAVE_WEBKIT_HELPER_TARGET` if the
installed WebKit library was built with a different path. Its parent directory
must exist. Bubblewrap and user namespaces must be available, and the override
may not work inside another container or sandbox.

For a graphical launcher, export these variables in the desktop session
environment as well as in a terminal. `WEBKIT_EXEC_PATH` is not a reliable
override for production WebKitGTK builds.

## Getting started

Open **Import** and choose a music folder. Wave copies the audio into its own
library; it does not play directly from the original folder. On Android, you
can also pick individual audio files, scan the phone's music folders, or
import a copied Wave `songs` folder with its artwork and lyrics.

To move a playlist, export a collection from **Settings → Library** on desktop
and import the resulting `.wavelist` from **Import**. Wave matches songs already
in the library and searches YouTube for missing audio. For Android, copying the
original songs first preserves the original files; see the migration guide
[below](#migrating-to-android).

Local playback works offline. Imports can look up missing metadata online, and
update checks and generated playlists also use the network.

### Migrating to Android

The most reliable way to move your music and playlists is to copy the audio
first, then import your playlist exports. Before starting, check that titles
and artists are tagged in the audio files: playlist matching uses metadata,
and names derived only from the original filenames may not survive the copy.

1. On desktop, open **Settings → Library → Export playlist**, select a
   playlist and click **Export**. Repeat for each playlist you want to transfer;
   you can also export **Liked Songs**. Each `.wavelist` contains an ordered
   list and metadata, not audio, and only includes songs in your library.
2. In the same settings section, click **Open in Explorer** and copy the entire
   `songs` folder, including its subfolders, artwork and lyrics. Keep the folder
   structure intact.
3. Install Wave on your phone. Transfer the `songs` folder and `.wavelist` files
   to accessible phone storage, for example using USB file transfer. Put the
   `songs` folder inside a folder such as `Music/Wave transfer`.
4. On Android, open **Import → Import folder**, select the copied `songs`
   folder and grant access when prompted. Wait for the import to finish.
5. Open **Import → Import Wave playlist** and select each `.wavelist` in turn.
   Wave creates playlists, matches imported songs, and searches YouTube for
   missing audio. Downloaded matches may differ from the original recordings.
   Entries that cannot be downloaded remain in the playlist; use **Download**
   there to retry, or import their audio later.
6. If you exported **Liked Songs**, it is imported as a regular playlist, not
   as likes. Once its songs are matched, open that imported playlist, long-press
   a song and choose **Select all**; long-press again and choose **Like** if
   offered to restore the likes.

Settings and listening history are not transferred. Wave copies the audio into
its own library, so allow enough space for both copies during import. After
checking the songs and playlists, you can remove the temporary copy from phone
storage.

The Android file browser's menu can switch between internal storage, SD cards
and other available providers. File selection shows all file types so audio
with an unrecognized type is still visible; only supported audio formats are
imported. The folder picker only lets you select folders. Android may restrict
access to some folders, especially other apps' private data and certain storage
roots on newer versions.

### Headphone EQ with AutoEq

1. Open the [AutoEq results](https://github.com/jaakkopasanen/AutoEq/tree/master/results)
   and find your exact headphone or headset model. Pick the matching variant,
   such as ANC on or off, if one is listed.
2. Open the model's folder and select the file ending in `ParametricEQ.txt`.
   Use GitHub's **Download raw file** button to save the text file.
3. In Wave, open **Settings → Playback → Equaliser**, choose **Open**, then
   select **Import a profile** under **Curves** and pick the downloaded file.
4. Wave saves and enables the profile. Select it under **Curves** to use it
   again later. If output selection is supported, you can also choose your
   headset under **Follows the output** and assign the profile to it.

Wave imports the filters and calculates its own automatic preamp rather than
using the preamp value in the file.

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
Android APK, run `npm run release -- android` (or add `debug` for a debug build).
The APK is written to `src-tauri/target/android/`.

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

- **A download fails on desktop:** Open the download log in the import dialog.
  Check that yt-dlp, ffmpeg and Deno are available, especially with a slim build.
- **A YouTube download needs sign-in:** On desktop, set
  `YTDLP_COOKIES_FROM_BROWSER` or `YTDLP_COOKIES` in the config `.env`, then
  try again. Android does not support authenticated YouTube downloads.
- **A song will not play on Linux:** Install the GStreamer plugins for its
  format. The packaged builds include or depend on the usual plugins.
- **Spotify or Deezer cannot open a playlist:** Spotify's editorial playlists
  are unavailable through its API; Deezer playlists must be public.
- **Android playback stops with the screen off:** This has been observed on an
  emulator even with the foreground service running. Try playback with the
  screen awake.

## License

Wave is released under the [MIT License](LICENSE).
