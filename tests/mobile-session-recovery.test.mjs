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

async function boot(saved, resumeOnLaunch = true, settings = {}, playlists = []) {
  intervals.clear();
  timeouts.clear();
  doc.listeners.clear();
  win.listeners.clear();
  doc.hidden = false;
  setDevice("android");
  const app = await vite.ssrLoadModule(`/src/lib/state.ts?boot=${++bootNumber}`);
  backend = {
    settings: { ...clone(app.getState().settings), autoUpdate: false, resumeOnLaunch, ...settings },
    likes: [], playlists: clone(playlists), windowSlots: [], recentImports: [], artworkColours: {},
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
  try {
    const app = await boot(session(30, 1, 1000));
    app.player.play();
    audio.at(-1).currentTime = 17;
    const before = writes.length;
    checkpoint();
    await tick();
    assert.equal(writes.length, before + 1);
    assertPosition(backend.session.playback.positionMs, 17000);
  } finally {
    storageFails = false;
  }
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
    assert.ok(pending.positionMs >= 17000 && pending.positionMs < 17250);
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

const playlists = [
  { id: "first", name: "First", kind: "custom", entries: ["a", "b"], trackIds: ["a", "b"], pending: [], createdAt: 0 },
  { id: "second", name: "Second", kind: "custom", entries: ["b", "c"], trackIds: ["b", "c"], pending: [], createdAt: 0 },
];

function assertPosition(actual, expected) {
  assert.ok(actual >= expected && actual < expected + 100, `Expected ${expected}ms, got ${actual}ms`);
}

test("switching playlists restores the exact queue and position while retaining global controls", async () => {
  values.clear();
  const app = await boot(null, false, {}, playlists);
  assert.equal(app.getState().settings.resumeCollections, true);
  app.playCollection("first");
  app.player.insertAfterCurrent("c");
  app.player.moveTo("c");
  app.player.seek(42000);
  app.player.pause();
  const original = app.player.snapshot();

  app.playCollection("second");
  app.player.setRepeat("all");
  app.player.toggleMute();
  app.playCollection("first");
  const resumed = app.player.snapshot();
  assert.equal(resumed.currentId, "c");
  assert.equal(resumed.cursor, 1);
  assertPosition(resumed.positionMs, 42000);
  assert.deepEqual(resumed.order, original.order);
  assert.deepEqual(resumed.sourceOrder, original.sourceOrder);
  assert.equal(resumed.repeat, "all");
  assert.equal(resumed.muted, true);
  assert.equal(resumed.playing, true);

  const recovery = readSessionRecovery(storage);
  assertPosition(recovery.collectionPlayback.first.positionMs, 42000);
  assert.deepEqual(recovery.collectionPlayback.first.order, ["a", "c", "b"]);
});

test("playlist positions survive a restart independently of resume on launch", async () => {
  values.clear();
  const app = await boot(null, false, {}, playlists);
  app.playCollection("first");
  app.player.moveTo("b");
  app.player.seek(63000);
  app.player.pause();
  app.playCollection("second");
  await app.flushSession();
  const saved = clone(backend.session);
  assert.equal(saved.collectionPlayback.first.positionMs, 63000);

  values.clear();
  const restarted = await boot(saved, false, {}, playlists);
  assert.equal(restarted.player.snapshot().sourceId, "all");
  restarted.playCollection("first");
  assert.equal(restarted.player.currentId, "b");
  assertPosition(restarted.player.positionMs, 63000);
  assert.equal(restarted.player.snapshot().playing, true);
});

test("a shuffled playlist is captured before a direct queue replacement", async () => {
  values.clear();
  const app = await boot(null, false, {}, playlists);
  app.playCollection("first");
  app.player.setShuffle(true);
  app.player.moveTo("b");
  app.player.seek(27000);
  app.player.pause();
  const original = app.player.snapshot();

  app.player.setQueue("external", "External queue", ["c"]);
  app.playCollection("first");
  const resumed = app.player.snapshot();
  assert.equal(resumed.currentId, "b");
  assertPosition(resumed.positionMs, 27000);
  assert.equal(resumed.shuffle, true);
  assert.deepEqual(resumed.order, original.order);
  assert.deepEqual(resumed.sourceOrder, original.sourceOrder);
});

test("playlist snapshots survive an abrupt restart through mobile recovery", async () => {
  values.clear();
  const app = await boot(null, false, {}, playlists);
  app.playCollection("first");
  app.player.moveTo("b");
  app.player.seek(38000);
  app.player.pause();
  app.playCollection("second");
  assert.equal(backend.session, null);

  const restarted = await boot(null, false, {}, playlists);
  restarted.playCollection("first");
  assert.equal(restarted.player.currentId, "b");
  assertPosition(restarted.player.positionMs, 38000);
});

test("restoration keeps the exact cursor when a queue repeats a song", async () => {
  values.clear();
  const saved = session(100, 0, 0);
  saved.collectionPlayback = {
    first: {
      sourceId: "first", sourceName: "First", sourceOrder: ["a", "b", "a"],
      order: ["a", "b", "a"], cursor: 2, positionMs: 12000,
      shuffle: false, repeat: "off", muted: false,
    },
  };
  const app = await boot(saved, false, {}, playlists);
  app.playCollection("first");
  assert.equal(app.player.currentId, "a");
  assert.equal(app.player.snapshot().cursor, 2);
  assertPosition(app.player.positionMs, 12000);
});

test("shuffle, replaying the active playlist, and selecting a song start fresh", async () => {
  values.clear();
  const app = await boot(null, false, {}, playlists);
  app.playCollection("first");
  app.player.moveTo("b");
  app.player.seek(45000);
  app.player.pause();
  app.playCollection("second");

  app.shuffleCollection("first");
  assert.equal(app.player.snapshot().sourceId, "first");
  assertPosition(app.player.positionMs, 0);
  assert.equal(app.player.snapshot().shuffle, true);

  app.player.moveTo("b");
  app.player.seek(33000);
  app.playCollection("first");
  assert.equal(app.player.currentId, "a");
  assertPosition(app.player.positionMs, 0);

  app.player.moveTo("b");
  app.player.seek(24000);
  app.player.pause();
  app.playCollection("second");
  app.playFromCollection("first", "a");
  assert.equal(app.player.currentId, "a");
  assertPosition(app.player.positionMs, 0);
});

test("disabling playlist resume ignores saved positions", async () => {
  values.clear();
  const app = await boot(null, false, {}, playlists);
  app.playCollection("first");
  app.player.moveTo("b");
  app.player.seek(51000);
  app.player.pause();
  app.playCollection("second");
  app.getState().settings.resumeCollections = false;
  app.playCollection("first");
  assert.equal(app.player.currentId, "a");
  assertPosition(app.player.positionMs, 0);
});

test("restored playlists skip missing tracks without transferring their position", async () => {
  values.clear();
  const saved = session(100, 0, 0);
  saved.collectionPlayback = {
    first: {
      sourceId: "first", sourceName: "First", sourceOrder: ["a", "b", "c"],
      order: ["c", "b", "a"], cursor: 1, positionMs: 42000,
      shuffle: true, repeat: "off", muted: false,
    },
  };
  scannedTracks = tracks.filter((track) => track.id !== "b");
  try {
    const app = await boot(saved, false, {}, playlists);
    app.playCollection("first");
    assert.deepEqual(app.player.snapshot().order, ["c", "a"]);
    assert.equal(app.player.currentId, "c");
    assertPosition(app.player.positionMs, 0);
  } finally {
    scannedTracks = tracks;
  }
});

test("playlist resume retains temporarily missing queue entries until a scan succeeds", async () => {
  values.clear();
  const saved = session(100, 0, 0);
  saved.collectionPlayback = {
    first: {
      sourceId: "first", sourceName: "First", sourceOrder: ["a", "b", "c"],
      order: ["c", "b", "a"], cursor: 1, positionMs: 42000,
      shuffle: true, repeat: "off", muted: false,
    },
  };
  scannedTracks = tracks.filter((track) => track.id !== "c");
  scanErrors = ["Library unavailable"];
  try {
    const app = await boot(saved, false, {}, playlists);
    app.playCollection("first");
    assert.equal(app.player.currentId, "b");
    assertPosition(app.player.positionMs, 42000);
    assert.deepEqual(app.player.snapshot().order, ["b", "a"]);
    assert.deepEqual(readSessionRecovery(storage).collectionPlayback.first.order, ["c", "b", "a"]);

    app.player.seek(53000);
    scannedTracks = tracks;
    scanErrors = [];
    await app.rescan(true);
    assert.equal(app.player.currentId, "b");
    assertPosition(app.player.positionMs, 53000);
    assert.deepEqual(app.player.snapshot().order, ["c", "b", "a"]);
    assert.equal(app.player.snapshot().playing, true);
  } finally {
    scannedTracks = tracks;
    scanErrors = [];
  }
});

test("an unavailable current song does not erase a saved playlist during a failed scan", async () => {
  values.clear();
  const saved = session(100, 0, 0);
  saved.collectionPlayback = {
    first: {
      sourceId: "first", sourceName: "First", sourceOrder: ["a", "b"],
      order: ["a", "b"], cursor: 1, positionMs: 42000,
      shuffle: false, repeat: "off", muted: false,
    },
  };
  scannedTracks = tracks.filter((track) => track.id !== "b");
  scanErrors = ["Library unavailable"];
  try {
    const app = await boot(saved, false, {}, playlists);
    app.playCollection("first");
    assert.equal(app.player.snapshot().sourceId, "all");
    assert.match(app.getState().notice, /unavailable/);
    await app.flushSession();
    assert.equal(backend.session.collectionPlayback.first.positionMs, 42000);

    scannedTracks = tracks;
    scanErrors = [];
    await app.rescan(true);
    app.playCollection("first");
    assert.equal(app.player.currentId, "b");
    assertPosition(app.player.positionMs, 42000);
  } finally {
    scannedTracks = tracks;
    scanErrors = [];
  }
});

test("recovery validates saved playlist queues without rejecting older sessions", () => {
  values.clear();
  const saved = session(200, 0, 0);
  storage.setItem(SESSION_RECOVERY_KEY, JSON.stringify(saved));
  assert.ok(readSessionRecovery(storage));
  saved.collectionPlayback = { first: { ...saved.playback, cursor: 99 } };
  storage.setItem(SESSION_RECOVERY_KEY, JSON.stringify(saved));
  assert.equal(readSessionRecovery(storage), null);
});

test("legacy output rules do not replace the restored equaliser curve", async () => {
  values.clear();
  const edited = { id: "band", kind: "peaking", freq: 1000, gain: 4, q: 1, enabled: true };
  const curve = { id: "curve", name: "Curve", source: "manual", bands: [{ ...edited, gain: 0 }],
    autoPreamp: false, preampDb: 0, limiter: false };
  const app = await boot(null, false, {
    eqPresets: [curve], eqActivePresetId: null,
    eqBands: [edited], eqDeviceRules: { speaker: curve.id }, eqOutputId: "speaker",
  });
  win.dispatch("wave:audio-outputs-changed");
  await tick();
  assert.equal(app.getState().settings.eqActivePresetId, null);
  assert.equal(app.getState().settings.eqBands[0].gain, 4);
  assert.equal(app.eqStatus().origin, null);
});

test("restoring a playback-context curve preserves edits only when the preset matches", async () => {
  const edited = { id: "band", kind: "peaking", freq: 1000, gain: 4, q: 1, enabled: true };
  const curve = { id: "curve", name: "Curve", source: "manual", bands: [{ ...edited, gain: 0 }],
    autoPreamp: false, preampDb: 0, limiter: false };
  for (const active of [curve.id, null]) {
    values.clear();
    const app = await boot(session(100, 1, 1000), true, {
      eqPresets: [curve], eqActivePresetId: active, eqBands: [edited],
      eqContextRules: [{ kind: "playlist", value: "all", presetId: curve.id }],
    });
    assert.equal(app.getState().settings.eqActivePresetId, curve.id);
    assert.equal(app.getState().settings.eqBands[0].gain, active ? 4 : 0);
  }
});
