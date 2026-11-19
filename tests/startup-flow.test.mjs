import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createServer } from "vite";

const motion = { reduced: false, listeners: new Set() };
globalThis.__startupFlowMotion = motion;

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "startup-flow-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/]startup\.ts$/.test(importer) && source === "../lib/motion") {
        return "\0startup-flow-motion";
      }
    },
    load(id) {
      if (id === "\0startup-flow-motion") {
        return `
          const motion = globalThis.__startupFlowMotion;
          export const reduceMotionActive = () => motion.reduced;
          export const subscribeMotion = (listener) => {
            motion.listeners.add(listener);
            return () => motion.listeners.delete(listener);
          };
        `;
      }
    },
  }],
});
after(() => vite.close());

const { mountStartup } = await vite.ssrLoadModule("/src/ui/startup.ts");
const bootstrap = readFileSync(new URL("../public/startup.js", import.meta.url), "utf8");

class Element {
  constructor() {
    this.attributes = {};
    this.children = [];
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(child) { this.children.push(child); }
}

function setup(reduced = false) {
  motion.reduced = reduced;
  motion.listeners.clear();
  const svg = new Element();
  const frames = new Map();
  const systemListeners = new Set();
  const query = {
    matches: reduced,
    addEventListener: (_, listener) => systemListeners.add(listener),
    removeEventListener: (_, listener) => systemListeners.delete(listener),
  };
  let nextFrame = 0;
  let now = 0;
  const win = {
    matchMedia: () => query,
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  const context = {
    document: {
      querySelector: () => svg,
      createElementNS: () => new Element(),
    },
    window: win,
    performance: { now: () => now },
    requestAnimationFrame: (callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
  };
  const tick = (time) => {
    now = time;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(now));
  };
  runInNewContext(bootstrap, context);
  globalThis.window = win;
  return { svg, frames, query, systemListeners, tick };
}

function point(path, x) {
  const value = path.attributes.d.split(" ")[x / 4 * 2 + 1];
  return Number(value);
}

test("both entry pages start the animation without any visible loading message", () => {
  for (const path of ["../index.html", "../dev/phone/app.html"]) {
    const html = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(html, /<div class="startup" role="status" aria-label="Starting Wave">\s*<svg class="startup-flow"[^>]*><\/svg>\s*<\/div>\s*<script src="\/startup\.js"><\/script>/);
    assert.doesNotMatch(html, /Loading your library/);
  }
});

test("phone windows are revealed while the startup animation is running", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.android.conf.json", import.meta.url), "utf8"));
  assert.equal(config.app.windows[0].visible, true);
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /if \(device\(\) === "desktop"\) \{[\s\S]*?\} else \{\s*void showMainWindow\(\)/);
});

test("the Flow paths animate before the main app starts", () => {
  const { svg, frames, tick } = setup();
  assert.equal(svg.children.length, 5);
  assert.equal(frames.size, 1);
  assert.equal(motion.listeners.size, 0);

  const paths = svg.children;
  assert.equal(point(paths[0], 0), 236);
  assert.equal(point(paths[4], 512), 376);
  const before = paths.map((path) => path.attributes.d);
  tick(550);
  assert.ok(paths.every((path, index) => path.attributes.d !== before[index]));

  const x = 128;
  const weight = (1 - Math.cos(Math.PI * (x - 36) / (165 - 36))) / 2;
  const base = 221 + (322 - 221) * weight;
  const ripple = 16 * Math.sin(Math.PI * x / 512) * Math.sin(2 * Math.PI * 0.55 / 2.2 - x * 0.014);
  assert.equal(point(paths[0], x), Number((base + ripple).toFixed(1)));

  const stop = mountStartup();
  assert.equal(motion.listeners.size, 1);
  stop();
  assert.equal(frames.size, 0);
  assert.equal(motion.listeners.size, 0);
});

test("system and app reduced-motion settings pause and resume the startup animation", () => {
  const { svg, frames, query, systemListeners, tick } = setup(true);
  const path = svg.children[0];
  const still = path.attributes.d;
  assert.equal(frames.size, 0);

  query.matches = false;
  systemListeners.forEach((listener) => listener());
  assert.equal(frames.size, 1);
  tick(550);
  assert.notEqual(path.attributes.d, still);

  const stop = mountStartup();
  assert.equal(systemListeners.size, 0);
  assert.equal(frames.size, 0);
  assert.equal(path.attributes.d, still);

  motion.reduced = false;
  motion.listeners.forEach((listener) => listener());
  assert.equal(frames.size, 1);
  tick(1100);
  assert.notEqual(path.attributes.d, still);

  motion.reduced = true;
  motion.listeners.forEach((listener) => listener());
  assert.equal(frames.size, 0);
  assert.equal(path.attributes.d, still);
  stop();
  assert.equal(motion.listeners.size, 0);
});
