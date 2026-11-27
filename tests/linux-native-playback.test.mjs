import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const listeners = new Map();
const clone = (value) => structuredClone(value);
const tick = () => new Promise((resolve) => setImmediate(resolve));
let timer = 0;
let backend;
let nativeStatus = {
  active: false,
  reason: null,
  report: {
    command: null, currentId: null, sourceId: null, sourceName: "", order: [], sourceOrder: [],
    cursor: 0, positionMs: 0, durationMs: 0, playing: false, shuffle: false, repeat: "off",
    volume: 70, muted: false,
  },
  revision: 0,
};
const syncs = [];
const commands = [];
let holdNativeSync = false;
let failNextNativeSync = false;
let releaseHeldSync = null;

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: "Linux WebKit" },
});
globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
globalThis.Audio = class {
  paused = true;
  ended = false;
  seeking = false;
  readyState = 1;
  currentTime = 0;
  duration = 120;
  src = "";
  addEventListener() {}
  removeEventListener() {}
  removeAttribute() { this.src = ""; }
  load() {}
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
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
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { search: "" },
};
globalThis.requestAnimationFrame = () => ++timer;
globalThis.__linuxNativeListeners = listeners;

const ipcFile = await readFile(new URL("../src/lib/ipc.ts", import.meta.url), "utf8");
const ipcNames = [...ipcFile.matchAll(/export (?:async )?function (\w+)\(/g)].map((match) => match[1]);
const tracks = ["one", "two", "three"].map((id) => ({
  id, path: `/music/${id}.flac`, title: id, artist: "Artist", album: "Album", durationMs: 120000,
  albumArtist: "Album Artist", genre: "Podcast", year: 2024, codec: "flac", relativePath: `${id}.flac`,
  artworkPath: null, lufs: null, peak: null,
}));

globalThis.__linuxNativeIpc = new Proxy({
  loadState: async () => clone(backend),
  audioStreamBase: async () => "http://127.0.0.1:1234",
  scanLibrary: async () => ({ changed: clone(tracks), removed: [], root: "", skipped: 0, errors: [] }),
  libraryInfo: async () => ({ tracks: tracks.length }),
  analyticsPlayCounts: async () => ({}),
  linuxNativePlaybackState: async () => clone(nativeStatus),
  linuxNativePlaybackSync: async (sync) => {
    syncs.push(clone(sync));
    const apply = () => {
      if (failNextNativeSync) {
        failNextNativeSync = false;
        throw new Error("native activation failed");
      }
      const active = !sync.equaliserEnabled && !sync.outputId && sync.report.currentId !== null;
      nativeStatus = {
        active,
        reason: active ? null : "WebKit fallback requested",
        report: clone(sync.report),
        revision: nativeStatus.revision + 1,
      };
      return clone(nativeStatus);
    };
    if (!holdNativeSync) return apply();
    holdNativeSync = false;
    return new Promise((resolve, reject) => {
      releaseHeldSync = () => {
        try {
          resolve(apply());
        } catch (error) {
          reject(error);
        }
      };
    });
  },
  linuxNativePlaybackCommand: async (command) => {
    commands.push(clone(command));
    if (command.action === "seek") nativeStatus.report.positionMs = command.value;
    if (command.action === "pause") nativeStatus.report.playing = false;
    if (command.action === "play") nativeStatus.report.playing = true;
    nativeStatus.revision += 1;
    return clone(nativeStatus);
  },
}, { get: (target, name) => target[name] ?? (async () => null) });

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  ssr: { noExternal: ["@tauri-apps/api"] },
  plugins: [{
    name: "linux-native-playback-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "@tauri-apps/api/event") return "\0linux-native-events";
      if (source === "@tauri-apps/api/app") return "\0linux-native-app";
      if (source === "@tauri-apps/api/core") return "\0linux-native-core";
      if (source === "./ipc" && /[\\/]src[\\/]lib[\\/]/.test(importer ?? "")) return "\0linux-native-ipc";
      if (source === "./analytics" && /[\\/]state\.ts$/.test(importer ?? "")) return "\0linux-native-analytics";
      if (source === "./audio-watchdog" && /[\\/]state\.ts$/.test(importer ?? "")) return "\0linux-native-watchdog";
    },
    load(id) {
      if (id === "\0linux-native-events") {
        return "export const listen = async (name, callback) => { globalThis.__linuxNativeListeners.set(name, callback); return () => globalThis.__linuxNativeListeners.delete(name); };";
      }
      if (id === "\0linux-native-app") return "export const getVersion = async () => 'test';";
      if (id === "\0linux-native-core") return "export const isTauri = () => true; export const convertFileSrc = (path) => path;";
      if (id === "\0linux-native-ipc") {
        return ipcNames.map((name) => `export const ${name} = (...args) => globalThis.__linuxNativeIpc.${name}(...args);`).join("\n");
      }
      if (id === "\0linux-native-analytics") {
        return "export const flushAnalytics = async () => {}; export const handoffPlaybackToNative = () => {}; export const mediaTypeOf = (track) => /\\.m4b$/i.test(track.relativePath || track.path) || /audiobook/i.test(track.genre || '') ? 'audiobook' : /podcast|spoken word/i.test(track.genre || '') ? 'podcast' : 'music'; export const mountAnalytics = () => {}; export const notePlaybackError = () => {}; export const noteTrackEnded = () => {}; export const reclaimPlaybackOwnership = () => {}; export const recordEvent = () => {}; export const rememberTracks = () => {};";
      }
      if (id === "\0linux-native-watchdog") return "export const mountAudioWatchdog = () => {};";
    },
  }],
});
after(() => vite.close());

const app = await vite.ssrLoadModule("/src/lib/state.ts");
backend = {
  settings: { ...clone(app.getState().settings), autoUpdate: false },
  likes: [], playlists: [], windowSlots: [], recentImports: [], artworkColours: {},
};

test("Linux native playback owns compatible queues without full queue syncs for seeks", async () => {
  await app.init();
  await tick();
  await tick();

  assert.equal(syncs.length, 1);
  assert.equal(syncs[0].replace, false);
  assert.equal(syncs[0].tracks.length, tracks.length);
  const { colour, ...firstNativeTrack } = syncs[0].tracks[0];
  assert.deepEqual(firstNativeTrack, {
    id: "one",
    path: "/music/one.flac",
    title: "one",
    artist: "Artist",
    album: "Album",
    albumArtist: "Album Artist",
    genre: "Podcast",
    year: 2024,
    durationMs: 120000,
    codec: "flac",
    mediaType: "podcast",
    artwork: "",
    gain: 1,
  });
  assert.match(colour, /^#[0-9a-f]{6}$/i);
  assert.equal(app.usesNativePlayback(), true);

  app.player.setQueue("queue", "Queue", ["one", "two"]);
  await tick();
  assert.equal(syncs.length, 2);
  assert.equal(syncs.at(-1).replace, true);
  assert.deepEqual(syncs.at(-1).report.order, ["one", "two"]);

  app.player.seek(5000);
  await tick();
  assert.equal(syncs.length, 2);
  assert.equal(commands.at(-1).action, "seek");
  assert.equal(commands.at(-1).value, 5000);

  const nextId = app.player.snapshot().order[1];
  nativeStatus = {
    ...nativeStatus,
    report: {
      ...nativeStatus.report,
      currentId: nextId,
      cursor: 1,
      positionMs: 0,
      playing: true,
    },
    revision: nativeStatus.revision + 1,
  };
  listeners.get("linux-native-playback-state")({ payload: clone(nativeStatus) });
  await tick();
  assert.equal(app.player.snapshot().currentId, nextId);
  assert.equal(syncs.length, 2);

  nativeStatus = {
    ...nativeStatus,
    report: {
      ...nativeStatus.report,
      order: ["three", nextId],
      sourceOrder: ["three", nextId],
      currentId: nextId,
      cursor: 1,
    },
    transition: { kind: "queue", previousTrackId: nextId, currentTrackId: nextId },
    revision: nativeStatus.revision + 1,
  };
  listeners.get("linux-native-playback-state")({ payload: clone(nativeStatus) });
  await tick();
  assert.deepEqual(app.player.snapshot().order, ["three", nextId]);
  assert.deepEqual(app.player.snapshot().sourceOrder, ["three", nextId]);
  assert.equal(syncs.length, 2);

  const queueRevision = app.player.snapshot().queueRevision;
  listeners.get("linux-native-playback-state")({ payload: clone(nativeStatus) });
  await tick();
  assert.equal(app.player.snapshot().queueRevision, queueRevision);
  assert.equal(syncs.length, 2);

  const commandCount = commands.length;
  app.player.pause();
  app.player.play();
  await tick();
  await tick();
  await tick();
  assert.deepEqual(commands.slice(commandCount).map((command) => command.action), ["pause", "play"]);

  nativeStatus = {
    ...nativeStatus,
    report: { ...nativeStatus.report, positionMs: 43210, playing: true },
    revision: nativeStatus.revision + 1,
  };
  listeners.get("linux-native-playback-state")({ payload: clone(nativeStatus) });
  await tick();

  app.setEqEnabled(true);
  await tick();
  await tick();
  assert.equal(syncs.length, 3);
  assert.equal(syncs.at(-1).equaliserEnabled, true);
  assert.equal(app.usesNativePlayback(), false);
  assert.ok(Math.abs(app.player.snapshot().positionMs - 43210) < 100);

  holdNativeSync = true;
  app.setEqEnabled(false);
  await tick();
  assert.ok(releaseHeldSync);
  const fallbackElement = app.player.engine.element;
  app.player.pause();
  app.player.play();
  app.player.seek(60000);
  assert.equal(fallbackElement.paused, true);
  releaseHeldSync();
  await tick();
  await tick();
  await tick();
  await tick();
  assert.equal(app.usesNativePlayback(), true);
  assert.equal(app.player.snapshot().currentId, "two");
  assert.deepEqual(app.player.snapshot().order, ["three", "two"]);
  assert.equal(app.player.snapshot().playing, true);
  assert.ok(commands.some((command) => command.action === "seek" && command.value === 60000));

  app.setEqEnabled(true);
  await tick();
  await tick();
  assert.equal(app.usesNativePlayback(), false);
  assert.ok(Math.abs(app.player.snapshot().positionMs - 60000) < 100);

  holdNativeSync = true;
  app.setEqEnabled(false);
  await tick();
  assert.ok(releaseHeldSync);
  const queueFallbackElement = app.player.engine.element;
  app.player.pause();
  app.player.play();
  app.player.setQueue("queue", "Queue", ["one", "three"]);
  assert.equal(queueFallbackElement.paused, true);
  releaseHeldSync();
  await tick();
  await tick();
  await tick();
  await tick();
  assert.equal(app.usesNativePlayback(), true);
  assert.equal(app.player.snapshot().currentId, "one");
  assert.deepEqual(app.player.snapshot().order, ["one", "three"]);
  assert.equal(app.player.snapshot().playing, true);
  assert.ok(syncs.some((sync) => sync.replace && sync.report.order.join(",") === "one,three"));

  app.setEqEnabled(true);
  await tick();
  await tick();
  assert.equal(app.usesNativePlayback(), false);
  failNextNativeSync = true;
  app.setEqEnabled(false);
  await tick();
  await tick();
  assert.equal(app.usesNativePlayback(), false);
  assert.ok(Math.abs(app.player.snapshot().positionMs - 60000) < 100);
  assert.equal(app.getState().notice, "Native playback returned to WebKit: native activation failed");

  const failedSyncs = syncs.length;
  app.player.setQueue("queue", "Queue", ["three", "one"]);
  await tick();
  await tick();
  assert.equal(app.usesNativePlayback(), true);
  assert.equal(app.player.snapshot().currentId, "three");
  assert.ok(syncs.length > failedSyncs);
});

test("native queue removal clears and can restore the visible queue", async () => {
  const syncCount = syncs.length;
  nativeStatus = {
    ...nativeStatus,
    report: {
      ...nativeStatus.report,
      currentId: null,
      order: [],
      sourceOrder: [],
      cursor: 0,
      positionMs: 0,
      durationMs: 0,
      playing: false,
    },
    transition: { kind: "queueRemove", previousTrackId: "three", currentTrackId: null },
    revision: nativeStatus.revision + 1,
  };
  listeners.get("linux-native-playback-state")({ payload: clone(nativeStatus) });
  await tick();
  assert.deepEqual(app.player.snapshot().order, []);
  assert.equal(app.player.snapshot().currentId, null);
  assert.equal(app.player.snapshot().playing, false);
  assert.equal(syncs.length, syncCount);

  nativeStatus = {
    ...nativeStatus,
    report: {
      ...nativeStatus.report,
      currentId: "one",
      order: ["one"],
      sourceOrder: ["one"],
      durationMs: 120000,
      playing: true,
    },
    transition: { kind: "queue", previousTrackId: null, currentTrackId: "one" },
    revision: nativeStatus.revision + 1,
  };
  listeners.get("linux-native-playback-state")({ payload: clone(nativeStatus) });
  await tick();
  assert.deepEqual(app.player.snapshot().order, ["one"]);
  assert.equal(app.player.snapshot().currentId, "one");
  assert.equal(app.player.snapshot().playing, true);
  assert.equal(syncs.length, syncCount);
});

test("native connection keeps a newer event when the initial state reply is stale", async () => {
  const { LinuxNativeAudioEngine } = await vite.ssrLoadModule("/src/lib/linux-native-audio.ts");
  const originalListener = listeners.get("linux-native-playback-state");
  const originalState = globalThis.__linuxNativeIpc.linuxNativePlaybackState;
  let reply;
  globalThis.__linuxNativeIpc.linuxNativePlaybackState = () => new Promise((resolve) => { reply = resolve; });
  try {
    const engine = new LinuxNativeAudioEngine();
    const connected = engine.connect();
    await tick();
    const newer = { ...clone(nativeStatus), revision: 100, active: true };
    listeners.get("linux-native-playback-state")({ payload: newer });
    reply({ ...clone(nativeStatus), revision: 99, active: false });
    assert.deepEqual(await connected, newer);
    assert.equal(engine.active, true);
  } finally {
    globalThis.__linuxNativeIpc.linuxNativePlaybackState = originalState;
    listeners.set("linux-native-playback-state", originalListener);
  }
});
