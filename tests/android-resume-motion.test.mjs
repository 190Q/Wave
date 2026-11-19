import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

class Events {
  listeners = new Map();
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  dispatch(type) {
    for (const callback of this.listeners.get(type) ?? []) callback();
  }
}

const state = { settings: { reduceMotion: "off" } };
globalThis.__resumeMotionState = state;
const query = new Events();
query.matches = false;
const win = Object.assign(new Events(), { matchMedia: () => query });
const classes = new Set();
const root = {
  offsetWidth: 100,
  classList: {
    add: (name) => classes.add(name),
    remove: (name) => classes.delete(name),
    contains: (name) => classes.has(name),
    toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
  },
};
let focused = true;
let finished = 0;
let cancelled = 0;
const doc = Object.assign(new Events(), {
  documentElement: root,
  hidden: false,
  hasFocus: () => focused,
  getAnimations: () => [
    { finish: () => { finished += 1; } },
    { finish: () => { throw new Error("infinite"); }, cancel: () => { cancelled += 1; } },
  ],
});
const frames = new Map();
let frameId = 0;
globalThis.window = win;
globalThis.document = doc;
globalThis.requestAnimationFrame = (callback) => {
  frames.set(++frameId, callback);
  return frameId;
};
win.cancelAnimationFrame = (id) => frames.delete(id);
const tick = () => {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback();
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "resume-motion-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]lib[\\/]motion\.ts$/.test(importer)) {
        if (source === "./state") return "\0resume-motion-state";
        if (source === "./device") return "\0resume-motion-device";
      }
    },
    load(id) {
      if (id === "\0resume-motion-state") {
        return "export const getState = () => globalThis.__resumeMotionState; export const subscribe = () => {};";
      }
      if (id === "\0resume-motion-device") return "export const isAndroidPlatform = true;";
    },
  }],
});
after(() => vite.close());

const { mountMotion, reduceMotionActive, subscribeMotion } = await vite.ssrLoadModule("/src/lib/motion.ts");

test("Android settles motion while unfocused and keeps it settled through the first frames", () => {
  const changes = [];
  subscribeMotion(() => changes.push(reduceMotionActive()));
  mountMotion();
  assert.equal(reduceMotionActive(), false);

  focused = false;
  win.dispatch("blur");
  assert.equal(reduceMotionActive(), true);
  assert.equal(classes.has("is-resuming"), true);
  assert.equal(finished, 1);
  assert.equal(cancelled, 1);

  doc.hidden = true;
  doc.dispatch("visibilitychange");
  doc.hidden = false;
  doc.dispatch("visibilitychange");
  assert.equal(frames.size, 0);

  focused = true;
  win.dispatch("focus");
  assert.equal(frames.size, 1);
  tick();
  assert.equal(reduceMotionActive(), true);

  focused = false;
  win.dispatch("blur");
  assert.equal(frames.size, 0);
  focused = true;
  win.dispatch("focus");
  tick();
  tick();
  assert.equal(reduceMotionActive(), false);
  assert.equal(classes.has("is-resuming"), false);
  assert.deepEqual(changes, [true, false]);
});

test("Android window and WebView use the app's dark background", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const config = JSON.parse(read("../src-tauri/tauri.android.conf.json"));
  const colours = read("../src-tauri/gen/android/app/src/main/res/values/colors.xml");
  const day = read("../src-tauri/gen/android/app/src/main/res/values/themes.xml");
  const night = read("../src-tauri/gen/android/app/src/main/res/values-night/themes.xml");
  assert.equal(config.app.windows[0].backgroundColor.toLowerCase(), "#07070a");
  assert.match(colours, /<color name="wave_background">#07070a<\/color>/i);
  for (const theme of [day, night]) {
    assert.match(theme, /<item name="android:windowBackground">@color\/wave_background<\/item>/);
  }
});
