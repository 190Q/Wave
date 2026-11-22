import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: "Android" },
});

let menu;
const calls = [];
let selected = null;
let replacement = null;
let resolveOldColour;
globalThis.Audio = class {
  paused = true;
  addEventListener() {}
};
globalThis.document = {
  documentElement: { dataset: {}, style: { setProperty() {} } },
  body: { appendChild(element) { menu = element; } },
  createElement() {
    return {
      style: {},
      offsetWidth: 180,
      offsetHeight: 200,
      setAttribute() {},
      addEventListener(type, callback) { this[type] = callback; },
      querySelectorAll() { return []; },
      remove() {},
    };
  },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = {
  innerWidth: 800,
  innerHeight: 600,
  matchMedia: () => ({ matches: false }),
  setTimeout: () => 1,
  clearTimeout() {},
  setInterval() {},
  addEventListener() {},
  removeEventListener() {},
  __TAURI_INTERNALS__: {
    invoke(command, args) {
      calls.push({ command, args });
      if (command === "plugin:dialog|open") return Promise.resolve(selected);
      if (command === "replace_cover") return Promise.resolve(replacement);
      if (command === "artwork_colour") {
        return args.path === "old-cover"
          ? new Promise((resolve) => { resolveOldColour = resolve; })
          : Promise.resolve("#12ab34");
      }
      if (command === "scan_library") {
        return Promise.resolve({ changed: [], removed: [], total: 1, root: "library", skipped: 0, errors: [] });
      }
      if (command === "get_state") {
        return Promise.resolve({ settings: getState().settings, playlists: [], likes: [], artworkColours: {} });
      }
      return Promise.resolve(null);
    },
  },
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
});
after(() => vite.close());
const { setDevice } = await vite.ssrLoadModule("/src/lib/device.ts");
const { ensureColour, getState, player, replaceTrackCover } = await vite.ssrLoadModule("/src/lib/state.ts");
const { openTrackMenu } = await vite.ssrLoadModule("/src/ui/library.ts");
const { closeMenu } = await vite.ssrLoadModule("/src/ui/menu.ts");
const row = { getBoundingClientRect: () => ({ top: 50, right: 100, bottom: 80 }) };
getState().tracksById.set("song", { id: "song", title: "Song" });

for (const device of ["desktop", "android", "linuxPhone"]) {
  test(`${device} song menu opens the native cover picker`, async () => {
    calls.length = 0;
    setDevice(device);
    openTrackMenu(row, null, ["song"], { x: 100, y: 100 });
    const match = menu.innerHTML.match(/data-index="(\d+)"[^>]*>Replace cover<\/button>/);
    assert.ok(match, "Replace cover is missing from the menu");
    const button = {
      dataset: { index: match[1] },
      closest() { return this; },
      hasAttribute() { return false; },
    };
    menu.click({ target: button });
    await Promise.resolve();
    assert.equal(calls[0].command, "plugin:dialog|open");
    assert.equal(calls.length, 1);
    closeMenu();
  });
}

test("the action is not offered for missing or multiple songs", () => {
  setDevice("desktop");
  menu = null;
  openTrackMenu(row, null, ["missing"], { x: 100, y: 100 });
  assert.equal(menu, null);
  getState().tracksById.set("other", { id: "other", title: "Other" });
  openTrackMenu(row, null, ["song", "other"], { x: 100, y: 100 });
  assert.doesNotMatch(menu.innerHTML, /Replace cover/);
  closeMenu();
});

test("phone menus offer jumping only for the current song", () => {
  getState().tracksById.set("other", { id: "other", title: "Other" });
  player.order = ["song", "other"];
  player.cursor = 0;
  for (const device of ["android", "linuxPhone", "desktop"]) {
    setDevice(device);
    openTrackMenu(row, null, ["song"], { x: 100, y: 100 });
    assert.equal(menu.innerHTML.includes(">Jump to time</button>"), device !== "desktop");
    closeMenu();
    openTrackMenu(row, null, ["other"], { x: 100, y: 100 });
    assert.doesNotMatch(menu.innerHTML, />Jump to time<\/button>/);
    closeMenu();
    openTrackMenu(row, null, ["song", "other"], { x: 100, y: 100 });
    assert.doesNotMatch(menu.innerHTML, />Jump to time<\/button>/);
    closeMenu();
  }
});

test("replacing a cover refreshes the track and rejects an old colour result", async () => {
  const track = {
    id: "song",
    title: "Song",
    path: "audio.wav",
    relativePath: "audio.wav",
    artist: null,
    album: null,
    albumArtist: null,
    genre: null,
    year: null,
    trackNo: null,
    discNo: null,
    durationMs: 1000,
    codec: "WAV",
    bitrate: null,
    sampleRate: null,
    artworkPath: "old-cover",
    lyricsPath: null,
    hasEmbeddedArt: false,
    lufs: null,
    peak: null,
    addedAt: 0,
  };
  const state = getState();
  state.tracks = [track];
  state.tracksById = new Map([[track.id, track]]);
  player.order = [track.id];
  ensureColour(track);
  assert.ok(resolveOldColour);

  calls.length = 0;
  selected = "content://documents/image/123";
  replacement = { ...track, artworkPath: "new-cover" };
  await replaceTrackCover(track.id);
  assert.equal(state.tracksById.get(track.id).artworkPath, "new-cover");
  assert.equal(state.tracks[0].artworkPath, "new-cover");
  assert.equal(state.scanning, false);
  assert.equal(state.notice, 'Cover updated for "Song".');
  assert.ok(calls.some((call) => call.command === "replace_cover" && call.args.path === selected));

  resolveOldColour("#ff0000");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.colours.get(track.id), "#12ab34");
  assert.ok(calls.some((call) => call.command === "artwork_colour" && call.args.path === "new-cover"));
  selected = null;
});
