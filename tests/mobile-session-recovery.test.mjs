import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

class Events {
  listeners = new Map();
  addEventListener(name, callback) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(callback);
    this.listeners.set(name, listeners);
  }
  dispatch(name) {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }
}

const values = new Map();
let storageFails = false;
const storage = {
  getItem: (key) => values.get(key) ?? null,
  setItem(key, value) {
    if (storageFails) throw new Error("storage unavailable");
    values.set(key, value);
  },
  removeItem: (key) => values.delete(key),
};
const intervals = new Map();
const timeouts = new Map();
let nextTimer = 0;
const doc = Object.assign(new Events(), {
  hidden: false,
  documentElement: { dataset: {}, style: { setProperty() {} } },
});
const win = Object.assign(new Events(), {
  localStorage: storage,
  setInterval(callback, delay) {
    const id = ++nextTimer;
    intervals.set(id, { callback, delay });
    return id;
  },
  clearInterval: (id) => intervals.delete(id),
  setTimeout(callback, delay) {
    const id = ++nextTimer;
    timeouts.set(id, { callback, delay });
    return id;
  },
  clearTimeout: (id) => timeouts.delete(id),
  cancelAnimationFrame() {},
});
const audio = [];
globalThis.Audio = class {
  paused = true;
  ended = false;
  seeking = false;
  readyState = 1;
  currentTime = 0;
  duration = 300;
  constructor() { audio.push(this); }
  addEventListener() {}
  removeEventListener() {}
  removeAttribute() {}
  load() {}
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
};
globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
globalThis.document = doc;
globalThis.window = win;
globalThis.requestAnimationFrame = () => 1;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: "Android" },
});

const clone = (value) => structuredClone(value);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const tracks = ["a", "b", "c"].map((id) => ({
  id, title: id, path: id, durationMs: 300000, artworkPath: null,
  artist: null, album: null, albumArtist: null, genre: null, lufs: null, peak: null,
}));
let backend;
let scannedTracks = tracks;
let scanErrors = [];
const writes = [];
globalThis.__recoveryIpc = new Proxy({
  loadState: async () => clone(backend),
  audioStreamBase: async () => "http://127.0.0.1:1234",
  scanLibrary: async () => ({ changed: clone(scannedTracks), removed: [], root: "", skipped: 0, errors: [...scanErrors] }),
  libraryInfo: async () => ({ tracks: scannedTracks.length }),
  analyticsPlayCounts: async () => ({}),
  saveSession: async (session) => {
    writes.push(clone(session));
    backend.session = clone(session);
    return clone(backend);
  },
}, { get: (target, name) => target[name] ?? (async () => null) });
globalThis.__recoveryListen = async () => () => {};

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
    name: "mobile-recovery-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "@tauri-apps/api/event") return "\0recovery-events";
      if (source === "@tauri-apps/api/app") return "\0recovery-app";
      if (source === "./ipc" && /[\\/]src[\\/]lib[\\/]/.test(importer ?? "")) return "\0recovery-ipc";
      if (source === "./analytics" && /[\\/]state\.ts(?:\?.*)?$/.test(importer ?? "")) return "\0recovery-analytics";
      if (source === "./audio-watchdog" && /[\\/]state\.ts(?:\?.*)?$/.test(importer ?? "")) return "\0recovery-watchdog";
    },
    load(id) {
      if (id === "\0recovery-events") return "export const listen = (...args) => globalThis.__recoveryListen(...args);";
      if (id === "\0recovery-app") return "export const getVersion = async () => 'test';";
      if (id === "\0recovery-ipc") {
        return ipcNames.map((name) => `export const ${name} = (...args) => globalThis.__recoveryIpc.${name}(...args);`).join("\n");
      }
      if (id === "\0recovery-analytics") {
        return "export const flushAnalytics = async () => {}; export const mountAnalytics = () => {}; export const notePlaybackError = () => {}; export const noteTrackEnded = () => {}; export const recordEvent = () => {}; export const rememberTracks = () => {};";
      }
      if (id === "\0recovery-watchdog") return "export const mountAudioWatchdog = () => {};";
    },
  }],
});
after(() => vite.close());

const { setDevice } = await vite.ssrLoadModule("/src/lib/device.ts");
const { newestSession, readSessionRecovery, SESSION_RECOVERY_KEY } =
  await vite.ssrLoadModule("/src/lib/session-recovery.ts");
let bootNumber = 0;

function session(savedAt, cursor, positionMs) {
  return {
    savedAt,
    playback: {
      sourceId: "all", sourceName: "All songs", sourceOrder: ["a", "b", "c"],
      order: ["c", "b", "a"], cursor, positionMs, shuffle: true, repeat: "all", muted: true,
    },
    recents: ["all"], filter: "albums", sort: "size", queueOpen: true,
  };
}

async function boot(saved, resumeOnLaunch = true, settings = {}) {
  intervals.clear();
  timeouts.clear();
  doc.listeners.clear();
  win.listeners.clear();
  doc.hidden = false;
  setDevice("android");
  const app = await vite.ssrLoadModule(`/src/lib/state.ts?boot=${++bootNumber}`);
  backend = {
    settings: { ...clone(app.getState().settings), autoUpdate: false, resumeOnLaunch, ...settings },
    likes: [], playlists: [], windowSlots: [], recentImports: [], artworkColours: {},
    session: clone(saved),
  };
  await app.init();
  return app;
}

function checkpoint() {
  const timer = [...intervals.values()].find((entry) => entry.delay === 2000);
  assert.ok(timer);
  timer.callback();
}

test("newer recovery survives abrupt termination with the queue, seek, and latest checkpoint", async () => {
  const disk = session(10, 2, 5000);
  storage.setItem(SESSION_RECOVERY_KEY, JSON.stringify(session(20, 1, 42000)));
  const first = await boot(disk);
  assert.equal(first.player.currentId, "b");
  assert.equal(first.player.positionMs, 42000);
  assert.equal(first.player.snapshot().playing, false);
  first.player.seek(65000);
  assert.equal(readSessionRecovery(storage).playback.positionMs, 65000);
  first.setSort("recent");
  first.player.play();
  audio.at(-1).currentTime = 68;
  checkpoint();
  const recovery = readSessionRecovery(storage);
  assert.equal(recovery.playback.positionMs, 68000);
  assert.equal(recovery.sort, "recent");
  assert.deepEqual(recovery.playback.order, ["c", "b", "a"]);
  assert.equal(backend.session.savedAt, 10);

  const restarted = await boot(disk);
  const restored = restarted.player.snapshot();
  assert.equal(restored.currentId, "b");
  assert.equal(restored.positionMs, 68000);
  assert.deepEqual(restored.order, ["c", "b", "a"]);
  assert.equal(restored.shuffle, true);
  assert.equal(restored.repeat, "all");
  assert.equal(restored.muted, true);
  assert.equal(restored.playing, false);
  assert.equal(restarted.getState().sort, "recent");
  assert.equal(restarted.getState().filter, "albums");
});

test("newer backend state wins and disabling resume still takes precedence", async () => {
  const old = readSessionRecovery(storage);
  const disk = session(old.savedAt + 100, 0, 10000);
  const app = await boot(disk);
  assert.equal(app.player.currentId, "c");
  assert.equal(app.player.positionMs, 10000);

  const disabled = await boot(disk, false);
  assert.equal(disabled.player.currentId, "a");
  assert.equal(disabled.player.positionMs, 0);
});

test("unavailable web storage falls back to frequent backend checkpoints", async () => {
  values.clear();
  storageFails = true;
  const app = await boot(session(30, 1, 1000));
  app.player.play();
  audio.at(-1).currentTime = 17;
  const before = writes.length;
  checkpoint();
  await tick();
  assert.equal(writes.length, before + 1);
  assert.equal(backend.session.playback.positionMs, 17000);
  storageFails = false;
});

test("backgrounding captures the current position without stopping future checkpoints", async () => {
  values.clear();
  const app = await boot(session(40, 1, 1000));
  app.player.play();
  audio.at(-1).currentTime = 25;
  doc.hidden = true;
  doc.dispatch("visibilitychange");
  assert.equal(readSessionRecovery(storage).playback.positionMs, 25000);
  await tick();
  assert.equal(backend.session.playback.positionMs, 25000);
  assert.ok([...intervals.values()].some((entry) => entry.delay === 2000));
});

test("an incomplete scan cannot erase the saved queue and a later scan restores it", async () => {
  values.clear();
  scannedTracks = tracks.filter((track) => track.id !== "b");
  scanErrors = ["Library unavailable"];
  try {
    const saved = session(50, 1, 42000);
    const app = await boot(saved);
    assert.equal(app.player.currentId, null);
    doc.hidden = true;
    doc.dispatch("visibilitychange");
    assert.deepEqual(readSessionRecovery(storage).playback, saved.playback);
    await tick();
    assert.deepEqual(backend.session.playback, saved.playback);

    scannedTracks = tracks;
    scanErrors = [];
    await app.rescan(true);
    assert.equal(app.player.currentId, "b");
    assert.equal(app.player.positionMs, 42000);
    assert.deepEqual(app.player.snapshot().order, ["c", "b", "a"]);
  } finally {
    scannedTracks = tracks;
    scanErrors = [];
  }
});

test("choosing a new queue replaces a pending recovery after an incomplete scan", async () => {
  values.clear();
  scannedTracks = tracks.filter((track) => track.id !== "b");
  scanErrors = ["Library unavailable"];
  try {
    const app = await boot(session(55, 1, 42000));
    app.player.setQueue("new", "New queue", ["a", "c"], "c");
    assert.equal(app.player.currentId, "c");
    assert.deepEqual(readSessionRecovery(storage).playback.order, ["a", "c"]);

    scannedTracks = tracks;
    scanErrors = [];
    await app.rescan(true);
    assert.equal(app.player.currentId, "c");
    assert.deepEqual(app.player.snapshot().order, ["a", "c"]);
  } finally {
    scannedTracks = tracks;
    scanErrors = [];
  }
});

test("a partial scan keeps missing queue entries while available playback advances", async () => {
  values.clear();
  scannedTracks = tracks.filter((track) => track.id !== "c");
  scanErrors = ["Library unavailable"];
  try {
    const app = await boot(session(57, 1, 42000));
    assert.equal(app.player.currentId, "b");
    assert.deepEqual(app.player.snapshot().order, ["b", "a"]);

    app.player.moveTo("a");
    app.player.seek(17000);
    app.player.setRepeat("off");
    app.player.play();
    const pending = readSessionRecovery(storage).playback;
    assert.deepEqual(pending.order, ["c", "b", "a"]);
    assert.equal(pending.cursor, 2);
    assert.equal(pending.positionMs, 17000);
    assert.equal(pending.repeat, "off");

    scannedTracks = tracks;
    scanErrors = [];
    await app.rescan(true);
    assert.equal(app.player.currentId, "a");
    assert.ok(app.player.positionMs >= 17000 && app.player.positionMs < 17250);
    assert.equal(app.player.snapshot().playing, true);
    assert.deepEqual(app.player.snapshot().order, ["c", "b", "a"]);
  } finally {
    scannedTracks = tracks;
    scanErrors = [];
  }
});

test("a new queue overrides pending missing entries even when its current track is unchanged", async () => {
  values.clear();
  scannedTracks = tracks.filter((track) => track.id !== "c");
  scanErrors = ["Library unavailable"];
  try {
    const app = await boot(session(58, 1, 42000));
    app.player.setQueue("new", "New queue", ["b", "a"], "b");
    assert.deepEqual(readSessionRecovery(storage).playback.order, ["b", "a"]);

    scannedTracks = tracks;
    scanErrors = [];
    await app.rescan(true);
    assert.equal(app.player.currentId, "b");
    assert.deepEqual(app.player.snapshot().order, ["b", "a"]);
  } finally {
    scannedTracks = tracks;
    scanErrors = [];
  }
});

test("a removed current song does not transfer its position to another song", async () => {
  values.clear();
  scannedTracks = tracks.filter((track) => track.id !== "b");
  try {
    const app = await boot(session(60, 1, 42000));
    assert.equal(app.player.currentId, "c");
    assert.equal(app.player.positionMs, 0);
  } finally {
    scannedTracks = tracks;
  }
});

test("invalid recovery data and older snapshots cannot override a valid save", () => {
  const saved = session(100, 0, 0);
  storage.setItem(SESSION_RECOVERY_KEY, "{");
  assert.equal(readSessionRecovery(storage), null);
  storage.setItem(SESSION_RECOVERY_KEY, JSON.stringify({ ...session(200, 0, 0), playback: { order: [] } }));
  assert.equal(readSessionRecovery(storage), null);
  storage.setItem(SESSION_RECOVERY_KEY, JSON.stringify(session(200, 9, 0)));
  assert.equal(readSessionRecovery(storage), null);
  assert.equal(newestSession(saved, session(99, 1, 0)), saved);
  assert.equal(newestSession(saved, session(100, 1, 0)), saved);
  assert.equal(newestSession(saved, session(101, 1, 0)).playback.cursor, 1);
});

test("a delayed initial output preserves edits to the matching saved curve", async () => {
  values.clear();
  const edited = { id: "band", kind: "peaking", freq: 1000, gain: 4, q: 1, enabled: true };
  const curve = { id: "curve", name: "Curve", source: "manual", bands: [{ ...edited, gain: 0 }],
    autoPreamp: false, preampDb: 0, limiter: false };
  let finishOutput;
  globalThis.isTauri = true;
  globalThis.__recoveryIpc.audioOutputs = () => new Promise((resolve) => { finishOutput = resolve; });
  try {
    const app = await boot(null, false, {
      eqPresets: [curve], eqActivePresetId: curve.id,
      eqBands: [edited], eqDeviceRules: { speaker: curve.id },
    });
    assert.equal(app.getState().settings.eqBands[0].gain, 4);
    finishOutput({ outputs: [{ id: "speaker", label: "Speaker" }], activeIds: ["speaker"], routeKnown: true });
    await tick();
    assert.equal(app.getState().settings.eqBands[0].gain, 4);
    assert.equal(app.eqStatus().origin?.kind, "device");
  } finally {
    delete globalThis.__recoveryIpc.audioOutputs;
    delete globalThis.isTauri;
  }
});

test("a delayed initial output applies a different device curve", async () => {
  values.clear();
  const band = { id: "band", kind: "peaking", freq: 1000, gain: 0, q: 1, enabled: true };
  const curve = { id: "curve", name: "Curve", source: "manual", bands: [band],
    autoPreamp: false, preampDb: 0, limiter: false };
  let finishOutput;
  globalThis.isTauri = true;
  globalThis.__recoveryIpc.audioOutputs = () => new Promise((resolve) => { finishOutput = resolve; });
  try {
    const app = await boot(null, false, {
      eqPresets: [curve], eqActivePresetId: null,
      eqBands: [{ ...band, gain: 4 }], eqDeviceRules: { speaker: curve.id },
    });
    finishOutput({ outputs: [{ id: "speaker", label: "Speaker" }], activeIds: ["speaker"], routeKnown: true });
    await tick();
    assert.equal(app.getState().settings.eqActivePresetId, curve.id);
    assert.equal(app.getState().settings.eqBands[0].gain, 0);
  } finally {
    delete globalThis.__recoveryIpc.audioOutputs;
    delete globalThis.isTauri;
  }
});
