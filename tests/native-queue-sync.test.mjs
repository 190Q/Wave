import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const messages = [];
const listeners = new Map();
const clone = (value) => structuredClone(value);
let timer = 0;
let backend;
let scanTracks = [];
const tick = () => new Promise((resolve) => setImmediate(resolve));

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: "Android" },
});
globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
globalThis.Audio = class {
  paused = true;
  readyState = 0;
  addEventListener() {}
  removeEventListener() {}
  removeAttribute() {}
  load() {}
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
};
globalThis.document = {
  hidden: false,
  addEventListener() {},
  documentElement: { dataset: {}, style: { setProperty() {} } },
};
globalThis.window = {
  setTimeout() { return ++timer; },
  clearTimeout() {},
  setInterval() { return ++timer; },
  clearInterval() {},
  addEventListener() {},
  cancelAnimationFrame() {},
  waveNativePlayback: {
    onmessage: null,
    postMessage(message) {
      const update = JSON.parse(message);
      messages.push(update);
      if (update.type === "connect") {
        this.onmessage?.({ data: JSON.stringify({
          type: "snapshot",
          available: false,
          live: false,
          currentId: null,
          path: null,
          positionMs: 0,
          durationMs: 0,
          playing: false,
          playback: {},
        }) });
      }
    },
  },
};
globalThis.requestAnimationFrame = () => ++timer;
globalThis.__nativeQueueListeners = listeners;
globalThis.__nativeQueueIpc = new Proxy({
  loadState: async () => clone(backend),
  audioStreamBase: async () => "http://127.0.0.1:1234",
  scanLibrary: async () => ({ changed: clone(scanTracks), removed: [], root: "", skipped: 0, errors: [] }),
  libraryInfo: async () => ({ tracks: scanTracks.length }),
  analyticsPlayCounts: async () => ({}),
  artworkColour: async () => "#abcdef",
}, { get: (target, name) => target[name] ?? (async () => null) });

const ipcFile = await readFile(new URL("../src/lib/ipc.ts", import.meta.url), "utf8");
const ipcNames = [...ipcFile.matchAll(/export (?:async )?function (\w+)\(/g)].map((match) => match[1]);

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  ssr: { noExternal: ["@tauri-apps/api"] },
  plugins: [{
    name: "native-queue-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "@tauri-apps/api/event") return "\0native-queue-events";
      if (source === "@tauri-apps/api/app") return "\0native-queue-app";
      if (source === "./ipc" && /[\\/]src[\\/]lib[\\/]/.test(importer ?? "")) return "\0native-queue-ipc";
      if (source === "./analytics" && /[\\/]state\.ts$/.test(importer ?? "")) return "\0native-queue-analytics";
      if (source === "./audio-watchdog" && /[\\/]state\.ts$/.test(importer ?? "")) return "\0native-queue-watchdog";
    },
    load(id) {
      if (id === "\0native-queue-events") {
        return "export const listen = async (name, callback) => { globalThis.__nativeQueueListeners.set(name, callback); return () => globalThis.__nativeQueueListeners.delete(name); };";
      }
      if (id === "\0native-queue-app") return "export const getVersion = async () => 'test';";
      if (id === "\0native-queue-ipc") {
        return ipcNames.map((name) => `export const ${name} = (...args) => globalThis.__nativeQueueIpc.${name}(...args);`).join("\n");
      }
      if (id === "\0native-queue-analytics") {
        return "export const flushAnalytics = async () => {}; export const mediaTypeOf = () => 'music'; export const mountAnalytics = () => {}; export const notePlaybackError = () => {}; export const noteTrackEnded = () => {}; export const recordEvent = () => {}; export const rememberTracks = () => {};";
      }
      if (id === "\0native-queue-watchdog") return "export const mountAudioWatchdog = () => {};";
    },
  }],
});
after(() => vite.close());

const app = await vite.ssrLoadModule("/src/lib/state.ts");
backend = {
  settings: { ...clone(app.getState().settings), autoUpdate: false },
  likes: [], playlists: [], windowSlots: [], recentImports: [], artworkColours: {},
};
await app.init();

class CountedMap extends Map {
  reads = 0;

  get(key) {
    this.reads += 1;
    return super.get(key);
  }
}

function queueMessages() {
  return messages.filter((message) => message.type === "queue");
}

test("native queue payloads are reused until the queue or track data changes", async () => {
  const tracks = Array.from({ length: 200 }, (_, index) => ({
    id: `track-${index}`,
    path: `C:\\music\\${index}.mp3`,
    title: `Track ${index}`,
    artist: "Artist",
    album: "Album",
    durationMs: 120000,
    artworkPath: index === 50 ? "cover.jpg" : null,
    lufs: null,
    peak: null,
  }));
  const state = app.getState();
  const byId = new CountedMap(tracks.map((track) => [track.id, track]));
  state.ready = true;
  state.tracks = tracks;
  state.tracksById = byId;
  state.colours = new Map();
  app.player.setQueue("queue", "Queue", tracks.slice(0, -1).map((track) => track.id));
  messages.length = 0;
  byId.reads = 0;

  app.syncNativeQueue();
  assert.equal(queueMessages().length, 1);
  assert.ok(byId.reads >= tracks.length - 1 && byId.reads < tracks.length + 5);
  assert.equal(queueMessages()[0].tracks.length, tracks.length - 1);

  byId.reads = 0;
  app.syncNativeQueue();
  assert.ok(byId.reads < tracks.length);
  assert.equal(queueMessages().length, 1);

  byId.reads = 0;
  app.player.toggleMute();
  app.syncNativeQueue();
  assert.ok(byId.reads < tracks.length);
  assert.equal(queueMessages().length, 2);
  assert.equal(queueMessages().at(-1).playback.muted, true);

  byId.reads = 0;
  app.player.moveTo(tracks[100].id);
  byId.reads = 0;
  app.syncNativeQueue();
  assert.ok(byId.reads < tracks.length);
  assert.equal(queueMessages().length, 2);

  byId.reads = 0;
  app.player.setRepeat("all");
  app.syncNativeQueue();
  assert.ok(byId.reads < tracks.length);
  assert.equal(queueMessages().length, 3);
  assert.equal(queueMessages().at(-1).playback.repeat, "all");

  app.player.appendToQueue(tracks.at(-1).id);
  byId.reads = 0;
  app.syncNativeQueue();
  assert.ok(byId.reads >= tracks.length && byId.reads < tracks.length + 5);
  assert.equal(queueMessages().length, 4);
  assert.equal(queueMessages().at(-1).tracks.at(-1).id, tracks.at(-1).id);

  const changed = { ...tracks[10], title: "Renamed track" };
  const updated = new CountedMap([...byId].map(([id, track]) => [id, id === changed.id ? changed : track]));
  state.tracksById = updated;
  app.syncNativeQueue();
  assert.ok(updated.reads >= tracks.length && updated.reads < tracks.length + 5);
  assert.equal(queueMessages().length, 5);
  assert.equal(queueMessages().at(-1).tracks[10].title, "Renamed track");

  const landed = { ...changed, title: "Landed track" };
  updated.set(landed.id, landed);
  listeners.get("library-landed")({ payload: [landed] });
  app.syncNativeQueue();
  assert.equal(queueMessages().length, 6);
  assert.equal(queueMessages().at(-1).tracks[10].title, "Landed track");

  const previousGain = queueMessages().at(-1).tracks[100].gain;
  listeners.get("loudness-scan")({ payload: {
    id: tracks[100].id, lufs: -20, peak: 0.5, done: 1, total: 1,
  } });
  app.syncNativeQueue();
  assert.equal(queueMessages().length, 7);
  assert.notEqual(queueMessages().at(-1).tracks[100].gain, previousGain);

  const colours = state.colours;
  app.ensureColour(tracks[50]);
  await tick();
  app.syncNativeQueue();
  assert.equal(state.colours, colours);
  assert.equal(queueMessages().length, 8);
  assert.equal(queueMessages().at(-1).tracks[50].colour, "#abcdef");
});
