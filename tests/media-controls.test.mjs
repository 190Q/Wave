import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const context = {};
globalThis.__mediaControlTest = context;

const mocks = {
  "@tauri-apps/api/event": `
    export const listen = async (event, callback) => {
      if (event === "api-command") globalThis.__mediaControlTest.apiControl = callback;
      else globalThis.__mediaControlTest.control = callback;
      return () => {};
    };
  `,
  "@tauri-apps/api/window": "export const getCurrentWindow = () => ({ setFocus: async () => {} });",
  "./device": "export const isAndroidPlatform = false;",
  "android-device": "export const isAndroidPlatform = true;",
  "./ipc": `
    export const setNowPlaying = (song) => {
      const context = globalThis.__mediaControlTest;
      context.songs.push(song);
      return context.sendSong ? context.sendSong(song) : Promise.resolve();
    };
    export const setQueue = async (queue) => globalThis.__mediaControlTest.queues.push(queue);
    export const showMainWindow = async () => {};
    export const reportApiState = async (report) => globalThis.__mediaControlTest.reports.push(report);
  `,
  "./state": `
    const context = globalThis.__mediaControlTest;
    export const player = new Proxy({}, {
      get(_target, key) {
        const value = context.player[key];
        return typeof value === "function" ? value.bind(context.player) : value;
      }
    });
    export const getState = () => ({ settings: context.settings });
    export const currentTrack = () => trackById(context.player.currentId);
    export const trackById = (id) => id ? { id, title: id, durationMs: 120000 } : undefined;
    export const colourFor = () => "#123456";
    export const setVolume = (value) => context.player.setVolume(value);
    export const stepTrack = (direction) => direction > 0 ? context.player.next() : context.player.previous();
    export const subscribe = () => {};
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
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute(name) { if (name === "src") this.src = ""; }
  load() {}
}

function setup(PlayerClass = Player, mount = mountPresence, controls = true, sendSong = null, bridge = false) {
  context.elements = [];
  context.frames = new Map();
  context.nextFrame = 1;
  context.intervals = new Map();
  context.nextInterval = 1;
  context.control = null;
  context.apiControl = null;
  context.androidControl = null;
  context.songs = [];
  context.sendSong = sendSong;
  context.queues = [];
  context.reports = [];
  context.bridgeMessages = [];
  context.settings = { systemMediaControls: controls, discordPresence: false };

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
  globalThis.window = {
    cancelAnimationFrame: (id) => context.frames.delete(id),
    setInterval: (callback) => {
      const id = context.nextInterval++;
      context.intervals.set(id, callback);
      return id;
    },
    clearInterval: (id) => context.intervals.delete(id),
    addEventListener: (name, callback) => {
      if (name === "wave:media-control") context.androidControl = callback;
    },
  };
  if (bridge) {
    window.wavePlayback = { postMessage: (message) => context.bridgeMessages.push(JSON.parse(message)) };
  }
  globalThis.requestAnimationFrame = (callback) => {
    const id = context.nextFrame++;
    context.frames.set(id, callback);
    return id;
  };
  globalThis.Audio = FakeAudio;
  globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };

  const engine = new AudioEngine();
  const player = new PlayerClass(engine, (id) => ({
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
  assert.equal(engine.element.paused, true);
  context.androidControl({ detail: { action: "play" } });
  assert.equal(engine.element.paused, false);
  assert.ok(engine.element.volume > 0);
  context.androidControl({ detail: { action: "seekTo", value: 25000 } });
  assert.equal(engine.positionMs, 25000);
  context.androidControl({ detail: { action: "next" } });
  assert.equal(player.currentId, "two");
  assert.equal(engine.element.paused, false);
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

test("visual progress frames do not repeatedly send media presence", () => {
  const { engine } = setup(AndroidPlayer, mountAndroidPresence, false, null, true);
  const count = context.bridgeMessages.length;
  for (let frame = 1; frame <= 10; frame += 1) {
    const [id, callback] = context.frames.entries().next().value;
    context.frames.delete(id);
    engine.element.currentTime = frame / 10;
    callback(performance.now());
  }
  assert.equal(context.bridgeMessages.length, count);
  tickIntervals();
  assert.equal(context.bridgeMessages.length, count + 1);
});

test("the visual clock parks while hidden without losing listening time", (t) => {
  const original = globalThis.performance;
  let now = 0;
  globalThis.performance = { now: () => now };
  t.after(() => { globalThis.performance = original; });

  const { engine, player } = setup(AndroidPlayer, mountAndroidPresence, false, null, true);
  let listened = 0;
  let progress = 0;
  player.onListening((elapsed) => { listened += elapsed; });
  player.onProgress((position) => { progress = position; });
  assert.equal(context.frames.size, 1);

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
  assert.equal(context.frames.size, 1);

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
  assert.equal(context.frames.size, 1);
});

for (const [platform, PlayerClass] of [["Linux", Player], ["Android", AndroidPlayer]]) {
  test(`${platform}: system next, pause, previous and pause do not leave an old song playing`, () => {
    const { engine, player } = setup(PlayerClass);
    const first = engine.element;

    press("next");
    const second = engine.element;
    assert.equal(player.currentId, "two");
    assert.equal(first.paused, true);
    assert.equal(first.src, "");
    assert.equal(second.paused, false);
    assert.ok(second.volume > 0);
    assert.equal(second.volume === 1, platform === "Android");

    press("pause");
    assert.equal(second.paused, true);
    assert.equal(player.snapshot().playing, false);

    press("previous");
    const previous = engine.element;
    assert.equal(player.currentId, "one");
    assert.equal(previous.paused, false);
    assert.ok(previous.volume > 0);

    press("pause");
    assert.equal(previous.paused, true);
    assert.equal(context.elements.filter((element) => !element.paused).length, 0);
  });
}

test("rapid system transitions retire every outgoing element without animation frames", () => {
  const { engine, player } = setup();
  for (const action of ["next", "next", "previous", "next", "previous", "previous"]) {
    press(action);
    assert.deepEqual(context.elements.filter((element) => !element.paused), [engine.element]);
    assert.ok(engine.element.volume > 0);
  }
  assert.equal(player.currentId, "one");

  press("pause");
  assert.equal(engine.element.paused, true);
  press("play");
  assert.equal(engine.element.paused, false);
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

test("queue selection and stop finish pending transitions", () => {
  const { engine, player } = setup();
  const first = engine.element;
  press("skipToQueueItem", 2);
  assert.equal(player.currentId, "three");
  assert.equal(first.paused, true);
  assert.equal(engine.element.paused, false);

  engine.element.currentTime = 50;
  press("stop");
  assert.equal(engine.element.paused, true);
  assert.equal(engine.positionMs, 0);
  assert.equal(player.snapshot().playing, false);
});
