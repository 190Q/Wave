import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const { parse } = createRequire(import.meta.resolve("vite"))("postcss");

const mocks = {
  "../assets/icons/index": "export const createIcon = () => ({});",
  "../lib/device": `
    export const device = () => globalThis.__dockTest.kind;
    export const isTouch = () => globalThis.__dockTest.touch;
    export const insets = () => ({ bottom: 0 });
  `,
  "../lib/format": "export const formatDuration = (ms) => String(ms);",
  "../lib/motion": "export const bounce = () => {}; export const reduceMotionActive = () => true;",
  "../lib/player": "export const MIN_VOLUME = 0; export const MAX_VOLUME = 100;",
  "../lib/state": `
    export const player = globalThis.__dockTest.player;
    export const getState = () => globalThis.__dockTest.state;
    export const currentTrack = () => ({ id: "track" });
    export const subscribe = () => {};
    export const setVolume = () => {};
    export const stepVolume = () => {};
    export const toggleLikeTrack = () => {};
    export const toggleQueue = () => {};
  `,
  "./touch": "export const mountTouch = () => {};",
};

const context = {
  kind: "android",
  touch: true,
  seeks: [],
  toggles: 0,
  state: { lyrics: [{}], likes: new Set(), queueOpen: false },
  player: {
    snapshot: () => ({
      positionMs: 10000, durationMs: 120000, playing: false, shuffle: false,
      repeat: "off", volume: 70, cursor: 0, order: ["track"],
    }),
    seekFraction: (fraction) => context.seeks.push(fraction),
    toggle: () => { context.toggles += 1; },
    previous() {},
    next() {},
    setShuffle() {},
    cycleRepeat() {},
    onProgress() {},
    onChange() {},
  },
};
globalThis.__dockTest = context;

class FakeElement {
  constructor({ button = false, rect = {} } = {}) {
    this.button = button;
    this.rect = rect;
    this.listeners = new Map();
    this.properties = new Map();
    this.classes = new Set();
    this.style = {
      setProperty: (name, value) => this.properties.set(name, value),
      getPropertyValue: (name) => this.properties.get(name) ?? "",
    };
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
      toggle: (name, force) => {
        const enabled = force ?? !this.classes.has(name);
        if (enabled) this.classes.add(name);
        else this.classes.delete(name);
        return enabled;
      },
    };
  }

  addEventListener(name, callback) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(callback);
    this.listeners.set(name, listeners);
  }

  dispatch(name, event = {}) {
    for (const callback of this.listeners.get(name) ?? []) callback(event);
  }

  closest(selector) { return selector === "button" && this.button ? this : null; }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture(id) { this.captured = id; }
  hasPointerCapture(id) { return this.captured === id; }
  releasePointerCapture() { this.captured = null; }
  setAttribute() {}
  toggleAttribute() {}
  append() {}
  replaceChildren() {}
}

globalThis.HTMLInputElement = class extends FakeElement {};

function setup(kind = "android") {
  context.kind = kind;
  context.touch = kind !== "desktop";
  context.seeks.length = 0;
  context.toggles = 0;
  context.state.lyrics = [{}];

  const ids = [
    "dock", "time-now", "time-total", "like", "shuffle", "prev", "play", "next",
    "repeat", "queue-toggle", "volume-bars", "dock-position", "dock-grab",
    "lyrics-panel", "lyrics-grab",
  ];
  const buttons = new Set(["like", "shuffle", "prev", "play", "next", "repeat", "queue-toggle", "dock-grab", "lyrics-grab"]);
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement({ button: buttons.has(id) })]));
  elements.volume = new HTMLInputElement();
  elements.dock.rect = { left: 0, width: 400, top: 80, bottom: 200 };
  elements["lyrics-panel"].clientHeight = 500;

  const controls = new FakeElement({ rect: { top: 120 } });
  controls.contains = (element) => ["like", "shuffle", "prev", "play", "next", "repeat", "queue-toggle"]
    .some((id) => elements[id] === element);
  elements.dock.querySelector = () => controls;
  const stage = new FakeElement();
  const topbar = new FakeElement();
  topbar.offsetHeight = 60;
  const root = new FakeElement();
  root.dataset = {};
  const windowEvents = new FakeElement();

  globalThis.document = {
    documentElement: root,
    getElementById: (id) => elements[id] ?? null,
    querySelector: (selector) => selector === ".stage" ? stage : selector === ".topbar" ? topbar : null,
    createElement: () => new FakeElement(),
  };
  globalThis.window = {
    innerHeight: 800,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
  };

  return { elements, controls, stage, windowEvents };
}

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
  plugins: [{
    name: "dock-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/](dock|lyrics-sheet)\.ts/.test(importer) && source in mocks) {
        return `\0dock-test:${source}`;
      }
    },
    load(id) {
      if (id.startsWith("\0dock-test:")) return mocks[id.slice("\0dock-test:".length)];
    },
  }],
});
after(() => vite.close());
const { mountDock } = await vite.ssrLoadModule("/src/ui/dock.ts");

function pointer(target, x, y) {
  return { target, clientX: x, clientY: y, pointerId: 1, button: 0 };
}

test("touch button hit areas do not extend above the buttons", async () => {
  const css = await readFile(new URL("../src/styles/android.css", import.meta.url), "utf8");
  const rule = parse(css).nodes.find((node) =>
    node.type === "rule" && node.selector === '[data-touch="true"] .dock-row button::after',
  );
  assert.ok(rule, "Missing touch button hit area");
  let top;
  rule.walkDecls((declaration) => {
    if (declaration.prop === "inset") top = declaration.value.trim().split(/\s+/)[0];
    if (declaration.prop === "top") top = declaration.value.trim();
  });
  assert.match(top, /^0(?:[a-z%]+)?$/i);
});

test("touch seeking starts only above the control row", () => {
  for (const kind of ["android", "linuxPhone"]) {
    const { elements, controls, windowEvents } = setup(kind);
    mountDock();

    elements.dock.dispatch("pointerdown", pointer(elements.dock, 200, 119));
    assert.equal(elements.dock.classList.contains("is-scrubbing"), true);
    windowEvents.dispatch("pointerup");
    assert.deepEqual(context.seeks, [0.5]);

    for (const y of [120, 150, 199]) {
      elements.dock.dispatch("pointerdown", pointer(elements.dock, 300, y));
      assert.equal(elements.dock.classList.contains("is-scrubbing"), false);
      windowEvents.dispatch("pointerup");
    }
    assert.deepEqual(context.seeks, [0.5]);

    controls.rect.top = 110;
    elements.dock.dispatch("pointerdown", pointer(elements.dock, 300, 115));
    windowEvents.dispatch("pointerup");
    assert.deepEqual(context.seeks, [0.5]);

    elements.dock.dispatch("pointerdown", pointer(elements.play, 200, 140));
    windowEvents.dispatch("pointerup");
    elements.play.dispatch("click");
    assert.equal(context.toggles, 1);
    assert.deepEqual(context.seeks, [0.5]);
  }
});

test("touch scrubbing follows the pointer and cancellation does not seek", () => {
  const { elements, windowEvents } = setup();
  mountDock();
  elements.dock.dispatch("pointerdown", pointer(elements.dock, 100, 100));
  windowEvents.dispatch("pointermove", pointer(elements.dock, 300, 130));
  windowEvents.dispatch("pointerup");
  assert.deepEqual(context.seeks, [(300 - 24) / (400 - 48)]);

  elements.dock.dispatch("pointerdown", pointer(elements.dock, 100, 100));
  windowEvents.dispatch("pointercancel");
  assert.equal(elements.dock.classList.contains("is-scrubbing"), false);
  assert.equal(context.seeks.length, 1);
});

test("touches above the controls seek even when snapped to a nearby button", () => {
  const { elements, windowEvents } = setup();
  mountDock();
  elements.dock.dispatch("pointerdown", pointer(elements.play, 200, 119));
  assert.equal(elements.dock.classList.contains("is-scrubbing"), true);
  assert.equal(elements.dock.hasPointerCapture(1), true);
  windowEvents.dispatch("pointerup");
  assert.deepEqual(context.seeks, [0.5]);

  let prevented = false;
  let stopped = false;
  elements.dock.dispatch("click", {
    target: elements.play,
    detail: 1,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });
  assert.equal(prevented, true);
  assert.equal(stopped, true);

  elements.dock.dispatch("pointerdown", pointer(elements.dock, 200, 119));
  windowEvents.dispatch("pointerup");
  prevented = false;
  elements.dock.dispatch("click", {
    target: elements.play,
    detail: 0,
    preventDefault: () => { prevented = true; },
    stopPropagation() {},
  });
  assert.equal(prevented, false);
  assert.deepEqual(context.seeks, [0.5, 0.5]);

  elements.dock.dispatch("pointerdown", pointer(elements["dock-grab"], 200, 100));
  assert.equal(elements.dock.classList.contains("is-scrubbing"), false);
  windowEvents.dispatch("pointerup");
  assert.deepEqual(context.seeks, [0.5, 0.5]);
});

test("Android sheet swipes from the controls or seek area do not seek", () => {
  for (const startY of [150, 110]) {
    const { elements, stage, windowEvents } = setup();
    mountDock();
    const target = startY < 120 ? elements.play : elements.dock;
    elements.dock.dispatch("pointerdown", pointer(target, 200, startY));
    windowEvents.dispatch("pointermove", pointer(elements.dock, 200, startY - 70));
    assert.equal(elements.dock.classList.contains("is-scrubbing"), false);
    windowEvents.dispatch("pointerup");
    assert.equal(stage.style.getPropertyValue("--sheet-travel"), "500px");
    assert.deepEqual(context.seeks, []);

    if (startY < 120) {
      let prevented = false;
      elements.dock.dispatch("click", {
        target: elements.play,
        detail: 1,
        preventDefault: () => { prevented = true; },
        stopPropagation() {},
      });
      assert.equal(prevented, true);
    }
  }
});

test("cancelled seeking does not block subsequent control clicks", () => {
  const { elements, windowEvents } = setup();
  mountDock();
  elements.dock.dispatch("pointerdown", pointer(elements.play, 200, 119));
  windowEvents.dispatch("pointercancel");

  let prevented = false;
  elements.dock.dispatch("click", {
    target: elements.play,
    detail: 1,
    preventDefault: () => { prevented = true; },
    stopPropagation() {},
  });
  assert.equal(prevented, false);
  assert.deepEqual(context.seeks, []);
});

test("desktop mouse seeking still works across the dock", () => {
  const { elements, windowEvents } = setup("desktop");
  mountDock();
  elements.dock.dispatch("pointerdown", pointer(elements.dock, 300, 150));
  windowEvents.dispatch("pointerup");
  assert.deepEqual(context.seeks, [0.75]);
});
