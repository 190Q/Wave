import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Windows" } });
globalThis.document = { hidden: true, addEventListener() {} };
globalThis.window = {
  setTimeout, clearTimeout, setInterval, clearInterval,
  cancelAnimationFrame() {}, addEventListener() {},
};
globalThis.requestAnimationFrame = () => 1;
globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };

class FakeAudio {
  static instances = [];
  listeners = new Map();
  paused = true;
  ended = false;
  seeking = false;
  readyState = 1;
  currentTime = 0;
  duration = 120;
  src = "";
  pauses = 0;

  constructor() { FakeAudio.instances.push(this); }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name) { for (const callback of this.listeners.get(name) ?? []) callback(); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.pauses += 1; this.paused = true; this.emit("pause"); }
  removeAttribute() { this.src = ""; }
  load() {}
}
globalThis.Audio = FakeAudio;

const ipcFile = await readFile(new URL("../src/lib/ipc.ts", import.meta.url), "utf8");
const ipcNames = [...ipcFile.matchAll(/export (?:async )?function (\w+)\(/g)].map((match) => match[1]);
const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "metadata-playback-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "@tauri-apps/api/event") return "\0test-events";
      if (source === "@tauri-apps/api/app") return "\0test-app";
      if (source === "./ipc" && /[\\/]src[\\/]lib[\\/]/.test(importer ?? "")) return "\0test-ipc";
      if (source === "./analytics" && /[\\/]state\.ts$/.test(importer ?? "")) return "\0test-analytics";
      if (source === "./audio-watchdog" && /[\\/]state\.ts$/.test(importer ?? "")) return "\0test-watchdog";
    },
    load(id) {
      if (id === "\0test-events") return "export const listen = async () => () => {};";
      if (id === "\0test-app") return "export const getVersion = async () => 'test';";
      if (id === "\0test-ipc") return ipcNames.map((name) =>
        `export const ${name} = (...args) => globalThis.__metadataIpc.${name}(...args);`).join("\n");
      if (id === "\0test-analytics") return [
        "export const flushAnalytics = async () => {};",
        "export const mountAnalytics = () => {};",
        "export const notePlaybackError = () => {};",
        "export const noteTrackEnded = () => {};",
        "export const recordEvent = () => {};",
        "export const rememberTracks = async () => {};",
      ].join("\n");
      if (id === "\0test-watchdog") return "export const mountAudioWatchdog = () => {};";
    },
  }],
});
after(() => vite.close());

let backend;
let result;
const cleaned = [];
globalThis.__metadataIpc = new Proxy({
  editTrack: () => Promise.resolve(result),
  cleanupTrackEdit: async (id) => { cleaned.push(id); },
  scanLibrary: async () => ({ changed: [], removed: [], root: "", skipped: 0, errors: [] }),
  libraryInfo: async () => ({ tracks: 2 }),
  loadState: async () => structuredClone(backend),
}, { get: (target, name) => target[name] ?? (async () => null) });

const app = await vite.ssrLoadModule("/src/lib/state.ts");
backend = { settings: structuredClone(app.getState().settings), likes: [], playlists: [], artworkColours: {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function track(id, path, title = id) {
  return {
    id, path, title, artist: null, album: null, albumArtist: null, genre: null,
    year: null, trackNo: null, discNo: null, durationMs: 120000, artworkPath: null,
    lyricsPath: null, addedAt: 0,
  };
}

test("repeated edits leave the playing element untouched until its file is released", async () => {
  const original = track("one", "/songs/one/audio.mp3");
  const next = track("two", "/songs/two/audio.mp3");
  const state = app.getState();
  state.tracks = [original, next];
  state.tracksById = new Map(state.tracks.map((song) => [song.id, song]));
  app.player.setQueue("all", "All", ["one", "two"]);
  app.player.play();
  const audio = FakeAudio.instances.at(-1);
  audio.currentTime = 42;
  const count = FakeAudio.instances.length;

  const first = track("one", "/songs/one/audio-first.mp3", "First");
  result = { track: first, previousPath: original.path, cleanupId: "first" };
  await app.editTrack("one", { title: "First" });
  assert.equal(FakeAudio.instances.length, count);
  assert.equal(audio.currentTime, 42);
  assert.equal(audio.paused, false);
  assert.equal(audio.pauses, 0);
  assert.equal(state.tracksById.get("one").title, "First");
  assert.deepEqual(cleaned, []);

  const second = track("one", "/songs/one/audio-second.mp3", "Second");
  result = { track: second, previousPath: first.path, cleanupId: "second" };
  await app.editTrack("one", { title: "Second" });
  assert.equal(audio.paused, false);
  assert.deepEqual(cleaned, ["second"]);

  document.hidden = false;
  audio.volume = 0.5;
  app.player.next();
  await tick();
  assert.deepEqual(cleaned, ["second"]);
  app.player.finishTransitions();
  await tick();
  assert.deepEqual(cleaned, ["second", "first"]);
  app.player.previous();
  assert.equal(FakeAudio.instances.at(-1).src, second.path);
  document.hidden = true;
  app.player.finishTransitions();
});

test("a paused element releases its old source when it is reused", async () => {
  app.player.pause();
  app.player.finishTransitions();
  const audio = FakeAudio.instances.at(-1);
  const previous = app.getState().tracksById.get("one");
  const updated = track("one", "/songs/one/audio-third.mp3", "Third");
  result = { track: updated, previousPath: previous.path, cleanupId: "third" };
  await app.editTrack("one", { title: "Third" });
  assert.equal(cleaned.includes("third"), false);
  app.player.next();
  await tick();
  assert.equal(FakeAudio.instances.at(-1), audio);
  assert.equal(cleaned.includes("third"), true);
});

test("an edit finishing during a cross-fade keeps the retiring song until it stops", async () => {
  let finishEdit;
  globalThis.__metadataIpc.editTrack = () => new Promise((resolve) => { finishEdit = resolve; });
  const previous = app.getState().tracksById.get("two");
  const updated = track("two", "/songs/two/audio-edited.mp3", "Edited");
  const retiring = FakeAudio.instances.at(-1);
  document.hidden = false;
  retiring.volume = 0.5;
  const edit = app.editTrack("two", { title: "Edited" });
  app.player.previous();
  finishEdit({ track: updated, previousPath: previous.path, cleanupId: "fourth" });
  await edit;
  assert.equal(cleaned.includes("fourth"), false);
  assert.equal(retiring.paused, false);
  app.player.finishTransitions();
  await tick();
  assert.equal(cleaned.includes("fourth"), true);
  assert.equal(app.player.currentId, "one");
  document.hidden = true;
});
