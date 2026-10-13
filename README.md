# Wave

A local-first music player for the desktop. Point it at a folder of music and it
copies the songs into its own library, reads the tags, shows the artwork, and
plays it all back — with a queue, playlists, likes, synced lyrics, and a theme
that follows the album art.

It is a [Tauri](https://tauri.app) 2 app: a Rust backend for everything that
touches the disk or the network, and a small TypeScript front end (no framework,
just the DOM) for the interface.

Wave also imports from Spotify: paste a playlist or track link and it downloads
the audio, tags the files, and drops them into your library.

## Platform support

Wave is built and supported on **Windows 10/11** and **Linux** (X11 and
Wayland). macOS is not supported.

- The front end is plain TypeScript and the DOM, with nothing Windows- or
  Linux-specific in it.
- The Rust side keeps its only platform-specific code behind `#[cfg(windows)]`:
  turning off WebView2's browser accelerator keys. `webview2-com` and `windows`
  are Windows-only dependencies.
- Everything else the app links is cross-platform — Tauri, `lofty`, `image`,
  `symphonia`, `ebur128`, `notify` — and the loudness analysis is pure Rust, so
  no system codec library is needed.
- The custom titlebar, the undecorated window, resizing by dragging near an edge,
  the mini player, and always-on-top are provided by Tauri on both platforms and
  need no per-OS code.

See [Requirements](#requirements) for the per-OS toolchain and
[Platform notes](#platform-notes) for the small behavioural differences.

## Contents

- [Platform support](#platform-support)
- [Features](#features)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Using the app](#using-the-app)
- [Importing music](#importing-music)
- [Spotify import setup](#spotify-import-setup)
- [Fetching lyrics and covers](#fetching-lyrics-and-covers)
- [How the library works](#how-the-library-works)
- [Where your data lives](#where-your-data-lives)
- [Customizing Wave](#customizing-wave)
- [Project layout](#project-layout)
- [Development](#development)
- [Platform notes](#platform-notes)
- [Troubleshooting](#troubleshooting)

## Features

- **Local library.** Import a folder and Wave copies the audio into its own
  library, reads the tags with [`lofty`](https://github.com/Serial-ATA/lofty-rs),
  and extracts embedded artwork.
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
  Liked Songs collection.
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
- **Spotify import.** Downloads a playlist or track via `yt-dlp` + `ffmpeg`,
  tags the files, and skips anything you already have.

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

Nothing else is required — the local player, the library, and the loudness
analysis work offline, with no system codec packages to install.

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
- **Linux** — a `.deb`, an `.rpm`, and an `.AppImage`.

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

## Using the app

Everything is reachable from the custom titlebar and the top bar: **Library**,
**Import**, **Theme**, and **Settings**, plus a search button.

### Keyboard shortcuts

Global shortcuts are ignored while you are typing in a text field.

- `Space` — play or pause
- `ArrowRight` / `ArrowLeft` — next / previous track
- `ArrowUp` / `ArrowDown` — volume up / down
- `o` — open search
- `s` — toggle shuffle
- `r` — toggle repeat
- `q` — toggle the queue
- `i` — open the import dialog
- `p` — open settings
- `t` — toggle always on top
- `m` — toggle the mini player (bottom-right by default)
- `m` then `1`–`4` — put the mini player in a corner (1 top-left, 2 top-right,
  3 bottom-left, 4 bottom-right)
- `Ctrl+Shift+1..9` — run the action assigned to that slot

Contextual and pointer shortcuts:

- `Escape` — close a dialog or menu, clear search, cancel a playlist edit
- `Enter` — commit a playlist create or rename
- `Shift` + click close — close and forget the saved window geometry
- Wheel over the queue — previous / next track
- Drag the dock — scrub the current track
- Drag the queue — browse it
- Drag a track row — reorder a playlist

### Action slots

Each of the nine `Ctrl+Shift+<digit>` slots can run one action: snap the window
back to a saved size/position, toggle maximise or always-on-top, toggle the
mini player, play/pause, next/previous, shuffle, repeat, mute, open the queue or
search, or cycle the accent colour. Assign them in **Settings → Shortcuts**. A
snap slot records the window as it stands when you pick it.

### Settings

- **Playback** — resume the queue, cursor, and position on launch, and level
  every song's volume.
- **Appearance** — reduce motion, overriding the system setting.
- **Window** — remember the window size and position; reset the saved frame.
- **Library** — the library folder path, a button to open the folder in your
  file manager, and a rescan button, which also measures the loudness of any song
  that has none yet.
- **Search** — which matching algorithm every search field uses.
- **Shortcuts** — the action slots and a reference of every keybind.

Changes are staged and written when you press **Save**.

## Importing music

Open the import dialog with the **Import** button or `i`.

- **Local folder** — pick a folder and choose **Import songs only**, or **Import
  as a playlist** to also create a playlist from what came in. Wave copies the
  audio into its library and picks up covers and lyrics that sit alongside it.
- **Spotify** — paste a track or playlist link (see below).
- **Fetch lyrics** / **Fetch covers** — run either job over a chosen collection.
- **Recent imports** — the last few imports, newest first.

If a Spotify link overlaps with songs you already have, Wave asks before
downloading the duplicates again.

### How a local folder is matched

When you import a folder, Wave looks for two subfolders inside it, matched
case-insensitively:

- `images/` — artwork files.
- `lyrics/` — `.lrc` files.

Each sidecar is paired with a song by its file name, either the whole stem or the
part after `artist - `. So `images/15 Step.jpg` and
`images/A Tout Le Monde - Remastered 2004.jpg` both line up with the matching
song. A `.lrc` sitting directly beside the audio file is also picked up.

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

## Fetching lyrics and covers

Both jobs run over a whole collection and report progress as they go.

- **Fetch lyrics** tries [LRCLIB](https://lrclib.net) first, then
  [lyrics.ovh](https://lyrics.ovh), then NetEase. Timed lyrics are saved as an
  `.lrc` sidecar next to the song and scroll with playback; plain lyrics are
  embedded into the file's tags. Songs that already have lyrics are skipped.
- **Fetch covers** finds art for songs that have none. It first uses art already
  embedded in the file, then falls back to online sources — Spotify when you are
  signed in, then the free iTunes and Deezer catalogues. Covers are written into
  the library's `images/` folder and embedded into the file.

## How the library works

Wave keeps a copy of your music rather than pointing at the original folder, so
your source files are never modified (except that fetched lyrics and covers may
be written into the library's copies).

Inside its app data directory it maintains:

```text
library/
├── songs/        # the audio files, copied in on import
├── images/       # cover art, one file per song
├── lyrics/       # .lrc sidecars, one file per song
├── playlists/    # playlist files
└── config/
    ├── index.json        # maps each song to its image and lyrics sidecars
    ├── loudness.json     # how loud each song is, for volume levelling
    ├── .env              # Spotify credentials (see above)
    └── spotify-token.json# the cached sign-in token
```

`index.json` is the map that says which image and which `.lrc` belong to which
song. Deleting a song from the app removes it from the library and forgets it in
the index.

`loudness.json` holds one loudness reading per song. It is filled in behind the
scenes as songs arrive, and by the rescan button; deleting a song forgets its
reading too.

## Where your data lives

Tauri resolves the app's directories from the bundle identifier `com.wave.app`.
Windows keeps the library and the state together; Linux splits them along the
XDG base directories.

Windows — everything under `%APPDATA%\com.wave.app`
(`C:\Users\<you>\AppData\Roaming\com.wave.app`):

- `library/` — your music and everything above.
- `state.json` — settings, playlists, likes, the last session, window geometry,
  cached artwork colours, and import history.

Linux — the library under the data directory and the state under the config
directory (`$XDG_DATA_HOME` and `$XDG_CONFIG_HOME` are honoured when set):

- `~/.local/share/com.wave.app/library/` — your music and everything above.
- `~/.config/com.wave.app/state.json` — the same state as above.

Both are written atomically (a temp file is renamed over the target), so a crash
mid-write cannot corrupt them. You can safely back up or delete `state.json` to
reset the app; deleting `library/` clears your imported music.

Artwork thumbnails are cached separately, in the app cache directory
(`%LOCALAPPDATA%\com.wave.app\cache\artwork` on Windows,
`~/.cache/com.wave.app/artwork` on Linux). The cache is disposable — Wave
rebuilds it from your files — and can be deleted at any time.

## Customizing Wave

A tour of the places you will most likely want to change.

### Themes and colours

- `src/lib/colour.ts` — colour maths (HSV, mixing, contrast, gradients).
- `src/ui/theme.ts` — the theme dialog, the HSV picker, and how an accent is
  applied.
- `src/styles/tokens.css` — the base design tokens (spacing, radii, the default
  palette). Accent variables (`--accent`, `--accent-dark`, `--accent-ink`,
  `--stage-background`, …) are set at runtime here.
- `src/ui/wipe.ts` — the sweep animation when a theme is applied.

The default theme is **adaptive**: the accent is derived from the current track's
artwork. Set a fixed colour by picking one in the theme dialog, or change the
default in `Settings` (`src-tauri/src/state.rs`, the `theme` field).

### Styles

One stylesheet per area lives in `src/styles/` (`dock.css`, `library.css`,
`queue.css`, `settings.css`, `import.css`, `hero.css`, `menu.css`, and so on).
`index.html` links the two entry sheets (`tokens.css`, `app.css`); the rest are
imported from there or from `main.ts`.

### Icons

SVG icons live in `src/assets/icons/` and are registered in
`src/assets/icons/index.ts`. Add a file, register it under a name, and use it in
markup with `data-icon="name"`.

### Fonts

The bundled **Alte Haas Grotesk** faces are in `public/fonts/`. Swap the files
and update the `@font-face` rules to change the typeface.

### Search

`src/lib/search.ts` holds every matcher and the `SEARCH_ALGORITHMS` list that
fills the settings panel. Each algorithm is a scoring function; add one and it
appears in Settings automatically.

### Keybinds and action slots

- `src/lib/keybinds.ts` — the keybind reference shown in Settings and the list of
  slot actions.
- `src/main.ts` — the global `keydown` handler where the plain keys are wired.
- `src/ui/actions.ts` — what a slot action does when it runs.

### Backend behaviour

- `src-tauri/src/lib.rs` — the command list. Every `#[tauri::command]` the front
  end can call is registered here; add new ones to `invoke_handler`.
- `src-tauri/src/library.rs` — the library layout, extensions, and sidecar
  matching. Change `AUDIO_EXTENSIONS` / `IMAGE_EXTENSIONS` / `LYRICS_EXTENSIONS`
  to support more file types.
- `src-tauri/src/state.rs` — the persisted `Settings` and `Session` shapes.
- `src-tauri/src/spotify.rs`, `spotify_import.rs`, `download.rs` — the Spotify
  flow, from sign-in to downloading and tagging.
- `src-tauri/src/lyrics_fetch.rs`, `cover_fetch.rs` — the two fetch jobs.
- `src-tauri/src/loudness.rs` — measuring a song's loudness, and the pass the
  rescan button runs.

### App identity and window

`src-tauri/tauri.conf.json` sets the product name, version, bundle identifier,
window defaults (size, minimum size, custom decorations), and the WebView2
browser arguments. The bundle identifier also decides where your data lives, so
change it before shipping a fork.

### Window behaviour

`src-tauri/src/state.rs` handles window geometry, the mini player, and the saved
frames for the snap slots.

## Project layout

```text
.
├── index.html              # the single page: titlebar, sheet, hero, dock, dialogs
├── public/fonts/           # bundled fonts
├── src/                    # front end (TypeScript, no framework)
│   ├── main.ts             # entry point, mounts every UI module and the keybinds
│   ├── types.ts            # shared types mirroring the Rust structs
│   ├── assets/icons/       # SVG icons and their registry
│   ├── lib/                # state, player, audio, search, colour, IPC, …
│   ├── styles/             # one stylesheet per area, plus tokens
│   └── ui/                 # one module per component (dock, library, queue, …)
└── src-tauri/              # Rust backend
    ├── Cargo.toml
    ├── tauri.conf.json     # app config, window, bundle
    ├── capabilities/       # the permissions the window is granted
    └── src/
        ├── lib.rs          # builder, plugins, command registration
        ├── state.rs        # persisted settings, session, window geometry
        ├── library.rs      # scanning, sidecars, the library layout
        ├── import.rs       # importing a folder
        ├── playlists.rs    # playlist files
        ├── artwork.rs      # artwork bytes and dominant colour
        ├── lyrics.rs       # reading `.lrc` sidecars
        ├── spotify.rs      # Spotify auth and API
        ├── spotify_import.rs
        ├── download.rs     # yt-dlp + ffmpeg download and tagging
        ├── lyrics_fetch.rs # LRCLIB lookups
        ├── cover_fetch.rs  # cover lookups
        └── progress.rs     # progress events for long jobs
```

The front end and backend talk over Tauri commands; the command surface is
`src-tauri/src/lib.rs`, and the typed wrappers the front end calls are in
`src/lib/ipc.ts`.

## Development

- Front end: TypeScript, Vite, and the DOM. `tsconfig.json` is strict
  (`strict`, `noUnusedLocals`, `noUnusedParameters`), so `npm run build` doubles
  as a type check.
- Backend: Rust, Tauri 2. The Rust modules carry unit tests — run them with:

  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml
  ```

- The VS Code workspace recommends the `tauri-vscode` and `rust-analyzer`
  extensions (`.vscode/extensions.json`).

When you add a command, register it in the `invoke_handler` in
`src-tauri/src/lib.rs` and add a wrapper in `src/lib/ipc.ts`.

## Platform notes

Wave behaves the same on Windows 10/11 and Linux, with three small differences
worth knowing:

- **Browser accelerator keys.** On Windows, Wave turns off WebView2's own
  shortcuts (`Ctrl+R`, `F5`, `F12`, …) so they reach the app instead of the
  webview. On Linux those are not disabled, so `Ctrl+R` can reload the view.
- **Window reveal.** The window starts hidden and is revealed once the theme and
  the current song's artwork are applied. Wayland has no API to hide and show a
  window, so on Wayland the window may appear before that finishes.
- **WebView2 arguments.** The `additionalBrowserArgs` in
  `src-tauri/tauri.conf.json` (autoplay policy, background throttling) apply to
  WebView2 only and are ignored on Linux.

The custom titlebar, the undecorated window, resizing by dragging within a few
pixels of an edge, the mini player, and always-on-top are all handled by Tauri on
both platforms and need no per-OS code.

## Troubleshooting

- **The window never appears.** Wave keeps the window hidden until the theme and
  the current song's artwork are applied, and reveals it after a short timeout
  regardless. If it still does not show, check the terminal for a Rust panic.
- **Playback works but nothing else does.** You are probably running `npm run
  dev` in a browser. Use `npm run tauri dev`.
- **Spotify says a playlist is missing (404).** It is almost certainly one of
  Spotify's own editorial playlists, which the API will not hand to apps. Use a
  playlist you own.
- **Spotify says yt-dlp or ffmpeg was not found.** Install them and make sure
  they are on `PATH`, or set `YTDLP_PATH` / `FFMPEG_PATH` in the config `.env`.
- **A song will not play.** Wave never guesses tags — a file with no artist tag
  is shown without one. Corrupt or unsupported files are reported in the status
  strip and skipped.
- **The Linux build fails to link OpenSSL or WebKitGTK.** The development
  packages are missing. Install them as shown in [Requirements](#requirements);
  the usual culprits are `libwebkit2gtk-4.1-dev` and `libssl-dev`
  (Debian/Ubuntu), or `webkit2gtk4.1-devel` and `openssl-devel` (Fedora).
- **A window cannot be moved or resized on Linux/X11.** Some desktop
  environments force client-side decorations (`GTK_CSD=1`), which interferes
  with undecorated windows. Launch with `GTK_CSD=0` to work around it.

## License

No license file is included in this repository, so all rights are reserved by
default. Add a `LICENSE` file before you redistribute or build on this code
publicly.
