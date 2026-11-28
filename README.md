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
- **Desktop song editor:** Right-click a song to edit its audio and lyrics
  together, import replacements, cut audio and drag lyric timings. Ctrl+scroll
  zooms the timeline, Shift+scroll pans, and Ctrl+Z / Ctrl+Shift+Z undo and
  redo edits. Audio edits keep a backup in `config/audio-backups` in the library.
  Waveforms and FLAC cuts require FFmpeg, included in normal desktop builds.
- **Link imports:** Import YouTube videos, playlists or mixes on Android and desktop.
  On desktop, Spotify and Deezer links are also supported. Spotify
  and Deezer provide the track information; Wave searches YouTube for matching
  audio. YouTube links are downloaded directly. Mixes are generated
  continuously, so Wave imports up to 50 videos from the mix. Personalised
  mixes may differ from YouTube.
- **Generated playlists:** Make a mix from your listening or a genre using
  Deezer's catalogue. Songs not already in your library can be downloaded on
  desktop. A mix based on your taste needs enough listening history first.
- **Wave Swell:** See listening time and your top songs, artists, albums and
  genres for the month, year or all time. Listening history is stored locally
  and can be disabled or cleared in **Settings → Wave Swell**.
- **Appearance:** Use an accent colour from the current artwork or pick your
  own, and adjust motion effects.
- **Desktop window and shortcuts:** Press M to toggle the always-on-top mini
  player. Drag its title to move it, or hold M and press 1–4 to place it in a
  corner. Remember window position and assign actions to nine shortcut slots.
- **System controls and Discord:** Control playback from the system media
  controls or media keys. Desktop Discord presence is available as an opt-in
  setting.
- **Phone layout:** Use touch-friendly controls on Android and Linux phones.
  Android also provides notification and lock-screen playback controls, and a
  headphone volume boost that can be switched off in playback settings.
- **Updates:** Check for new releases from settings and install them from Wave.
  Linux updates use the matching package for the running installation; system
  packages require graphical administrator authorisation. On Android, allow
  installs from Wave if prompted and confirm the update in the system
  installer. APK updates must be signed with the same key as the installed app.

### For developers

- **Local HTTP API:** Control playback and work with the library, playlists,
  settings and listening history from a local program. Enable it in
  **Settings → Developer** on desktop or Linux phones; it is off by default
  and unavailable on Android. See [API documentation](docs/api.md).
- **Command line:** Import music, search the library, manage playlists and run
  other tasks without opening the window. Run `wave help` for the full list.
- **Phone simulator:** Preview the interface in a browser with a mock library
  using `npm run dev:phone`, without a phone or the Rust backend. Select
  `linuxPhone` and a small or landscape device size to test its popups. Android
  requests portrait orientation on phone-sized screens.
- **Development builds:** The interface uses TypeScript and the DOM; the backend
  uses Rust and Tauri 2. Desktop and Android development commands are below.
- **UI overflow checks:** Install the test browser with `npx playwright install
  chromium`, then run `npm run test:ui` to check desktop and portrait phone
  views and popups for unwanted horizontal scrolling. To use an existing
  Chromium browser instead, set `WAVE_TEST_BROWSER` to its executable path.
- **Equaliser benchmark:** With Node.js 22 or newer, run `npm run benchmark:eq`
  to compare native playback with the disabled equaliser graph in a muted,
  headless Chromium browser. Set `WAVE_BENCHMARK_BROWSER` to the executable if
  the default is not installed. Results measure CPU on that browser and device,
  not battery use.

## Install

Download the latest version from the [releases
page](https://github.com/190Q/Wave/releases/latest).

- **Windows 10/11:** Install the `-setup.exe` file. An MSI is also available.
- **Linux:** Choose a `.deb`, `.rpm` or `.AppImage` for x86_64 or aarch64.
  Linux phones can also use the aarch64 phone Flatpak; Alpine and postmarketOS
  have an aarch64 musl tarball. RPM packages need RPM 4.14 or newer with zstd support.
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

### Linux phones

The `Wave_x.y.z_aarch64_phone.flatpak` release includes Wave and its download
tools. Install Flatpak for your distribution, download the bundle, and run:

```sh
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user ./Wave_x.y.z_aarch64_phone.flatpak
flatpak run com.wave.app
```

The bundle uses the GNOME 51 Flatpak runtime, which is downloaded from Flathub
if needed; the runtime is not included in the bundle. The first installation
therefore needs network access, unless the runtime is already installed. The
phone still needs a working graphical session, audio service and desktop
portals. The app can access files in your home directory for music imports.

Headset buttons and media keys reach Wave through the phone's media-control
service. Make sure **System media controls** is enabled in Wave. To check Wave's
MPRIS connection, play a song and run `playerctl --player=wave play-pause`;
install `playerctl` if it is not already available. If that works but Bluetooth
buttons do not, the phone may need its BlueZ `mpris-proxy` service running, or
its desktop may need media-key bindings. Check whether the same buttons work
with another player before changing system services.

The Flatpak keeps its own library and settings under `~/.var/app/com.wave.app/`,
separate from other Wave installations. New bundles can install updates from
Wave, in the same user or system installation. System-wide updates require
graphical administrator authorisation. An older bundle without this updater must
be updated manually once: close Wave, uninstall the old application and install
the new bundle with the command above. For a user installation, run:

```sh
flatpak uninstall --user com.wave.app
```

For a system installation, use `--system` instead of `--user` in both the
uninstall and install commands. This leaves the app data in place; do not use
`--delete-data` when updating.
Back up important data before replacing an installation. To update its bundle,
Wave can run commands on the host through Flatpak's `org.freedesktop.Flatpak`
interface. This effectively removes the Flatpak sandbox's security boundary.

#### Alpine and postmarketOS musl tarball

On aarch64 musl systems, the Linux installer selects the phone tarball and asks
whether to install missing WebKitGTK, graphics and audio libraries, yt-dlp,
FFmpeg, Deno and its YouTube solver using `apk`. Decline to install them
manually; the installer lists the Alpine package names and continues installing
Wave, which may not run until its dependencies are available. Without a
terminal, dependencies are not installed automatically. Use `--install-deps`
to install them without prompting or `--skip-deps` to leave them for manual
installation. With the one-line installer, pass either option after `sh -s --`,
for example `curl -fsSL https://raw.githubusercontent.com/190Q/Wave/main/install.sh | sh -s -- --skip-deps`.
Community repositories must be enabled; `sudo` or `doas` may be required for
installing packages. Run the installer as your normal user, without `sudo` or
`doas` on the installer itself; it uses them when needed for `apk`. To install
a downloaded tarball, extract it and run
`sh install.sh --local` from the extracted directory. Extracting the archive
alone does not install Wave. The archive depends on system packages rather
than containing all libraries. The phone launcher uses the desktop's file
chooser portal; on Phosh this provides an adaptive picker. Alpine controls the
available yt-dlp version, which may need updating as YouTube changes.

By default, the installer places the launcher at `~/.local/bin/wave`, with its
supporting files in the same directory, and creates
`~/.local/share/applications/wave-bin.desktop` and icons under
`~/.local/share/icons/hicolor/`, or in `XDG_DATA_HOME` if set. If
`~/.local/bin` is not on `PATH`, run the launcher by its full path or add the
directory to `PATH`.
Running the installer as root instead uses root's `HOME`, usually `/root`.
Set `WAVE_PREFIX` or use `--dir` to change the installation prefix;
`--uninstall` removes Wave but leaves shared packages installed. WebKit
normally uses its installed helpers. If they are elsewhere, set
`WAVE_WEBKIT_HELPER_DIR` to the directory containing `WebKitWebProcess` and
`WebKitNetworkProcess`. Set `WAVE_WEBKIT_BUNDLE_DIR` to the directory
containing `libwebkit2gtkinjectedbundle.so`. Both must match the installed
WebKit library version, and their resolved paths cannot contain `:`. The launcher
redirects its compiled-in paths using a private
temporary library copy, without modifying `/usr/libexec`. If discovery fails,
`WAVE_WEBKIT_LIBRARY` selects the library file, while
`WAVE_WEBKIT_HELPER_TARGET` and `WAVE_WEBKIT_BUNDLE_TARGET` identify its
compiled-in paths. Set these variables in the desktop session environment for
graphical launches; `WEBKIT_EXEC_PATH` is unreliable in production builds.

To test the downloaded ARM phone app from this checkout, start Docker Desktop
or Docker Engine and run `npm run phone:lab`. Open
<http://127.0.0.1:6080/vnc.html> after installation. To hear playback, open
<http://127.0.0.1:6082/stream.mp3> in another tab and press play; the stream
has some delay and supports one listener. To select a release, run
`node scripts/phone-lab.mjs --version 0.3.2` or
`node scripts/phone-lab.mjs --archive /path/to/Wave_0.3.2_aarch64_musl.tar.gz`.
Optionally add `--music /path/to/music` to expose a read-only folder at
`/music`. Press Ctrl+C to stop the lab and remove its container and library;
`docker stop wave-phone-lab` also stops it. The lab uses ARM
emulation, X11 and software rendering, and disables WebKit's sandbox inside
the container; it does not replace testing on a real phone or postmarketOS
Wayland VM. Release tests also install the ARM archive, exercise its graphical
UI and compare it with the uploaded download. A blank screen can be diagnosed
by launching `wave` in a terminal and checking the frontend and WebKit logs.

## Getting started

Open **Import** and choose individual audio files or a music folder. Wave copies
the audio into its own library; it does not play directly from the original
files. On Android, you can also scan the phone's music folders or import a
copied Wave `songs` folder with its artwork and lyrics.

To move a playlist, export a collection from **Settings → Library** on desktop
and import the resulting `.wavelist` from **Import**. Choose whether to create
a playlist or import only its songs. Wave matches songs already in the library
and searches YouTube for missing audio. Exports include available timed lyrics
and copies of audio edited in Wave; edited audio can make the file much larger.
Other audio is not included. Edited audio is limited to 4 GiB per song and
64 GiB per export. Existing lyrics and different recordings on the destination
are left untouched. Older exports can still be imported, but they cannot
restore audio edits, and older Wave versions cannot read the newer formats.
For Android, copying the original songs first preserves the original files;
see the migration guide [below](#migrating-to-android).

To move listening history, import the songs first, then use **Settings → Wave
Swell → Export** on the source device and **Import** on the destination. A
`.waveanalytics` backup replaces the destination's current listening record
after confirmation. It includes listening activity, not audio, playlists,
likes, or settings. Songs are matched by ID or unambiguous metadata.

Local playback works offline. Imports can look up missing metadata online, and
update checks and generated playlists also use the network.

On Android 10 and later, uninstalling Wave through system settings may offer a
checkbox to keep its app data, including the library, playlists, settings and
listening history. Select it to keep the data for a later reinstall of Wave
with the same package and signing key. The version being uninstalled must already
include this option, so update Wave before uninstalling. This is not a backup:
the data remains on the device and is deleted if the option is not selected.

### Migrating to Android

The most reliable way to move your music and playlists is to copy the audio
first, then import your playlist exports. Before starting, check that titles
and artists are tagged in the audio files: playlist matching uses metadata,
and names derived only from the original filenames may not survive the copy.

1. On desktop, open **Settings → Library → Export playlist**, select a
   playlist and click **Export**. Repeat for each playlist you want to transfer;
   you can also export **Liked Songs**. Each `.wavelist` contains an ordered
   list, metadata, available timed lyrics and any audio edited in Wave. Other
   audio is not included.
2. In the same settings section, click **Open in Explorer** and copy the entire
   `songs` folder, including its subfolders, artwork and lyrics. Keep the folder
   structure intact.
3. Install Wave on your phone. Transfer the `songs` folder and `.wavelist` files
   to accessible phone storage, for example using USB file transfer. Put the
   `songs` folder inside a folder such as `Music/Wave transfer`.
4. On Android, open **Import → Import folder**, select the copied `songs`
   folder and grant access when prompted. Wait for the import to finish.
5. Open **Import → Import Wave playlist**, select each `.wavelist` in turn,
   and choose **As a playlist**. Wave restores included edited audio, matches
   other imported songs and searches YouTube for missing audio. Downloaded
   matches may differ from the original recordings.
   Entries that cannot be downloaded remain in the playlist; use **Download**
   there to retry, or import their audio later.
6. If you exported **Liked Songs**, it is imported as a regular playlist, not
   as likes. Once its songs are matched, open that imported playlist, long-press
   a song and choose **Select all**; long-press again and choose **Like** if
   offered to restore the likes.

Settings are not transferred. Listening history can be transferred separately
using **Settings → Wave Swell → Export** and **Import**. Wave copies the audio
into its own library, so allow enough space for both copies during import. After
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
   again later.

Wave imports the filters and calculates its own automatic preamp rather than
using the preamp value in the file.

### Spotify setup

Spotify link imports need your own developer app.

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

Desktop development builds can run alongside an installed release. By default,
`npm run tauri dev` uses the installed library. Select the library explicitly
with either command:

```sh
npm run tauri dev shared
npm run tauri dev isolated
```

Shared mode uses the installed app's actual songs, artwork and playlist catalog:
edits and deletions affect the installed library. Its source credentials and
tool configuration in `library/config/.env` are shared too. Restart the other
app to see changes made by one instance. If Wave is not installed, use isolated
mode to create a separate test library.

Starting shared Dev scans the library and may update the catalog. Avoid editing
or importing while either app is scanning, editing or importing: their file
operations are not coordinated across processes. If the installed catalog needs
a migration or does not match the development build, shared mode refuses to
open it.

Shared Dev loads a fresh copy of the installed settings, likes, queue and window
state each time it starts; changes to those in Dev stay separate and are reset
from the installed app on the next launch. Wave Swell uses the installed
listening history, so plays, imports and clearing history affect both apps.
The import log is shared too.

Both modes keep their own WebView data and cannot install release updates.
Isolated mode never uses the installed library or other installed data. When
the local API is enabled in shared Dev, it uses an available loopback port and
prints that port in the terminal, leaving the installed app's port free.

Android debug builds install as **Wave Dev** (`com.wave.app.dev`), alongside the
release app (`com.wave.app`). They have separate private data, and Wave Dev
cannot install release updates. Do not use `tauri android dev --release` to
test alongside the release app: that option uses the release package ID.

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

The API is off by default and is unavailable on Android. Enable it under
**Settings → Developer** to listen on `127.0.0.1:45679`. It has no
authentication, so local processes can access it. Set `WAVE_API_PORT` in the
config `.env` to change the port. See [docs/api.md](docs/api.md) for endpoints
and examples.

## Troubleshooting

- **A download fails on desktop:** Open the download log in the import dialog.
  Check that yt-dlp, ffmpeg and Deno are available, especially with a slim build.
- **A YouTube download needs sign-in:** On desktop, set
  `YTDLP_COOKIES_FROM_BROWSER` or `YTDLP_COOKIES` in the config `.env`, then
  try again. Android does not support authenticated YouTube downloads.
- **A song will not play on Linux:** Install the GStreamer plugins for its
  format. The packaged builds include or depend on the usual plugins.
- **A Linux window is blank or flickers:** Some graphics drivers have trouble
  with WebKitGTK's accelerated renderer. As a fallback, launch Wave with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`; this can reduce performance. For the
  phone Flatpak, use `flatpak run --env=WEBKIT_DISABLE_DMABUF_RENDERER=1 com.wave.app`.
- **Spotify or Deezer cannot open a playlist:** Spotify's editorial playlists
  are unavailable through its API; Deezer playlists must be public.
- **Android playback stops with the screen off:** This has been observed on an
  emulator even with the foreground service running. Try playback with the
  screen awake.

## License

Wave is released under the [MIT License](LICENSE).
