# Wave

Wave is a local-first music player for Windows, Linux and Android. Import your
music, organise it into playlists and listen with synced lyrics, an equaliser
and colours that follow the artwork.

[Download Wave](https://github.com/190Q/Wave/releases/latest) ·
[Getting started](#getting-started) ·
[User guides](docs/guides.md) ·
[Development](#development)

## Features

- **Music library:** Import files or folders and search your music. Wave
  automatically groups songs into artist, album and genre collections.
- **Playlists and likes:** Create and reorder playlists, save liked songs and
  transfer playlists between Wave installations.
- **Generated playlists:** Make a mix based on a genre or your listening
  history, using Deezer's catalogue. Taste-based mixes need enough listening
  history; missing songs can be downloaded from YouTube.
- **Playback:** Listen offline, use the queue, shuffle and repeat, and resume
  where you left off. Use system media controls and media keys, including
  notification and lock-screen controls on Android.
- **Lyrics and artwork:** View synced lyrics and look up missing lyrics, cover
  art and genres. Edit song details and replace covers when needed.
- **Audio and lyrics editor:** On desktop, edit lyrics and their timing, cut
  audio, or import replacements. Audio edits keep a backup in the library.
- **Sound:** Adjust the equaliser, save or import AutoEq and Equalizer APO
  profiles, and use volume normalisation to make tracks more consistent.
- **Link imports:** Download YouTube videos, playlists and mixes on desktop and
  Android. Desktop also supports Spotify and Deezer links by searching YouTube
  for matching audio.
- **Wave Swell:** See listening time and top songs, artists, albums and genres.
  Listening history is stored locally and can be disabled or cleared.
- **Appearance:** Choose an accent colour or follow the current artwork,
  adjust motion effects and use the desktop mini player.

Wave imports MP3, FLAC, M4A, M4B, AAC, OGG, Opus, WAV, AIFF and WMA files.
Playback support depends on the codecs available on your device.

## Install

Download the latest release from the [releases page](https://github.com/190Q/Wave/releases/latest):

- **Windows 10/11:** Download and run the `-setup.exe` installer. An MSI is
  also available.
- **Linux:** Choose a `.deb`, `.rpm` or `.AppImage` for x86_64 or aarch64.
  RPM packages require RPM 4.14 or newer with zstd support.
- **Android:** Download and install `Wave_x.y.z_arm64.apk` on an arm64 device.

macOS is not supported. Normal desktop builds include yt-dlp, FFmpeg and Deno
for link imports. The smaller `-slim` builds omit them; install the tools
separately and make them available on `PATH` if you need link imports.

Alternatively, use the desktop installer scripts:

**Windows PowerShell**

```powershell
irm https://raw.githubusercontent.com/190Q/Wave/main/install.ps1 | iex
```

**Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/190Q/Wave/main/install.sh | sh
```

### Linux phones

The releases page also offers an aarch64 phone Flatpak and an aarch64 musl
tarball for Alpine and postmarketOS. See the [Linux phone guide](docs/linux-phones.md)
for installation, updates and dependencies.

The Flatpak can run host commands to update itself, which effectively removes
the Flatpak sandbox's security boundary.

## Getting started

1. Open Wave and select **Import**.
2. Choose **Import files** or **Import folder** and select your music. On
   Android, you can also choose **Scan my phone's music**.
3. Open **Library** and choose **All songs**, an artist, album or genre. Select
   a song, then select it again to play it. Use the heart to add it to
   **Liked Songs**.
4. Choose **New playlist** in the library, or use a song's **Add to playlist**
   action to add it to an existing or new playlist.

Wave copies imported audio into its own library rather than playing the
original files directly, so allow enough storage for the copy. Duplicate audio
is skipped. Your library folder can be opened from **Settings → Library**.

Local playback works offline. Link imports, missing metadata lookups, generated
playlists and update checks need a connection.

### Generated playlists

In **Library**, choose **New playlist**, then **Generate by genre** or
**Generate from my taste**. Genre mixes use genres in your library; taste-based
mixes need enough listening history. Wave uses Deezer to find suggestions and
reuses songs already in your library. Other songs can be downloaded from the
generated playlist.

### Importing from a link

Open **Import** and paste a link. YouTube videos, playlists and mixes are
supported on desktop and Android; Spotify and Deezer links are supported on
desktop. YouTube mixes import up to 50 videos and may differ from personalised
mixes on YouTube.

Spotify and Deezer provide track information, not audio: Wave searches YouTube
for matching recordings, which may differ from the originals. Spotify requires
your own developer app; see [Spotify setup](docs/guides.md#spotify-setup).
Deezer playlists must be public.

### Playlists and listening history

To move a playlist, export it on desktop from **Settings → Library → Export
playlist**, then use **Import → Import Wave playlist** on the destination. A
`.wavelist` includes song details, timed lyrics and audio edited in Wave, but
not other audio. Import your music first to preserve the original recordings.

Listening history can be exported and imported separately through **Settings →
Wave Swell**. Importing it replaces the destination's listening record.
See the [transfer guide](docs/guides.md#moving-playlists-and-music), including
[migration to Android](docs/guides.md#migrating-to-android).

### Editing audio and lyrics

On desktop, right-click a song and choose **Edit audio & lyrics**. You can
edit lyric lines and timings, cut audio or import replacement audio and lyrics.
Wave keeps a backup of edited audio in `config/audio-backups` inside the
library. Waveforms and FLAC cuts require FFmpeg, included in normal desktop
builds.

### Sound, appearance and shortcuts

Open **Settings → Playback** for volume normalisation and the equaliser. You
can import a headphone profile using the [AutoEq guide](docs/guides.md#headphone-eq-with-autoeq).
On Android, the equaliser shows presets and rules rather than the band editor;
equaliser and output selection support depends on the device's webview.

On desktop, press `M` for the always-on-top mini player; hold `M` and press
`1`–`4` to place it in a corner. Press `Space` to play or pause, `O` to search
and `I` to open Import. Shortcuts are ignored while typing in a text field.

### Updates

Check for updates in **Settings → Updates**. Linux uses the package matching
your installation; system packages require graphical administrator
authorisation. On Android, allow installs from Wave if prompted and confirm
the update in the system installer. The new APK must be signed with the same
key as the installed app.

## Troubleshooting

- **A download fails on desktop:** Open the download log in the import dialog.
  Check that yt-dlp, FFmpeg and Deno are available, especially with a slim build.
- **YouTube asks for sign-in:** On desktop, set `YTDLP_COOKIES_FROM_BROWSER`
  or `YTDLP_COOKIES` in the config `.env` and try again. Open the config
  folder from **Import**. Android does not support authenticated YouTube
  downloads.
- **A song will not play on Linux:** Install the GStreamer plugins for its
  format. The packaged builds include or depend on the usual plugins.
- **A Linux window is blank or flickers:** Try launching Wave with
  `WEBKIT_DISABLE_DMABUF_RENDERER=1`. This can reduce performance. For the
  phone Flatpak, run `flatpak run --env=WEBKIT_DISABLE_DMABUF_RENDERER=1 com.wave.app`.
- **Spotify or Deezer cannot open a playlist:** Spotify's editorial playlists
  are unavailable through its API; Deezer playlists must be public.
- **Android playback stops with the screen off:** This has been observed on an
  emulator even with the foreground service running. Try playback with the
  screen awake.

## Development

Wave uses TypeScript and the DOM for its interface, with a Rust and Tauri 2
backend. You need Node.js 20.19+ or 22.12+, npm and Rust stable 1.87 or newer.
Windows also needs Microsoft C++ Build Tools and WebView2. Linux needs
WebKitGTK 4.1, GTK 3, OpenSSL and the other [Tauri prerequisites](https://tauri.app/start/prerequisites/).
Android builds also need the Android SDK and NDK.

```sh
git clone https://github.com/190Q/Wave.git
cd Wave
npm install
npm run tauri dev isolated
```

The `isolated` option keeps development data separate from an installed Wave
library. Without it, `npm run tauri dev` uses the installed library, where
edits and deletions affect your actual music.

```sh
npm run build       # Type-check and build the frontend
npm test            # Run the Node.js tests
npm run dev:phone   # Preview the phone interface in a browser
```

The desktop app also has a CLI (`wave help`) and an optional local HTTP API.
The API is disabled by default, unavailable on Android and has no
authentication when enabled. See the [development guide](docs/development.md)
for build commands, library modes and testing, and the
[API documentation](docs/api.md) for endpoints.

## Licence

Wave is released under the [MIT licence](LICENSE).
