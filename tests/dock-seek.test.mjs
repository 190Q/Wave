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
  "../lib/motion": "export const bounce = (element) => globalThis.__dockTest.bounces.push(element); export const reduceMotionActive = () => true; export const subscribeMotion = () => {};",
  "../lib/player": "export const MIN_VOLUME = 0; export const MAX_VOLUME = 100;",
  "../lib/state": `
    export const player = globalThis.__dockTest.player;
    export const getState = () => globalThis.__dockTest.state;
    export const currentTrack = () => globalThis.__dockTest.track;
    export const subscribe = () => {};
    export const setVolume = () => {};
    export const stepVolume = () => {};
    export const toggleLikeTrack = (id) => globalThis.__dockTest.likedTracks.push(id);
    export const toggleQueue = () => {};
  `,
  "./touch": "export const mountTouch = () => {};",
  "./seek-time": "export const openSeekTime = () => { globalThis.__dockTest.opens += 1; };",
};

const context = {
  kind: "android",
  touch: true,
  seeks: [],
  toggles: 0,
  opens: 0,
  track: { id: "track" },
  bounces: [],
  likedTracks: [],
  position: 10000,
  playing: false,
  state: { lyrics: [{}], likes: new Set(), queueOpen: false },
  player: {
    snapshot: () => ({
      positionMs: context.position, durationMs: 120000, playing: context.playing, shuffle: false,
      repeat: "off", volume: 70, cursor: 0, order: ["track"],
    }),
    seekFraction: (fraction) => context.seeks.push(fraction),
    toggle: () => { context.toggles += 1; },
    previous() {},
    next() {},
    setShuffle() {},
    cycleRepeat() {},
    onProgress(callback) { context.progress = callback; },
    onChange(callback) { context.change = callback; },
  },
};
globalThis.__dockTest = context;

class FakeElement {
  constructor({ button = false, rect = {} } = {}) {
    this.button = button;
    this.rect = rect;
    this.listeners = new Map();
    this.properties = new Map();
    this.attributes = new Map();
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
    event.type = name;
    for (const callback of this.listeners.get(name) ?? []) callback(event);
  }

  closest(selector) { return selector === "button" && this.button ? this : null; }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture(id) { this.captured = id; }
  hasPointerCapture(id) { return this.captured === id; }
  releasePointerCapture() { this.captured = null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  focus() { document.activeElement = this; }
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
  context.opens = 0;
  context.track = { id: "track" };
  context.bounces.length = 0;
  context.likedTracks.length = 0;
  context.position = 10000;
  context.playing = false;
  context.state.lyrics = [{}];
  context.focused = true;

  const ids = [
    "dock", "time-now", "time-now-phone", "time-total", "like", "shuffle", "prev", "play", "next",
    "repeat", "queue-toggle", "volume-bars", "dock-position", "dock-grab",
    "lyrics-panel", "lyrics-grab", "carousel",
  ];
  const buttons = new Set(["time-now", "like", "shuffle", "prev", "play", "next", "repeat", "queue-toggle", "dock-grab", "lyrics-grab"]);
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement({ button: buttons.has(id) })]));
  elements.volume = new HTMLInputElement();
  elements.dock.rect = { left: 0, width: 400, top: 80, bottom: 200 };
  elements["lyrics-panel"].clientHeight = 500;

  const controls = new FakeElement({ rect: { top: 120 } });
  const fill = new FakeElement();
  const edge = new FakeElement();
  controls.contains = (element) => ["like", "shuffle", "prev", "play", "next", "repeat", "queue-toggle"]
    .some((id) => elements[id] === element);
  elements.dock.querySelector = (selector) => selector === ".dock-row" ? controls
    : selector === ".dock-fill" ? fill
    : selector === ".dock-edge" ? edge : null;
  const stage = new FakeElement();
  const topbar = new FakeElement();
  topbar.offsetHeight = 60;
  const root = new FakeElement();
  root.dataset = {};
  const windowEvents = new FakeElement();

  globalThis.document = {
    documentElement: root,
    hasFocus: () => context.focused,
    getElementById: (id) => elements[id] ?? null,
    querySelector: (selector) => selector === ".stage" ? stage : selector === ".topbar" ? topbar : null,
    createElement: () => new FakeElement(),
  };
  const frames = new Map();
  let frameId = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  globalThis.window = {
    innerHeight: 800,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    cancelAnimationFrame: (id) => frames.delete(id),
  };

  return { elements, controls, stage, windowEvents, fill, edge };
}

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
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
const { mountDock, toggleCurrentLike } = await vite.ssrLoadModule("/src/ui/dock.ts");
const { createSheetVisibility } = await vite.ssrLoadModule("/src/ui/sheet-visibility.ts");

function pointer(target, x, y) {
  return { target, clientX: x, clientY: y, pointerId: 1, button: 0 };
}

function sheetTravel(elements) {
  return Number(elements["lyrics-panel"].style.transform.match(/-\s*([\d.]+)px/)[1]);
}

test("like button and shortcut share the same bounce and toggle", () => {
  const { elements } = setup("desktop");
  mountDock();

  elements.like.dispatch("click");
  toggleCurrentLike();
  assert.deepEqual(context.bounces, [elements.like, elements.like]);
  assert.deepEqual(context.likedTracks, ["track", "track"]);

  context.track = undefined;
  elements.like.dispatch("click");
  toggleCurrentLike();
  assert.equal(context.bounces.length, 2);
  assert.equal(context.likedTracks.length, 2);
});

test("hidden dock catches up to playback and controls before the stack returns", () => {
  const visibility = createSheetVisibility();
  const { elements, fill } = setup();
  mountDock(visibility);
  const previous = fill.style.transform;
  visibility.update(500, 500);
  context.position = 60000;
  context.playing = true;
  context.progress(context.position, 120000);
  context.change();
  assert.equal(fill.style.transform, previous);
  assert.equal(elements.play.classList.contains("is-playing"), false);

  const writes = [];
  let transform = fill.style.transform;
  Object.defineProperty(fill.style, "transform", {
    get: () => transform,
    set: (value) => {
      transform = value;
      writes.push({ value, catchingUp: elements.dock.classList.contains("is-catching-up") });
    },
  });
  visibility.update(499, 500);
  assert.equal(fill.style.transform, "scaleX(0.5)");
  assert.equal(elements["time-now-phone"].textContent, "60000");
  assert.equal(elements.play.classList.contains("is-playing"), true);
  assert.ok(writes.length > 0 && writes.every((write) => write.catchingUp));
  assert.equal(elements.dock.classList.contains("is-catching-up"), false);
  context.progress(90000, 120000);
  assert.equal(fill.style.transform, "scaleX(0.75)");
  assert.equal(writes.at(-1).catchingUp, false);
});

test("playback and seek previews update only the progress elements", () => {
  const { elements, windowEvents, fill, edge } = setup("desktop");
  mountDock();
  context.progress(30000, 120000);
  assert.equal(fill.style.transform, "scaleX(0.25)");
  assert.equal(edge.style.transform, "translateX(calc(25% - 0.125rem))");
  assert.equal(elements.dock.properties.has("--progress"), false);

  elements.dock.dispatch("pointerdown", pointer(elements.dock, 300, 100));
  assert.equal(fill.style.transform, "scaleX(0.75)");
  assert.equal(edge.style.transform, "translateX(calc(75% - 0.125rem))");
  context.progress(60000, 120000);
  assert.equal(fill.style.transform, "scaleX(0.75)");
  windowEvents.dispatch("pointercancel");
  assert.equal(fill.style.transform, `scaleX(${10000 / 120000})`);
  assert.equal(elements.dock.properties.has("--progress"), false);
});

test("reduced motion disables both progress transitions", async () => {
  const css = parse(await readFile(new URL("../src/styles/motion.css", import.meta.url), "utf8"));
  for (const selector of [".dock-fill", ".dock-edge"]) {
    const media = css.nodes.find((node) => node.type === "atrule" &&
      node.name === "media" && node.params === "(prefers-reduced-motion: reduce)" &&
      node.nodes.some((rule) => rule.type === "rule" && rule.selectors.includes(selector) &&
        rule.nodes.some((declaration) => declaration.prop === "transition" && declaration.value === "none")));
    const root = css.nodes.find((node) => node.type === "rule" &&
      node.selectors.includes(`:root.is-reduced-motion ${selector}`) &&
      node.nodes.some((declaration) => declaration.prop === "transition" && declaration.value === "none"));
    assert.ok(media, `Missing system reduced-motion rule for ${selector}`);
    assert.ok(root, `Missing app reduced-motion rule for ${selector}`);
  }
});

test("transport hover highlights are limited to non-touch devices", async () => {
  const css = await readFile(new URL("../src/styles/dock.css", import.meta.url), "utf8");
  const rules = parse(css).nodes.filter((node) => node.type === "rule");
  const hoverRules = rules.filter((rule) =>
    /\.icon(?:-pill|-main)?(?=[.:\s])/.test(rule.selector) && rule.selector.includes(":hover"),
  );
  assert.equal(hoverRules.length, 4);
  for (const rule of hoverRules) {
    assert.ok(rule.selector.startsWith(':root:not([data-touch="true"]) '), rule.selector);
  }

  const selected = rules.find((rule) => rule.selector === ".icon-pill.is-on svg");
  assert.ok(selected.nodes.some((node) => node.prop === "color" && node.value === "var(--accent)"));
});

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

test("the elapsed-time button is replaced by a text label on phones", async () => {
  const css = parse(await readFile(new URL("../src/styles/dock.css", import.meta.url), "utf8"));
  const rules = css.nodes.filter((node) => node.type === "rule");
  for (const [selector, display] of [
    [".time-phone", "none"],
    [':is([data-device="android"], [data-device="linuxPhone"]) .time-button', "none"],
    [':is([data-device="android"], [data-device="linuxPhone"]) .time-phone', "inline"],
  ]) {
    const rule = rules.find((node) => node.selector === selector);
    assert.equal(rule?.nodes.find((node) => node.prop === "display")?.value, display);
  }
});

test("touch seeking starts only above the control row", () => {
  for (const kind of ["android", "linuxPhone"]) {
    const { elements, controls, windowEvents } = setup(kind);
    mountDock();

    elements.dock.dispatch("pointerdown", pointer(elements.dock, 200, 119));
    assert.equal(elements.dock.classList.contains("is-scrubbing"), true);
    assert.equal(elements["time-now-phone"].textContent, "60000");
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
    const { elements, windowEvents } = setup();
    mountDock();
    const target = startY < 120 ? elements.play : elements.dock;
    elements.dock.dispatch("pointerdown", pointer(target, 200, startY));
    windowEvents.dispatch("pointermove", pointer(elements.dock, 200, startY - 70));
    assert.equal(elements.dock.classList.contains("is-scrubbing"), false);
    windowEvents.dispatch("pointerup", pointer(elements.dock, 200, startY - 70));
    assert.equal(sheetTravel(elements), 500);
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

test("activating the mini player with the progress bar does not preview or seek", () => {
  const { elements, windowEvents, fill } = setup("desktop");
  document.documentElement.classList.add("is-mini-player");
  mountDock();
  const progress = fill.style.transform;
  context.focused = false;
  windowEvents.dispatch("blur");
  context.focused = true;
  windowEvents.dispatch("focus", { timeStamp: 1000 });

  const first = { ...pointer(elements.dock, 300, 100), timeStamp: 1010 };
  windowEvents.dispatch("pointerdown", first);
  elements.dock.dispatch("pointerdown", first);
  windowEvents.dispatch("pointermove", pointer(elements.dock, 350, 100));
  windowEvents.dispatch("pointerup");
  assert.equal(fill.style.transform, progress);
  assert.equal(elements.dock.classList.contains("is-scrubbing"), false);
  assert.deepEqual(context.seeks, []);

  const second = { ...pointer(elements.dock, 300, 100), timeStamp: 1030 };
  windowEvents.dispatch("pointerdown", second);
  elements.dock.dispatch("pointerdown", second);
  assert.equal(fill.style.transform, "scaleX(0.75)");
  windowEvents.dispatch("pointerup");
  assert.deepEqual(context.seeks, [0.75]);
});

test("an unfocused press is ignored even if focus arrives after pointer-down", () => {
  const { elements, windowEvents, fill } = setup("desktop");
  document.documentElement.classList.add("is-mini-player");
  mountDock();
  const progress = fill.style.transform;
  context.focused = false;
  windowEvents.dispatch("blur");

  const first = { ...pointer(elements.dock, 300, 100), timeStamp: 1000 };
  windowEvents.dispatch("pointerdown", first);
  elements.dock.dispatch("pointerdown", first);
  context.focused = true;
  windowEvents.dispatch("focus", { timeStamp: 1010 });
  windowEvents.dispatch("pointerup");
  assert.equal(fill.style.transform, progress);
  assert.deepEqual(context.seeks, []);

  const second = { ...pointer(elements.dock, 300, 100), timeStamp: 1020 };
  windowEvents.dispatch("pointerdown", second);
  elements.dock.dispatch("pointerdown", second);
  windowEvents.dispatch("pointerup");
  assert.deepEqual(context.seeks, [0.75]);
});

test("mini-player focus protection leaves controls and established focus unaffected", () => {
  const { elements, windowEvents } = setup("desktop");
  document.documentElement.classList.add("is-mini-player");
  mountDock();
  windowEvents.dispatch("focus", { timeStamp: 1000 });

  const play = { ...pointer(elements.play, 200, 150), timeStamp: 1010 };
  windowEvents.dispatch("pointerdown", play);
  elements.dock.dispatch("pointerdown", play);
  elements.play.dispatch("click");
  assert.equal(context.toggles, 1);

  const seek = { ...pointer(elements.dock, 200, 100), timeStamp: 1020 };
  windowEvents.dispatch("pointerdown", seek);
  elements.dock.dispatch("pointerdown", seek);
  windowEvents.dispatch("pointerup");
  assert.deepEqual(context.seeks, [0.5]);

  windowEvents.dispatch("focus", { timeStamp: 2000 });
  windowEvents.dispatch("keydown");
  const keyboardFocus = { ...pointer(elements.dock, 100, 100), timeStamp: 2010 };
  windowEvents.dispatch("pointerdown", keyboardFocus);
  elements.dock.dispatch("pointerdown", keyboardFocus);
  windowEvents.dispatch("pointerup");
  assert.deepEqual(context.seeks, [0.5, 0.25]);

  windowEvents.dispatch("focus", { timeStamp: 3000 });
  const settledFocus = { ...pointer(elements.dock, 300, 100), timeStamp: 3200 };
  windowEvents.dispatch("pointerdown", settledFocus);
  elements.dock.dispatch("pointerdown", settledFocus);
  windowEvents.dispatch("pointerup");
  assert.deepEqual(context.seeks, [0.5, 0.25, 0.75]);
});

test("focus protection does not change normal desktop seeking", () => {
  const { elements, windowEvents } = setup("desktop");
  mountDock();
  windowEvents.dispatch("focus", { timeStamp: 1000 });
  const press = { ...pointer(elements.dock, 300, 100), timeStamp: 1010 };
  windowEvents.dispatch("pointerdown", press);
  elements.dock.dispatch("pointerdown", press);
  windowEvents.dispatch("pointerup");
  assert.deepEqual(context.seeks, [0.75]);
});

test("losing focus cancels an active mini-player scrub", () => {
  const { elements, windowEvents, fill } = setup("desktop");
  document.documentElement.classList.add("is-mini-player");
  mountDock();
  const progress = fill.style.transform;
  const press = { ...pointer(elements.dock, 300, 100), timeStamp: 1000 };
  windowEvents.dispatch("pointerdown", press);
  elements.dock.dispatch("pointerdown", press);
  assert.equal(fill.style.transform, "scaleX(0.75)");
  assert.equal(elements.dock.hasPointerCapture(1), true);

  context.focused = false;
  windowEvents.dispatch("blur");
  windowEvents.dispatch("pointerup");
  assert.equal(fill.style.transform, progress);
  assert.equal(elements.dock.classList.contains("is-scrubbing"), false);
  assert.equal(elements.dock.hasPointerCapture(1), false);
  assert.deepEqual(context.seeks, []);
});

test("non-primary mouse buttons do not preview or seek", () => {
  const { elements, windowEvents, fill } = setup("desktop");
  mountDock();
  const progress = fill.style.transform;

  for (const button of [1, 2]) {
    elements.dock.dispatch("pointerdown", { ...pointer(elements.dock, 300, 150), button });
    windowEvents.dispatch("pointermove", pointer(elements.dock, 350, 150));
    windowEvents.dispatch("pointerup", { ...pointer(elements.dock, 350, 150), button });
    assert.equal(elements.dock.classList.contains("is-scrubbing"), false);
    assert.equal(elements.dock.hasPointerCapture(1), false);
    assert.equal(fill.style.transform, progress);
    assert.deepEqual(context.seeks, []);
  }
});

test("the elapsed time opens the dialog on desktop without scrubbing", () => {
  const { elements, windowEvents } = setup("desktop");
  mountDock();
  elements.dock.dispatch("pointerdown", pointer(elements["time-now"], 20, 100));
  windowEvents.dispatch("pointerup");
  elements["time-now"].dispatch("click");
  assert.deepEqual(context.seeks, []);
  assert.equal(context.opens, 1);

  for (const kind of ["android", "linuxPhone"]) {
    const phone = setup(kind);
    mountDock();
    assert.equal(phone.elements["time-now-phone"].textContent, "10000");
    phone.elements["time-now"].dispatch("click");
    assert.equal(context.opens, 0);
  }
});

test("phone lyrics buttons activate on tap and keyboard", () => {
  for (const kind of ["android", "linuxPhone"]) {
    const { elements } = setup(kind);
    mountDock();
    const open = elements["dock-grab"];
    const close = elements["lyrics-grab"];
    const panel = elements["lyrics-panel"];
    assert.equal(panel.inert, true);
    assert.equal(open.attributes.get("aria-expanded"), "false");

    open.dispatch("click", { detail: 1 });
    assert.equal(sheetTravel(elements), 500);
    assert.equal(panel.inert, false);
    assert.equal(open.attributes.get("aria-expanded"), "true");
    close.dispatch("pointerdown", pointer(close, 200, 100));
    close.dispatch("pointerup", pointer(close, 200, 100));
    close.dispatch("click", { detail: 1 });
    assert.equal(sheetTravel(elements), 0);

    open.dispatch("click", { detail: 0 });
    assert.equal(sheetTravel(elements), 500);
    assert.equal(document.activeElement, close);
    close.dispatch("click", { detail: 0 });
    assert.equal(sheetTravel(elements), 0);
    assert.equal(panel.inert, true);
    assert.equal(document.activeElement, open);
  }
});

test("lyrics drags do not turn their trailing click into a button activation", () => {
  for (const kind of ["android", "linuxPhone"]) {
    const { elements, windowEvents } = setup(kind);
    mountDock();
    const open = elements["dock-grab"];
    const close = elements["lyrics-grab"];

    elements.dock.dispatch("pointerdown", pointer(open, 200, 110));
    windowEvents.dispatch("pointermove", pointer(open, 200, 90));
    windowEvents.dispatch("pointerup", pointer(open, 200, 90));
    assert.equal(sheetTravel(elements), 0);
    open.dispatch("click", { detail: 1 });
    assert.equal(sheetTravel(elements), 0);

    open.dispatch("click", { detail: 0 });
    close.dispatch("pointerdown", pointer(close, 200, 100));
    close.dispatch("pointermove", pointer(close, 200, 120));
    close.dispatch("pointerup", pointer(close, 200, 120));
    assert.equal(sheetTravel(elements), 500);
    close.dispatch("click", { detail: 1 });
    assert.equal(sheetTravel(elements), 500);
    close.dispatch("click", { detail: 0 });
    assert.equal(sheetTravel(elements), 0);
  }
});

test("a swipe started on a phone transport control does not click it", () => {
  const { elements, windowEvents } = setup("linuxPhone");
  mountDock();
  elements.dock.dispatch("pointerdown", pointer(elements.play, 200, 150));
  windowEvents.dispatch("pointermove", pointer(elements.play, 200, 80));
  windowEvents.dispatch("pointerup", pointer(elements.play, 200, 80));
  let prevented = false;
  elements.dock.dispatch("click", {
    target: elements.play,
    detail: 1,
    preventDefault: () => { prevented = true; },
    stopPropagation() {},
  });
  assert.equal(prevented, true);
  assert.equal(sheetTravel(elements), 500);
});
