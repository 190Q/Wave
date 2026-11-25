import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

class Events {
  listeners = new Map();
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  dispatch(name, event) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

class FakeAudio extends Events {
  paused = true;
  ended = false;
  seeking = false;
  currentTime = 0;
  duration = 120;
  readyState = 1;
  play() { this.paused = false; this.dispatch("play"); return Promise.resolve(); }
  pause() { this.paused = true; this.dispatch("pause"); }
  removeAttribute() {}
  load() {}
}

const win = new Events();
const doc = Object.assign(new Events(), { hidden: false });
const frames = new Map();
let nextFrame = 0;
let now = 0;
win.cancelAnimationFrame = (id) => frames.delete(id);
globalThis.window = win;
globalThis.document = doc;
globalThis.Audio = FakeAudio;
globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
globalThis.performance = { now: () => now };
globalThis.requestAnimationFrame = (callback) => {
  frames.set(++nextFrame, callback);
  return nextFrame;
};
globalThis.__activityTest = {};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  ssr: { noExternal: ["@tauri-apps/api"] },
  plugins: [{
    name: "activity-platform-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (!/[\\/]src[\\/]lib[\\/](activity-platform|player)\.ts$/.test(importer ?? "")) return;
      if (source === "./device") return "\0activity-device";
      if (source === "@tauri-apps/api/core") return "\0activity-core";
      if (source === "@tauri-apps/api/event") return "\0activity-event";
      if (source === "@tauri-apps/api/window") return "\0activity-window";
    },
    load(id) {
      if (id === "\0activity-device") {
        return 'export const isAndroidPlatform = false, isWebKitGtk = true; export const device = () => "linuxPhone";';
      }
      if (id === "\0activity-core") {
        return "export const isTauri = () => true; export const invoke = () => new Promise(resolve => globalThis.__activityTest.resolveBlank = resolve);";
      }
      if (id === "\0activity-event") {
        return "export const listen = (_name, listener) => { globalThis.__activityTest.screen = listener; return Promise.resolve(() => {}); };";
      }
      if (id === "\0activity-window") {
        return "export const getCurrentWindow = () => ({ onFocusChanged: listener => { globalThis.__activityTest.focus = listener; return Promise.resolve(() => {}); }, isFocused: () => new Promise(resolve => globalThis.__activityTest.resolveFocus = resolve) });";
      }
    },
  }],
});
after(() => vite.close());

const activity = await vite.ssrLoadModule("/src/lib/activity.ts");
const { AudioEngine } = await vite.ssrLoadModule("/src/lib/audio.ts");
const { Player } = await vite.ssrLoadModule("/src/lib/player.ts");
const { mountActivity } = await vite.ssrLoadModule("/src/lib/activity-platform.ts");

test("playback progress follows media events, pauses visual updates in the background, and catches up", () => {
  const engine = new AudioEngine();
  const player = new Player(engine, () => ({ path: "http://127.0.0.1:1234/song", durationMs: 120000, gain: 1 }));
  const progress = [];
  const heard = [];
  player.onProgress((position) => progress.push(position));
  player.onListening((elapsed) => heard.push(elapsed));
  player.setQueue("queue", "Queue", ["song"]);
  player.play();
  player.finishTransitions();
  assert.equal(frames.size, 0);

  now = 1000;
  engine.element.currentTime = 1;
  engine.element.dispatch("timeupdate");
  assert.equal(progress.at(-1), 1000);
  assert.equal(heard.at(-1), 1000);
  assert.equal(frames.size, 0);

  activity.setBackground(true);
  const count = progress.length;
  now = 2000;
  engine.element.currentTime = 2;
  engine.element.dispatch("timeupdate");
  assert.equal(progress.length, count);
  assert.equal(engine.isPlaying, true);
  player.sampleListening();
  assert.equal(heard.at(-1), 1000);

  activity.setScreenBlanked(true);
  activity.setBackground(false);
  assert.equal(progress.length, count);
  activity.setScreenBlanked(false);
  assert.equal(progress.at(-1), 2000);
  assert.equal(frames.size, 0);

  player.seek(45000);
  assert.equal(progress.at(-1), 45000);
  player.pause();
  player.finishTransitions();
  assert.equal(engine.isPlaying, false);
  assert.equal(frames.size, 0);
});

test("phone focus and screen signals win over stale initial state and input cannot undo a screen lock", async () => {
  mountActivity();
  await new Promise((resolve) => setImmediate(resolve));
  const native = globalThis.__activityTest;
  assert.equal(win.listeners.has("blur"), true);
  assert.equal(typeof native.focus, "function");
  native.focus({ payload: true });
  native.resolveFocus(false);
  native.screen({ payload: true });
  native.resolveBlank(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(activity.uiActive(), false);

  win.dispatch("pointerdown");
  assert.equal(activity.uiActive(), false);
  native.screen({ payload: false });
  assert.equal(activity.uiActive(), true);

  native.focus({ payload: false });
  assert.equal(activity.uiActive(), false);
  win.dispatch("keydown");
  assert.equal(activity.uiActive(), true);
  doc.hidden = true;
  doc.dispatch("visibilitychange");
  assert.equal(activity.uiActive(), false);
  doc.hidden = false;
  doc.dispatch("visibilitychange");
  assert.equal(activity.uiActive(), true);
});
