import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const context = {};
globalThis.__mediaControlTest = context;

const mocks = {
  "@tauri-apps/api/event": `
    export const listen = async (_event, callback) => {
      globalThis.__mediaControlTest.control = callback;
      return () => {};
    };
  `,
  "@tauri-apps/api/window": "export const getCurrentWindow = () => ({ setFocus: async () => {} });",
  "./device": "export const isAndroidPlatform = false;",
  "android-device": "export const isAndroidPlatform = true;",
  "./ipc": `
    export const setNowPlaying = async () => {};
    export const setQueue = async () => {};
    export const showMainWindow = async () => {};
  `,
  "./state": `
    const context = globalThis.__mediaControlTest;
    export const player = new Proxy({}, {
      get(_target, key) {
        const value = context.player[key];
        return typeof value === "function" ? value.bind(context.player) : value;
      }
    });
    export const getState = () => ({ settings: { systemMediaControls: true, discordPresence: false } });
    export const currentTrack = () => trackById(context.player.currentId);
    export const trackById = (id) => id ? { id, title: id, durationMs: 120000 } : undefined;
    export const colourFor = () => "#123456";
    export const setVolume = (value) => context.player.setVolume(value);
    export const stepTrack = (direction) => direction > 0 ? context.player.next() : context.player.previous();
    export const subscribe = () => {};
  `,
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
  ssr: { noExternal: ["@tauri-apps/api"] },
  plugins: [{
    name: "media-control-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !source || !(source in mocks)) return;
      if (source === "./device" && /player\.ts\?android/.test(importer)) {
        return "\0media-control-test:android-device";
      }
      if (/[\\/]src[\\/]lib[\\/](presence|player)\.ts/.test(importer)) {
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

function setup(PlayerClass = Player) {
  context.elements = [];
  context.frames = new Map();
  context.nextFrame = 1;
  context.control = null;

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
    setInterval: () => 0,
  };
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
  mountPresence();
  player.setQueue("queue", "Queue", ["one", "two", "three"]);
  player.play();
  player.finishTransitions();
  return { engine, player };
}

function press(action, value) {
  context.control({ payload: { action, value } });
}

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
