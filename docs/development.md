# Developing Wave

[Back to the README](../README.md)

The interface uses TypeScript and the DOM; the backend uses Rust and Tauri 2.
See the README for prerequisites and the basic development setup.

## Commands

```sh
npm run build              # Type-check and build the frontend
npm test                   # Run the Node.js tests
npm run tauri build        # Build the desktop app and installers
npm run dev:phone          # Browser phone simulator with mock data
npm run phone              # Tauri window with the Linux phone layout
npx tauri android dev      # Run on an Android device or emulator
```

The browser phone simulator does not need a phone or the Rust backend. Select
`linuxPhone` and a small or landscape device size to test its popups. Android
requests portrait orientation on phone-sized screens.

For UI overflow checks, install the test browser with `npx playwright install
chromium`, then run `npm run test:ui`. The checks cover desktop and portrait
phone views and popups. To use an existing Chromium browser instead, set
`WAVE_TEST_BROWSER` to its executable path.

With Node.js 22 or newer, run `npm run benchmark:eq` to compare native
playback with the disabled equaliser graph in a muted, headless Chromium
browser. Set `WAVE_BENCHMARK_BROWSER` to the executable if the default is not
installed. Results measure CPU on that browser and device, not battery use.

`npm run tauri build` fetches the bundled download tools as needed. Run
`node scripts/release.mjs slim` for a desktop build without them. For an
Android APK, run `npm run release -- android` (or add `debug` for a debug
build). The APK is written to `src-tauri/target/android/`.

## Development libraries

Desktop development builds can run alongside an installed release. By default,
`npm run tauri dev` uses the installed library. Select the library explicitly
with either command:

```sh
npm run tauri dev shared
npm run tauri dev isolated
```

Shared mode uses the installed app's actual songs, artwork and playlist
catalogue: edits and deletions affect the installed library. Its source
credentials and tool configuration in `library/config/.env` are shared too.
Restart the other app to see changes made by one instance. If Wave is not
installed, use isolated mode to create a separate test library.

Starting shared Dev scans the library and may update the catalogue. Avoid
editing or importing while either app is scanning, editing or importing: their
file operations are not coordinated across processes. If the installed
catalogue needs a migration or does not match the development build, shared
mode refuses to open it.

Shared Dev loads a fresh copy of the installed settings, likes, queue and
window state each time it starts; changes to those in Dev stay separate and
are reset from the installed app on the next launch. Wave Swell uses the
installed listening history, so plays, imports and clearing history affect
both apps. The import log is shared too.

Both modes keep their own WebView data and cannot install release updates.
Isolated mode never uses the installed library or other installed data. When
the local API is enabled in shared Dev, it uses an available loopback port and
prints that port in the terminal, leaving the installed app's port free.

Android debug builds install as **Wave Dev** (`com.wave.app.dev`), alongside the
release app (`com.wave.app`). They have separate private data, and Wave Dev
cannot install release updates. Do not use `tauri android dev --release` to
test alongside the release app: that option uses the release package ID.

## CLI and API

The desktop executable accepts commands such as:

```sh
wave help
wave list --json
wave search "artist name"
wave import "path/to/music"
wave help import
```

The executable must be on `PATH`, or invoked by its full path. Windows
installers do not add it to `PATH`. Commands use the same library and config
as the app and require a desktop session on Linux.

The local HTTP API is off by default and is unavailable on Android. Enable it
under **Settings → Developer** to listen on `127.0.0.1:45679`. It has no
authentication, so local processes can access it. Set `WAVE_API_PORT` in the
config `.env` to change the port. See the [API documentation](api.md) for
endpoints and examples.

## Linux phone lab

To test the downloaded ARM phone app from this checkout, start Docker Desktop
or Docker Engine and run `npm run phone:lab`. Open
<http://127.0.0.1:6080/vnc.html> after installation. To hear playback, open
<http://127.0.0.1:6082/stream.mp3> in another tab and press play; the stream
has some delay and supports one listener. To select a release, run
`node scripts/phone-lab.mjs --version 0.3.2` or
`node scripts/phone-lab.mjs --archive /path/to/Wave_0.3.2_aarch64_musl.tar.gz`.
Optionally add `--music /path/to/music` to expose a read-only folder at
`/music`. Press Ctrl+C to stop the lab and remove its container and library;
`docker stop wave-phone-lab` also stops it.

The lab uses ARM emulation, X11 and software rendering, and disables WebKit's
sandbox inside the container; it does not replace testing on a real phone or
postmarketOS Wayland VM.
