import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const { parse } = createRequire(import.meta.resolve("vite"))("postcss");
const context = {
  kind: "desktop",
  mini: false,
  tauri: true,
  dismissed: 0,
  drags: 0,
  listeners: [],
  timers: new Map(),
};
globalThis.__miniTest = context;

const mocks = {
  "@tauri-apps/api/core": "export const isTauri = () => globalThis.__miniTest.tauri;",
  "@tauri-apps/api/window": "export const getCurrentWindow = () => ({ startDragging: async () => { globalThis.__miniTest.drags++; } });",
  "../lib/device": "export const device = () => globalThis.__miniTest.kind;",
  "../lib/state": `
    export const getState = () => ({ settings: { miniPlayer: globalThis.__miniTest.mini } });
    export const subscribe = (listener) => globalThis.__miniTest.listeners.push(listener);
    export const currentTrack = () => ({ title: "Bat Country" });
    export const player = { onChange() {} };
  `,
  "../lib/motion": "export const reduceMotionActive = () => true; export const subscribeMotion = () => {};",
  "./popups": "export const dismissPopup = () => { globalThis.__miniTest.dismissed++; };",
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
    name: "mini-player-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/](mini-player|dock-title)\.ts/.test(importer) && source in mocks) {
        return `\0mini-test:${source}`;
      }
    },
    load(id) {
      if (id.startsWith("\0mini-test:")) return mocks[id.slice("\0mini-test:".length)];
    },
  }],
});
after(() => vite.close());
const { mountMiniPlayer } = await vite.ssrLoadModule("/src/ui/mini-player.ts");
const { mountDockTitle } = await vite.ssrLoadModule("/src/ui/dock-title.ts");

function element() {
  const classes = new Set();
  const attributes = new Map();
  const handlers = new Map();
  return {
    attributes,
    handlers,
    style: { setProperty() {} },
    classList: {
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, force) => {
        if (force ?? !classes.has(name)) classes.add(name);
        else classes.delete(name);
      },
    },
    setAttribute: (name, value) => attributes.set(name, value),
    addEventListener: (name, handler) => handlers.set(name, handler),
    getBoundingClientRect: () => ({ width: 200 }),
    scrollWidth: 100,
    clientWidth: 200,
    offsetWidth: 100,
  };
}

function setup() {
  context.kind = "desktop";
  context.mini = false;
  context.tauri = true;
  context.dismissed = 0;
  context.drags = 0;
  context.listeners = [];
  context.timers = new Map();
  const root = element();
  const title = element();
  const strip = element();
  const buttons = element();
  const hero = element();
  const elements = { "dock-title": title, "dock-title-text": strip, "dock-buttons": buttons, hero };
  globalThis.document = { documentElement: root, getElementById: (id) => elements[id] ?? null };
  globalThis.window = {
    setTimeout: (callback) => {
      const id = context.timers.size + 1;
      context.timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => context.timers.delete(id),
  };
  return { root, title, strip };
}

function render() {
  for (const listener of context.listeners) listener();
}

test("mini mode follows desktop settings and dismisses an open popup once", () => {
  const { root, title } = setup();
  mountMiniPlayer();
  assert.equal(root.classList.contains("is-mini-player"), false);
  assert.equal(title.attributes.get("aria-hidden"), "true");

  context.mini = true;
  render();
  render();
  assert.equal(root.classList.contains("is-mini-player"), true);
  assert.equal(title.attributes.get("aria-hidden"), "false");
  assert.equal(context.dismissed, 1);

  context.kind = "android";
  render();
  assert.equal(root.classList.contains("is-mini-player"), false);
  assert.equal(title.attributes.get("aria-hidden"), "true");
});

test("dragging the title moves only the native mini player", () => {
  const { title } = setup();
  mountMiniPlayer();
  let prevented = 0;
  let stopped = 0;
  const event = {
    button: 0,
    preventDefault: () => prevented++,
    stopPropagation: () => stopped++,
  };
  title.handlers.get("pointerdown")(event);
  assert.equal(context.drags, 0);

  context.mini = true;
  render();
  title.handlers.get("pointerdown")({ ...event, button: 2 });
  assert.equal(context.drags, 0);
  title.handlers.get("pointerdown")(event);
  assert.equal(context.drags, 1);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);

  context.tauri = false;
  title.handlers.get("pointerdown")(event);
  assert.equal(context.drags, 1);
});

test("the track title is shown in mini mode even when the hero has not folded", () => {
  const { root, title, strip } = setup();
  mountMiniPlayer();
  mountDockTitle();
  assert.equal(strip.textContent, "Bat Country");
  assert.equal(title.classList.contains("is-shown"), false);

  context.mini = true;
  render();
  assert.equal(root.classList.contains("is-title-folded"), false);
  for (const callback of [...context.timers.values()]) callback();
  assert.equal(title.classList.contains("is-shown"), true);

  context.mini = false;
  render();
  assert.equal(title.classList.contains("is-shown"), false);
});

test("mini-player styles leave only the dock and hide its side controls", async () => {
  const css = await readFile(new URL("../src/styles/mini-player.css", import.meta.url), "utf8");
  const rules = parse(css).nodes.filter((node) => node.type === "rule");
  for (const selector of [".is-mini-player .stage > :not(.dock)", ".is-mini-player .dock-side"]) {
    const rule = rules.find((node) => node.selector === selector);
    assert.ok(rule, `Missing ${selector}`);
    assert.ok(rule.nodes.some((node) => node.prop === "display" && node.value === "none"));
  }
  const dock = rules.find((node) => node.selector === ".is-mini-player .dock");
  assert.ok(dock.nodes.some((node) => node.prop === "width" && node.value === "100%"));
  assert.ok(dock.nodes.some((node) => node.prop === "height" && node.value === "100%"));
  assert.ok(dock.nodes.some((node) => node.prop === "border" && node.value === "0"));
  assert.ok(dock.nodes.some((node) => node.prop === "border-radius" && node.value === "0"));
});
