# Wave

A local-first music player for the desktop. Point it at a folder of music and it
copies the songs into its own library, reads the tags, shows the artwork, and
plays it all back — with a queue, playlists, likes, synced lyrics, and a theme
that follows the album art.

It is a [Tauri](https://tauri.app) 2 app: a Rust backend for everything that
touches the disk or the network, and a small TypeScript front end (no framework,
just the DOM) for the interface.

Wave also imports from Spotify and Deezer: paste a playlist, album or track link
and it downloads the audio, tags the files, and drops them into your library.

## Platform support

Wave is built and supported on **Windows 10/11** and **Linux** (X11 and
Wayland). macOS is not supported.

- The interface is plain TypeScript and the DOM. One file is platform-aware:
  `src/lib/platform.ts` reports whether the webview is WebKitGTK, which is how an
  effect that WebKitGTK renders badly gets skipped.
- The Rust side has two small platform-specific pieces, both behind `cfg`:
  `#[cfg(windows)]` turns off WebView2's browser accelerator keys, and
  `#[cfg(target_os = "linux")]` turns off WebKitGTK's DMA-BUF renderer, which
  flickers on a lot of Linux setups. `webview2-com` and `windows` are
  Windows-only dependencies.
- The custom titlebar, the undecorated window, resizing by dragging near an edge,
  the mini player, and always-on-top are provided by Tauri on both platforms and
  need no per-OS code.
- Playback uses the webview's own `<audio>` element, so the codecs are the
  platform's: WebView2's on Windows, and WebKitGTK's GStreamer plugins on Linux.
  The loudness analysis is separate and pure Rust, so it needs no system codec
  library.

See [Requirements](#requirements) for the per-OS toolchain.

## Install

Every release is built for Windows and Linux by CI. Take what you need from the
[latest release](https://github.com/190Q/Wave/releases/latest), or use one of the
one-line installers below.

### Windows

The NSIS `-setup.exe` is the one to take; the `.msi` is there for managed
deployments. From PowerShell, this installs the latest release silently:

```powershell
irm https://raw.githubusercontent.com/190Q/Wave/main/install.ps1 | iex
```

Uninstall from Settings → Apps, or by running the uninstaller in the install
folder.

### Linux

Each release ships a `.deb`, an `.rpm`, and a portable `.AppImage`.

The installer script picks the right one for the machine — `apt`, then
`dnf`/`zypper`/`rpm`, and if none of those fit it drops the AppImage in
`~/.local/bin` with a menu entry, needing no root at all:

```sh
curl -fsSL https://raw.githubusercontent.com/190Q/Wave/main/install.sh | sh
```

Save the file to use the flags:

```sh
curl -fsSLO https://raw.githubusercontent.com/190Q/Wave/main/install.sh
sh install.sh --help        # --version, --dir, --uninstall
sh install.sh --uninstall
```

Installing a package by hand works too:

```sh
sudo apt install ./Wave_x.y.z_amd64.deb
sudo dnf install ./Wave-x.y.z-1.x86_64.rpm
chmod +x Wave_x.y.z_amd64.AppImage && ./Wave_x.y.z_amd64.AppImage
```

Linux builds come from an `ubuntu-22.04` runner, so they need glibc 2.35 or
newer (Ubuntu 22.04+, Debian 12+, Fedora 36+ and so on) and are x86_64 only.

## Features

- **Local library.** Import a folder and Wave copies the audio into its own
  library, reads the tags with [`lofty`](https://github.com/Serial-ATA/lofty-rs),
  and files each song in a directory of its own.
- **Formats.** `mp3`, `flac`, `m4a`, `m4b`, `aac`, `ogg`, `opus`, `wav`, `aiff`,
  `aif`, `wma`. Artwork: `jpg`, `jpeg`, `png`, `webp`, `gif`, `bmp`. Lyrics:
  `lrc`.
- **Playback.** Queue with shuffle and repeat (off/all), volume, mute, seek, and
  resume of the last session (queue, cursor, and position) on launch.
- **Level volume.** Every song is measured once (ITU-R BS.1770 loudness) and
  played at a gain that lands it on the same target, so a quiet track is not
  lost next to a loud one. `.wma` and `.opus` cannot be measured, and play at
  their own level. Turn it off in **Settings → Playback**.
- **Playlists and likes.** Build playlists, reorder them by dragging, and keep a
  Liked Songs collection. `Ctrl` and `Shift` click pick out several songs at
  once, right-click them to like, add, remove or delete them together, and drag
  the selection to move the whole block.
- **Search.** Seven matching algorithms you can switch between, from strict exact
  match to phonetic and fuzzy matching.
- **Lyrics.** Reads `.lrc` sidecars and scrolls them in time with the song. Can
  fetch missing lyrics from the network.
- **Adaptive theming.** The accent colour is derived from the current track's
  artwork, or you can pick your own colour with a full HSV picker.
- **Mini player.** Shrinks to a small always-on-top frame in any of the four
  screen corners.
- **Window memory.** Remembers its size, position, and monitor between launches,
  with nine `Ctrl+Shift+1..9` slots for saved window frames and actions.
- **Spotify and Deezer import.** Paste a link from either and Wave downloads a
  playlist, album or track via `yt-dlp` + `ffmpeg`, tags the files, and skips
  anything you already have. Spotify needs a developer app of your own; Deezer
  needs nothing but the two download tools.
- **Generated playlists.** Ask for a playlist and Wave fills it for you: 50 songs
  picked from Deezer's public catalogue to match what you have been listening
  to, or to match one genre. The picks stay undownloaded until you ask for them,
  and land in their places in the playlist when they do. It reads the same local
  listening record as Wave Swell, so it needs a record to work from, and it
  needs `yt-dlp` and `ffmpeg` to download anything.
- **Wave Swell.** A pinned entry in the library that opens a reading of your
  listening: minutes listened, split by music, audiobooks and podcasts; top
  songs, artists, genres and albums; and how your top five artists moved across
  the window. It covers **this month**, **this year** or **all time**, and opens
  on the shortest of those that has enough in it, so it is there as soon as
  there is something to say rather than once a year.

  It reads from a local record of what you play — how much of each song was
  actually heard, what you skipped, and what you liked — kept in a SQLite
  database beside the library folder. It is on by default, it never leaves your
  machine, and it can be switched off or cleared in **Settings → Wave Swell**.

## Requirements

Wave builds on **Windows 10/11** and **Linux**. Both need:

- **Node.js** 20.19+ or 22.12+ (Vite 8) and **npm**.
- **Rust** stable, 1.85 or newer — the MSVC toolchain on Windows, the GNU
  toolchain on Linux. The backend uses the Rust 2024 edition.

### Windows 10/11

- The **Microsoft C++ Build Tools**, with the "Desktop development with C++"
  workload.
- **WebView2**, which is already present on Windows 10 (1803 and later) and
  Windows 11, so there is normally nothing to install.
- **VBSCRIPT** is only needed to build the MSI installer, which
  `bundle.targets: "all"` does. It is enabled by default on most systems; if an
  MSI build fails at `light.exe`, turn it back on under Settings → Apps →
  Optional features → More Windows features.

### Linux

Tauri links WebKitGTK 4.1 and GTK 3, so their development packages have to be
present before the Rust build will succeed. Install them for your distribution,
then install Rust.

Debian / Ubuntu:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Fedora:

```bash
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel libxdo-devel
sudo dnf group install "c-development"
```

Arch:

```bash
sudo pacman -Syu
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file \
  openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
```

The OpenSSL package (`libssl-dev` / `openssl-devel` / `openssl`) is not optional:
the Spotify sign-in and the lyrics and cover fetches use `reqwest` with native
TLS, which links OpenSSL. For other distributions, see the
[Tauri prerequisites guide](https://tauri.app/start/prerequisites/).

The Spotify import additionally needs, but only if you use it:

- A **Spotify developer app** (free) for its Client ID and Secret.
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** on your `PATH`.
- **[ffmpeg](https://ffmpeg.org/)** on your `PATH`.

The Deezer import needs only the last two.

Nothing else is required. The library, the scanner, and the loudness analysis
work offline with no extra packages. Playback on Linux runs through WebKitGTK's
GStreamer stack, which desktop installs almost always already have — see
[Troubleshooting](#troubleshooting) if a particular format will not play.

## Getting started

Clone the repository and install the front-end dependencies:

```bash
git clone https://github.com/190Q/Wave.git
cd Wave
npm install
```

Run the full desktop app in development (hot-reloads the front end, recompiles
Rust on change):

```bash
npm run tauri dev
```

The first Rust build takes a few minutes; later ones are fast.

### Building a release

```bash
npm run tauri build
```

This produces installers and a standalone binary under
`src-tauri/target/release/bundle/`:

- **Windows** — an `.msi` and an NSIS `-setup.exe`.
- **Linux** — a `.deb`, an `.rpm`, and an `.AppImage`, when it is run on Linux.

Pushing a `v*` tag hands the same job to CI, which builds both platforms and
attaches everything to the release. That is how the Linux packages get built
from a Windows checkout. See `.github/workflows/release.yml`.

The release profile in `src-tauri/Cargo.toml` is tuned for size (`lto`,
`opt-level = 3`, `strip`, `panic = "abort"`).

### Front-end-only scripts

These are useful when you are working on the interface and do not need the Rust
side:

```bash
npm run dev       # Vite dev server on http://localhost:1420
npm run build     # type-check (tsc) then build the front end into dist/
npm run preview   # preview the built front end
```

Note that `npm run dev` alone runs in a plain browser, where the Tauri APIs are
unavailable — the library, playback, and settings will not work. Use
`npm run tauri dev` for anything real.

## Spotify import setup

Wave downloads from Spotify links using your own Spotify app, so it needs three
things set up once.

1. **Create a Spotify app.** Go to the
   [Spotify developer dashboard](https://developer.spotify.com/dashboard), create
   an app, and note its **Client ID** and **Client Secret**.
2. **Add the redirect URI.** In that app's settings, add this to **Redirect
   URIs**, exactly as written:

   ```text
   http://127.0.0.1:45678
   ```

   Spotify rejects the sign-in if it does not match character for character. (If
   you change `REDIRECT_PORT` in `src-tauri/src/spotify.rs`, change this to
   match.)

3. **Fill in the `.env`.** In the import dialog, open the **Spotify** section,
   press **Set up**, and click **Open the config folder**. A commented `.env`
   template is written there on first run. Paste your credentials:

   ```dotenv
   SPOTIFY_CLIENT_ID=your_client_id
   SPOTIFY_CLIENT_SECRET=your_client_secret
   # YTDLP_PATH=C:\path\to\yt-dlp.exe
   # FFMPEG_PATH=C:\path\to\ffmpeg.exe
   ```

4. **Install the download tools.** Put `yt-dlp` and `ffmpeg` on your `PATH`, or
   point `YTDLP_PATH` / `FFMPEG_PATH` at the executables — on Windows the
   overrides look like `C:\tools\yt-dlp.exe`, on Linux they are plain paths such
   as `/usr/bin/yt-dlp`. `yt-dlp` is also found as the Python module
   (`python -m yt_dlp`) if that is how you installed it.

The dialog shows a status line telling you exactly what is missing. When
everything is found it reads **Spotify is set up**. The first import opens a
browser window to sign in; the token is cached afterwards.

> Spotify only lets an app read **your own** playlists and collaborative
> playlists you belong to. Spotify's own editorial playlists will fail with a 404,
> and the dialog explains this when it happens.

## Deezer import

Deezer needs no setup of its own. Paste a playlist, album or track link into the
same field in the import dialog and Wave reads it from Deezer's public
catalogue, then downloads the audio exactly as it does for Spotify. `yt-dlp`
and `ffmpeg` are the only things it needs, as described above.

Deezer's own editorial playlists work here, which is the opposite of Spotify,
where the API refuses to hand them over. A playlist its owner marked **Private**
is the one thing that will not open. The dialog says so when it happens, and
switching the Private toggle off on Deezer makes that link work. Deezer's
playlists are public by default, so a playlist of your own is normally readable
as it stands.

## Troubleshooting

- **The window never appears.** Wave keeps the window hidden until the theme and
  the current song's artwork are applied, and reveals it after a short timeout
  regardless. If it still does not show, check the terminal for a Rust panic.
- **Playback works but nothing else does.** You are probably running `npm run
  dev` in a browser. Use `npm run tauri dev`.
- **Spotify says a playlist is missing (404).** It is almost certainly one of
  Spotify's own editorial playlists, which the API will not hand to apps. Use a
  playlist you own.
- **Deezer says the playlist is Private.** The API reads public playlists only.
  Open the playlist on Deezer, switch the **Private** toggle off, and paste the
  link again.
- **Spotify says yt-dlp or ffmpeg was not found.** Install them and make sure
  they are on `PATH`, or set `YTDLP_PATH` / `FFMPEG_PATH` in the config `.env`.
- **A song will not play.** Wave never guesses tags — a file with no artist tag
  is shown without one. Corrupt or unsupported files are reported in the status
  strip and skipped.
- **A format will not play on Linux.** WebKitGTK decodes through GStreamer, so
  the plugin for that format has to be installed.
  `gstreamer1.0-plugins-good` covers `mp3` and `flac`, and `gstreamer1.0-libav`
  covers the rest, including `wma` and `aac`.
- **The Linux build fails to link OpenSSL or WebKitGTK.** The development
  packages are missing. Install them as shown in [Requirements](#requirements);
  the usual culprits are `libwebkit2gtk-4.1-dev` and `libssl-dev`
  (Debian/Ubuntu), or `webkit2gtk4.1-devel` and `openssl-devel` (Fedora).
- **A window cannot be moved or resized on Linux/X11.** Some desktop
  environments force client-side decorations (`GTK_CSD=1`), which interferes
  with undecorated windows. Launch with `GTK_CSD=0` to work around it.
- **Animations flicker or tear on Linux.** Wave already turns off WebKitGTK's
  DMA-BUF renderer. If it persists, run `WEBKIT_DISABLE_COMPOSITING_MODE=1 wave`,
  or set **Reduce motion** in Settings → Appearance to skip the effects
  altogether.

## License

Wave is released under the [MIT License](LICENSE).

Copyright (c) 2026 190Q.
