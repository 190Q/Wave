import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const context = {};
globalThis.__mediaControlTest = context;

const mocks = {
  "@tauri-apps/api/core": "export const isTauri = () => globalThis.__mediaControlTest.tauri;",
  "@tauri-apps/api/event": `
    export const listen = async (event, callback) => {
      if (event === "api-command") globalThis.__mediaControlTest.apiControl = callback;
      else globalThis.__mediaControlTest.control = callback;
      return () => {};
    };
  `,
  "@tauri-apps/api/window": `
    export const getCurrentWindow = () => ({
      unminimize: async () => {
        const context = globalThis.__mediaControlTest;
        context.windowActions.push("unminimize");
        if (context.failUnminimize) throw new Error("unavailable");
      },
      setFocus: async () => globalThis.__mediaControlTest.windowActions.push("focus"),
    });
  `,
  "./device": "export const isAndroidPlatform = false; export const isWebKitGtk = false;",
  "android-device": "export const isAndroidPlatform = true; export const isWebKitGtk = false;",
  "webkit-device": "export const isAndroidPlatform = false; export const isWebKitGtk = true;",
  "./ipc": `
    export const setNowPlaying = (song) => {
      const context = globalThis.__mediaControlTest;
      context.songs.push(song);
      return context.sendSong ? context.sendSong(song) : Promise.resolve();
    };
    export const setQueue = async (queue) => globalThis.__mediaControlTest.queues.push(queue);
    export const showMainWindow = async () => globalThis.__mediaControlTest.windowActions.push("show");
    export const reportApiState = async (report) => globalThis.__mediaControlTest.reports.push(report);
    export const reportPlaybackActivity = (playing) => {
      const context = globalThis.__mediaControlTest;
      context.playbackActivity.push(playing);
      return context.sendPlayback ? context.sendPlayback(playing) : Promise.resolve();
    };
  `,
  "./state": `
    const context = globalThis.__mediaControlTest;
    export const player = new Proxy({}, {
      get(_target, key) {
        const value = context.player[key];
        return typeof value === "function" ? value.bind(context.player) : value;
      }
    });
    export const getState = () => ({ settings: context.settings, ready: true });
    export const usesNativePlayback = () => context.nativePlayback;
    export const syncNativeQueue = () => { context.nativeQueueUpdates++; };
    export const currentTrack = () => trackById(context.player.currentId);
    export const trackById = (id) => id ? { id, title: id, durationMs: 120000 } : undefined;
    export const colourFor = () => "#123456";
    export const setVolume = (value) => context.player.setVolume(value);
    export const stepTrack = (direction) => direction > 0 ? context.player.next() : context.player.previous();
    export const subscribe = (listener) => context.subscribers.push(listener);
    export const collectionById = () => undefined;
    export const openCollection = () => {};
    export const playCollection = () => {};
    export const playTrackInContext = () => {};
  `,
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  ssr: { noExternal: ["@tauri-apps/api"] },
  plugins: [{
    name: "media-control-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !source || !(source in mocks)) return;
      if (source === "./device" && /(player|presence)\.ts\?android/.test(importer)) {
        return "\0media-control-test:android-device";
      }
      if (source === "./device" && /presence\.ts\?webkit/.test(importer)) {
        return "\0media-control-test:webkit-device";
      }
      if (/[\\/]src[\\/]lib[\\/](api|presence|player)\.ts/.test(importer)) {
        return `\0media-control-test:${source}`;
      }
    },
    load(id) {
      if (id.startsWith("\0media-control-test:")) return mocks[id.slice("\0media-control-test:".length)];
    },
  }],
});
after(() => vite.close());

const { AudioEngine } = await vite.ssrLoadModule("/src/lib/audio.ts");
const { Player } = await vite.ssrLoadModule("/src/lib/player.ts");
const { Player: AndroidPlayer } = await vite.ssrLoadModule("/src/lib/player.ts?android");
const { mountPresence } = await vite.ssrLoadModule("/src/lib/presence.ts");
const { mountPresence: mountAndroidPresence } = await vite.ssrLoadModule("/src/lib/presence.ts?android");
const { mountPresence: mountWebKitPresence } = await vite.ssrLoadModule("/src/lib/presence.ts?webkit");
const { mountApi } = await vite.ssrLoadModule("/src/lib/api.ts");

class FakeAudio {
  constructor() {
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = 120;
    this.readyState = 1;
    this.src = "";
    this.listeners = new Map();
    context.elements.push(this);
  }

  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name) { this.listeners.delete(name); }
  emit(name) { this.listeners.get(name)?.(); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute(name) { if (name === "src") this.src = ""; }
  load() {}
}

function setup(PlayerClass = Player, mount = mountPresence, controls = true, sendSong = null, bridge = false, tauri = true, native = false) {
  context.elements = [];
  context.frames = new Map();
  context.nextFrame = 1;
  context.intervals = new Map();
  context.nextInterval = 1;
  context.timeouts = new Map();
  context.nextTimeout = 1;
  context.control = null;
  context.apiControl = null;
  context.androidControl = null;
  context.songs = [];
  context.sendSong = sendSong;
  context.queues = [];
  context.reports = [];
  context.playbackActivity = [];
  context.windowActions = [];
  context.failUnminimize = false;
  context.sendPlayback = null;
  context.subscribers = [];
  context.bridgeMessages = [];
  context.ackBridge = true;
  context.tauri = tauri;
  context.nativePlayback = native;
  context.nativeQueueUpdates = 0;
  context.mediaActions = new Map();
  context.settings = { systemMediaControls: controls, discordPresence: false, localApiEnabled: true };

  const listeners = new Map();
  globalThis.document = {
    hidden: false,
    addEventListener(name, listener) {
      const entries = listeners.get(name) ?? [];
      entries.push(listener);
      listeners.set(name, entries);
    },
    dispatch(name) {
      for (const listener of listeners.get(name) ?? []) listener();
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaSession: { setActionHandler: (action, handler) => context.mediaActions.set(action, handler) } },
  });
  globalThis.MediaMetadata = class {
    constructor(metadata) { Object.assign(this, metadata); }
  };
  globalThis.window = {
    cancelAnimationFrame: (id) => context.frames.delete(id),
    setInterval: (callback) => {
      const id = context.nextInterval++;
      context.intervals.set(id, callback);
      return id;
    },
    clearInterval: (id) => context.intervals.delete(id),
    setTimeout: (callback) => {
      const id = context.nextTimeout++;
      context.timeouts.set(id, callback);
      return id;
    },
    clearTimeout: (id) => context.timeouts.delete(id),
    addEventListener: (name, callback) => {
      if (name === "wave:media-control") context.androidControl = callback;
    },
  };
  if (bridge) {
    window.wavePlayback = {
      onmessage: null,
      postMessage(message) {
        const update = JSON.parse(message);
        context.bridgeMessages.push(update);
        if (context.ackBridge && update.type === "song" && update.revision !== undefined) {
          this.onmessage?.({ data: String(update.revision) });
        }
      },
    };
  }
  globalThis.requestAnimationFrame = (callback) => {
    const id = context.nextFrame++;
    context.frames.set(id, callback);
    return id;
  };
  globalThis.Audio = FakeAudio;
  globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };

  let player;
  const engine = new AudioEngine({
    onEnded: () => player.handleEnded(),
    onPause: () => player.handlePaused(),
    onPlaying: () => player.handlePlaying(),
  });
  player = new PlayerClass(engine, (id) => ({
    path: `http://127.0.0.1:1234/${id}`,
    durationMs: 120000,
    gain: 1,
  }));
  context.player = player;
  mount();
  player.setQueue("queue", "Queue", ["one", "two", "three"]);
  player.play();
  player.finishTransitions();
  return { engine, player };
}

function press(action, value) {
  context.control({ payload: { action, value } });
}

function tickIntervals() {
  for (const callback of [...context.intervals.values()]) callback();
}

function tickTimeouts() {
  for (const [id, callback] of [...context.timeouts]) {
    if (context.timeouts.delete(id)) callback();
  }
}

function finishFrames() {
  const frames = [...context.frames.entries()];
  for (const [id, callback] of frames) {
    if (context.frames.delete(id)) callback(performance.now() + 400);
  }
}

test("native playback does not duplicate WebView media session updates", async () => {
  const { player } = setup(AndroidPlayer, mountAndroidPresence, true, null, true, true, true);
  player.pause();
  finishFrames();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(context.nativeQueueUpdates > 0);
  assert.deepEqual(context.bridgeMessages, []);
  assert.deepEqual(context.songs, []);
  assert.deepEqual(context.queues, []);
});

test("a stale native checkpoint cannot cancel a pending pause", () => {
  const { engine, player } = setup(AndroidPlayer, mountAndroidPresence);
  player.pause();
  player.followNative("one", true);
  assert.equal(player.snapshot().playing, false);
  finishFrames();
  assert.equal(engine.element.paused, true);
  player.followNative("one", false);
  player.followNative("two", true);
  assert.equal(player.currentId, "two");
  assert.equal(player.snapshot().playing, true);
});

test("restoring a live native player does not load its track again", () => {
  const { engine, player } = setup(AndroidPlayer, mountAndroidPresence);
  const source = engine.element.src;
  const snapshot = player.snapshot();
  player.restore({
    sourceId: snapshot.sourceId,
    sourceName: snapshot.sourceName,
    sourceOrder: [...snapshot.sourceOrder],
    order: [...snapshot.order],
    cursor: 1,
    positionMs: 2000,
    shuffle: false,
    repeat: "off",
    muted: false,
  }, { playing: true });
  assert.equal(player.currentId, "two");
  assert.equal(player.snapshot().playing, true);
  assert.equal(engine.element.src, source);
});

test("desktop media controls restore the window before focusing it", async () => {
  setup();
  press("raise");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(context.windowActions, ["show", "unminimize", "focus"]);
  const capability = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"));
  assert.ok(capability.permissions.includes("core:window:allow-unminimize"));
  assert.ok(capability.permissions.includes("core:window:allow-set-focus"));
});

test("Android media controls do not call the desktop unminimize API", async () => {
  setup(AndroidPlayer, mountAndroidPresence, false);
  context.androidControl({ detail: { action: "raise" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(context.windowActions, ["show", "focus"]);
});

test("desktop media controls still focus if unminimizing fails", async () => {
  setup();
  context.failUnminimize = true;
  press("raise");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(context.windowActions, ["show", "unminimize", "focus"]);
});

test("Android forwards play, pause and queue updates with both optional surfaces disabled", async () => {
  const { player } = setup(AndroidPlayer, mountAndroidPresence, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(context.songs.some((song) => song?.playing === true));
  assert.equal(context.queues.at(-1).length, 3);
  player.pause();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.songs.at(-1).playing, false);
  player.next();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.songs.at(-1).title, "two");
  assert.equal(context.songs.at(-1).playing, true);
});

test("Android handles direct media controls without waiting for the Tauri event bridge", () => {
  const { engine, player } = setup(AndroidPlayer, mountAndroidPresence, false);
  context.androidControl({ detail: { action: "pause" } });
  assert.equal(engine.element.paused, false);
  finishFrames();
  assert.equal(engine.element.paused, true);
  context.androidControl({ detail: { action: "play" } });
  assert.equal(engine.element.paused, false);
  assert.equal(engine.element.volume, 0);
  finishFrames();
  assert.ok(engine.element.volume > 0);
  context.androidControl({ detail: { action: "seekTo", value: 25000 } });
  assert.equal(engine.positionMs, 25000);
  context.androidControl({ detail: { action: "next" } });
  assert.equal(player.currentId, "two");
  assert.equal(engine.element.paused, false);
  assert.equal(engine.element.volume, 0);
  finishFrames();
  assert.ok(engine.element.volume > 0);
});

test("Android media controls stop at the interrupted position and resume without replacing the audio", () => {
  const { engine, player } = setup(AndroidPlayer, mountAndroidPresence, false, null, true);
  const audio = engine.element;
  audio.currentTime = 42;
  document.hidden = true;
  document.dispatch("visibilitychange");
  audio.paused = true;
  audio.emit("pause");
  let songs = context.bridgeMessages.filter((message) => message.type === "song");
  assert.equal(songs.at(-1).song.playing, false);
  assert.equal(songs.at(-1).song.positionMs, 42000);
  assert.equal(context.intervals.size, 0);
  assert.equal(audio.volume, 1);

  audio.paused = false;
  assert.equal(audio.volume, 1);
  audio.emit("playing");
  songs = context.bridgeMessages.filter((message) => message.type === "song");
  assert.equal(songs.at(-1).song.playing, true);
  assert.equal(songs.at(-1).song.positionMs, 42000);
  assert.equal(engine.element, audio);
  assert.equal(audio.volume, 1);
  assert.equal(player.snapshot().playing, true);
});

test("Android retries the latest unacknowledged song after a background track change", () => {
  const { engine, player } = setup(AndroidPlayer, mountAndroidPresence, false, null, true);
  document.hidden = true;
  document.dispatch("visibilitychange");
  context.ackBridge = false;

  engine.element.ended = true;
  engine.element.emit("ended");
  assert.equal(player.currentId, "two");
  const second = context.bridgeMessages.filter((message) => message.type === "song").at(-1);
  assert.equal(second.song.title, "two");
  assert.equal(context.timeouts.size, 1);

  player.next();
  player.pause();
  const paused = context.bridgeMessages.filter((message) => message.type === "song").at(-1);
  assert.equal(paused.song.title, "three");
  assert.equal(paused.song.playing, false);

  window.wavePlayback.onmessage({ data: String(second.revision) });
  assert.equal(context.timeouts.size, 1);
  context.ackBridge = true;
  tickTimeouts();
  const retried = context.bridgeMessages.filter((message) => message.type === "song").at(-1);
  assert.equal(retried.song.title, "three");
  assert.equal(retried.song.playing, false);
  assert.equal(context.timeouts.size, 0);
});

test("Android retries a missed clear until it is acknowledged", () => {
  const { player } = setup(AndroidPlayer, mountAndroidPresence, false, null, true);
  context.ackBridge = false;
  player.setQueue("empty", "Empty", []);
  const clear = context.bridgeMessages.filter((message) => message.type === "song").at(-1);
  assert.equal(clear.song, null);
  assert.equal(context.timeouts.size, 1);
  tickTimeouts();
  const retried = context.bridgeMessages.filter((message) => message.type === "song").at(-1);
  assert.equal(retried.song, null);
  assert.equal(context.timeouts.size, 1);
  window.wavePlayback.onmessage({ data: String(retried.revision) });
  assert.equal(context.timeouts.size, 0);
});

test("Android falls back to Tauri when the direct bridge fails", async () => {
  const { player } = setup(AndroidPlayer, mountAndroidPresence, false, null, true);
  context.ackBridge = false;
  player.next();
  assert.equal(context.timeouts.size, 1);
  window.wavePlayback.postMessage = () => { throw new Error("bridge unavailable"); };
  player.next();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.songs.at(-1).title, "three");
  assert.equal(context.timeouts.size, 0);
});

test("Android updates the media session without waiting for Tauri acknowledgements", () => {
  const { player } = setup(AndroidPlayer, mountAndroidPresence, false, null, true);
  assert.ok(context.bridgeMessages.some((message) => message.type === "queue" && message.tracks.length === 3));
  context.androidControl({ detail: { action: "pause" } });
  context.androidControl({ detail: { action: "play" } });
  const songs = context.bridgeMessages.filter((message) => message.type === "song").map((message) => message.song);
  assert.equal(songs.at(-2).playing, false);
  assert.equal(songs.at(-1).playing, true);
  assert.deepEqual(context.songs, []);
  assert.deepEqual(context.queues, []);
  assert.equal(player.snapshot().playing, true);
});

test("delayed playback updates cannot overtake a pause", async () => {
  const requests = [];
  const { player } = setup(AndroidPlayer, mountAndroidPresence, false, () => new Promise((resolve, reject) => {
    requests.push({ resolve, reject });
  }));
  assert.equal(context.songs.length, 1);
  requests[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.songs.at(-1).playing, true);

  player.seek(30000);
  player.pause();
  assert.equal(context.songs.length, 2);
  requests[1].reject(new Error("temporary IPC failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.songs.length, 3);
  assert.equal(context.songs.at(-1).playing, false);
  assert.equal(context.songs.at(-1).positionMs, 30000);
  requests[2].resolve();
  await new Promise((resolve) => setImmediate(resolve));
});

test("a failed pause update is retried while playback remains paused", async () => {
  let failPause = false;
  const { player } = setup(AndroidPlayer, mountAndroidPresence, false, (song) => {
    if (failPause && song?.playing === false) {
      failPause = false;
      return Promise.reject(new Error("temporary IPC failure"));
    }
    return Promise.resolve();
  });
  await new Promise((resolve) => setImmediate(resolve));
  failPause = true;
  player.pause();
  await new Promise((resolve) => setImmediate(resolve));
  const count = context.songs.length;
  assert.equal(context.songs.at(-1).playing, false);
  player.handleLoaded();
  assert.equal(context.songs.length, count);
  tickIntervals();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.songs.length, count + 1);
  assert.equal(context.songs.at(-1).playing, false);
});

test("a failed clear is retried until acknowledged", async () => {
  let failClear = true;
  const { player } = setup(AndroidPlayer, mountAndroidPresence, false, (song) => {
    if (song === null && failClear) {
      failClear = false;
      return Promise.reject(new Error("temporary IPC failure"));
    }
    return Promise.resolve();
  });
  await new Promise((resolve) => setImmediate(resolve));
  player.setQueue("empty", "Empty", []);
  await new Promise((resolve) => setImmediate(resolve));
  const count = context.songs.length;
  assert.equal(context.songs.at(-1), null);
  tickIntervals();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.songs.length, count + 1);
  assert.equal(context.songs.at(-1), null);
  assert.equal(context.intervals.size, 0);
  tickIntervals();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.songs.length, count + 1);
});

test("a newer playing state supersedes a failed clear", async () => {
  let rejectClear;
  const { player } = setup(AndroidPlayer, mountAndroidPresence, false, (song) => {
    if (song === null) {
      return new Promise((_resolve, reject) => { rejectClear = reject; });
    }
    return Promise.resolve();
  });
  await new Promise((resolve) => setImmediate(resolve));
  player.setQueue("empty", "Empty", []);
  player.setQueue("new", "New", ["two"]);
  player.play();
  rejectClear(new Error("temporary IPC failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.songs.at(-1).title, "two");
  assert.equal(context.songs.at(-1).playing, true);
  const count = context.songs.length;
  tickIntervals();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.songs.length, count);
});

test("desktop does not send presence when both surfaces are disabled", () => {
  setup(Player, mountPresence, false);
  assert.deepEqual(context.songs, []);
  assert.deepEqual(context.queues, []);
  assert.equal(context.intervals.size, 0);
});

test("presence polling stops when paused and seeks are reported immediately", () => {
  const { player } = setup(AndroidPlayer, mountAndroidPresence, false, null, true);
  assert.equal(context.intervals.size, 1);
  player.pause();
  assert.equal(context.intervals.size, 0);
  player.seek(30000);
  const songs = context.bridgeMessages.filter((message) => message.type === "song");
  assert.equal(songs.at(-1).song.positionMs, 30000);
  assert.equal(songs.at(-1).song.playing, false);
  assert.equal(context.intervals.size, 0);
  player.play();
  assert.equal(context.intervals.size, 1);
});

test("API position polling stops when paused and seeks are reported immediately", () => {
  const { player } = setup(Player, mountApi);
  assert.equal(context.intervals.size, 1);
  assert.ok(context.reports.some((report) => report.order?.length === 3));
  tickIntervals();
  assert.equal(context.reports.at(-1).playing, true);
  assert.equal(context.reports.at(-1).order, undefined);

  player.pause();
  assert.equal(context.intervals.size, 0);
  player.seek(30000);
  assert.equal(context.reports.at(-1).positionMs, 30000);
  assert.equal(context.reports.at(-1).playing, false);
  context.apiControl({ payload: { id: "seek-1", action: "seek", value: 45000 } });
  assert.equal(context.reports.at(-1).command, "seek-1");
  assert.equal(context.reports.at(-1).positionMs, 45000);
  assert.equal(context.intervals.size, 0);
  player.play();
  assert.equal(context.intervals.size, 1);
});

test("the API bridge stays idle when disabled and resyncs on enable", () => {
  const { player } = setup(Player, () => {
    context.settings.localApiEnabled = false;
    mountApi();
  });
  assert.deepEqual(context.reports, []);
  assert.equal(context.intervals.size, 0);

  context.settings.localApiEnabled = true;
  for (const listener of context.subscribers) listener();
  assert.equal(context.reports.at(-1).playing, true);
  assert.deepEqual(context.reports.at(-1).order, ["one", "two", "three"]);
  assert.equal(context.intervals.size, 1);

  context.settings.localApiEnabled = false;
  for (const listener of context.subscribers) listener();
  const count = context.reports.length;
  player.pause();
  player.seek(30000);
  assert.equal(context.reports.length, count);
  assert.equal(context.intervals.size, 0);

  context.settings.localApiEnabled = true;
  for (const listener of context.subscribers) listener();
  assert.equal(context.reports.at(-1).playing, false);
  assert.deepEqual(context.reports.at(-1).order, ["one", "two", "three"]);
});

test("Android reports playback activity independently of the local API", async () => {
  const { player } = setup(AndroidPlayer, mountAndroidPresence, false, null, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.playbackActivity.at(-1), true);
  player.pause();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.playbackActivity.at(-1), false);
  player.play();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.playbackActivity.at(-1), true);
  assert.deepEqual(context.reports, []);
});

test("Android retries a failed playback activity update while paused", async () => {
  const { player } = setup(AndroidPlayer, mountAndroidPresence, false, null, true);
  await new Promise((resolve) => setImmediate(resolve));
  let failed = false;
  context.sendPlayback = (playing) => {
    if (!playing && !failed) {
      failed = true;
      return Promise.reject(new Error("temporary IPC failure"));
    }
    return Promise.resolve();
  };
  player.pause();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.playbackActivity.at(-1), false);
  assert.equal(context.intervals.size, 1);
  tickIntervals();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(context.playbackActivity.slice(-2), [false, false]);
  assert.equal(context.intervals.size, 0);
});

test("media progress events do not repeatedly send media presence", () => {
  const { engine } = setup(AndroidPlayer, mountAndroidPresence, false, null, true);
  const count = context.bridgeMessages.length;
  for (let frame = 1; frame <= 10; frame += 1) {
    engine.element.currentTime = frame / 10;
    engine.element.emit("timeupdate");
  }
  assert.equal(context.frames.size, 0);
  assert.equal(context.bridgeMessages.length, count);
  tickIntervals();
  assert.equal(context.bridgeMessages.length, count + 1);
  assert.equal(context.bridgeMessages.at(-1).revision, undefined);
});

test("visual progress parks while hidden without losing listening time", (t) => {
  const original = globalThis.performance;
  let now = 0;
  globalThis.performance = { now: () => now };
  t.after(() => { globalThis.performance = original; });

  const { engine, player } = setup(AndroidPlayer, mountAndroidPresence, false, null, true);
  let listened = 0;
  let progress = 0;
  player.onListening((elapsed) => { listened += elapsed; });
  player.onProgress((position) => { progress = position; });
  assert.equal(context.frames.size, 0);

  now = 5000;
  engine.element.currentTime = 5;
  document.hidden = true;
  document.dispatch("visibilitychange");
  assert.equal(context.frames.size, 0);
  assert.equal(listened, 5000);
  assert.equal(engine.element.paused, false);

  now = 12000;
  engine.element.currentTime = 12;
  player.sampleListening();
  assert.equal(listened, 12000);

  now = 15000;
  engine.element.currentTime = 15;
  document.hidden = false;
  document.dispatch("visibilitychange");
  assert.equal(listened, 15000);
  assert.equal(progress, 15000);
  assert.equal(context.frames.size, 0);

  document.hidden = true;
  document.dispatch("visibilitychange");
  player.pause();
  assert.equal(engine.element.paused, true);
  assert.equal(context.frames.size, 0);
  player.play();
  assert.equal(engine.element.paused, false);
  assert.equal(context.frames.size, 0);
  document.hidden = false;
  document.dispatch("visibilitychange");
  assert.equal(context.frames.size, 0);
});

for (const [platform, PlayerClass] of [["Linux", Player], ["Android", AndroidPlayer]]) {
  test(`${platform}: system controls fade and retire outgoing songs`, () => {
    const { engine, player } = setup(PlayerClass);
    const first = engine.element;

    press("next");
    const second = engine.element;
    assert.equal(player.currentId, "two");
    assert.equal(first.paused, false);
    assert.equal(second.volume, 0);
    finishFrames();
    assert.equal(first.paused, true);
    assert.equal(first.src, "");
    assert.equal(second.paused, false);
    assert.ok(second.volume > 0);
    assert.equal(second.volume === 1, platform === "Android");

    press("pause");
    assert.equal(second.paused, false);
    assert.equal(player.snapshot().playing, false);
    finishFrames();
    assert.equal(second.paused, true);

    press("previous");
    const previous = engine.element;
    assert.equal(player.currentId, "one");
    assert.equal(previous.paused, false);
    finishFrames();
    assert.ok(previous.volume > 0);

    press("pause");
    finishFrames();
    assert.equal(previous.paused, true);
    assert.equal(context.elements.filter((element) => !element.paused).length, 0);
  });
}

test("rapid system transitions retire every outgoing element after their fades", () => {
  const { engine, player } = setup();
  for (const action of ["next", "next", "previous", "next", "previous", "previous"]) {
    press(action);
  }
  assert.equal(player.currentId, "one");
  finishFrames();
  assert.deepEqual(context.elements.filter((element) => !element.paused), [engine.element]);
  assert.ok(engine.element.volume > 0);

  press("pause");
  finishFrames();
  assert.equal(engine.element.paused, true);
  press("play");
  assert.equal(engine.element.paused, false);
  finishFrames();
  assert.ok(engine.element.volume > 0);
});

test("hiding the app finishes an in-progress foreground crossfade", () => {
  const { engine, player } = setup();
  const first = engine.element;
  player.next();
  const second = engine.element;
  assert.equal(first.paused, false);
  assert.equal(second.volume, 0);

  document.hidden = true;
  document.dispatch("visibilitychange");
  assert.equal(first.paused, true);
  assert.equal(first.src, "");
  assert.ok(second.volume > 0);

  player.next();
  assert.equal(second.paused, true);
  assert.equal(engine.element.paused, false);
  assert.ok(engine.element.volume > 0);
  player.pause();
  assert.equal(engine.element.paused, true);
});

test("Windows and Linux system seeking moves by the requested offset and clamps to the track", () => {
  const { engine, player } = setup();
  press("pause");
  player.seek(30000);
  press("seekBy", -10000);
  assert.equal(engine.positionMs, 20000);
  press("seekBy", 10000);
  assert.equal(engine.positionMs, 30000);
  press("seekBy", -100000);
  assert.equal(engine.positionMs, 0);
  press("seekBy", 200000);
  assert.equal(engine.positionMs, 120000);
  press("seekTo", 25000);
  assert.equal(engine.positionMs, 25000);
});

test("WebKitGTK media actions use the player and interpret MPRIS seek offsets", () => {
  const { engine, player } = setup(Player, mountWebKitPresence);
  context.mediaActions.get("pause")({ action: "pause" });
  assert.equal(engine.element.paused, true);
  player.seek(70000);
  context.mediaActions.get("seekto")({ action: "seekto", seekTime: -10 });
  assert.equal(engine.positionMs, 60000);
  context.mediaActions.get("seekto")({ action: "seekto", seekTime: 10 });
  assert.equal(engine.positionMs, 70000);
  context.mediaActions.get("seekbackward")({ action: "seekbackward", seekOffset: 5 });
  assert.equal(engine.positionMs, 65000);
  context.mediaActions.get("seekforward")({ action: "seekforward" });
  assert.equal(engine.positionMs, 75000);
  context.mediaActions.get("play")({ action: "play" });
  finishFrames();
  assert.equal(engine.element.paused, false);
  context.mediaActions.get("nexttrack")({ action: "nexttrack" });
  assert.equal(player.currentId, "two");
  context.mediaActions.get("previoustrack")({ action: "previoustrack" });
  assert.equal(player.currentId, "one");
  context.mediaActions.get("stop")({ action: "stop" });
  assert.equal(engine.element.paused, true);
  assert.equal(engine.positionMs, 0);
});

test("WebKitGTK media handlers respect the system controls setting", () => {
  const { engine, player } = setup(Player, mountWebKitPresence, false);
  player.seek(70000);
  context.mediaActions.get("seekto")({ action: "seekto", seekTime: -10 });
  context.mediaActions.get("pause")({ action: "pause" });
  assert.equal(engine.positionMs, 70000);
  assert.equal(player.snapshot().playing, true);
  context.settings.systemMediaControls = true;
  context.mediaActions.get("seekto")({ action: "seekto", seekTime: -10 });
  assert.ok(engine.positionMs >= 60000 && engine.positionMs < 60100);
});

test("WebKitGTK media metadata follows the track and the controls setting", () => {
  const { player } = setup(Player, mountWebKitPresence);
  assert.equal(navigator.mediaSession.metadata.title, "one");
  player.next();
  assert.equal(navigator.mediaSession.metadata.title, "two");
  context.settings.systemMediaControls = false;
  for (const listener of context.subscribers) listener();
  assert.equal(navigator.mediaSession.metadata, null);
  context.settings.systemMediaControls = true;
  for (const listener of context.subscribers) listener();
  assert.equal(navigator.mediaSession.metadata.title, "two");
});

test("the WebKitGTK workaround does not affect ordinary browsers", () => {
  setup(Player, mountWebKitPresence, true, null, false, false);
  assert.equal(context.mediaActions.size, 0);
});

test("system seeking keeps the current song playing", () => {
  const { engine, player } = setup();
  engine.element.currentTime = 30;

  press("seekBy", -10000);
  assert.ok(engine.positionMs >= 20000 && engine.positionMs < 20100);
  assert.equal(engine.element.paused, false);

  press("seekBy", 10000);
  assert.ok(engine.positionMs >= 30000 && engine.positionMs < 30100);
  assert.equal(engine.element.paused, false);
  assert.equal(player.currentId, "one");
  assert.equal(player.snapshot().playing, true);
});

test("queue selection and stop finish pending transitions after fading", () => {
  const { engine, player } = setup();
  const first = engine.element;
  press("skipToQueueItem", 2);
  assert.equal(player.currentId, "three");
  finishFrames();
  assert.equal(first.paused, true);
  assert.equal(engine.element.paused, false);

  engine.element.currentTime = 50;
  press("stop");
  finishFrames();
  assert.equal(engine.element.paused, true);
  assert.equal(engine.positionMs, 0);
  assert.equal(player.snapshot().playing, false);
});
