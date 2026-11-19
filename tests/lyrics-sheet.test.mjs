import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const mocks = {
  "../lib/motion": `
    export const reduceMotionActive = () => globalThis.__lyricsSheetTest.reduced;
    export const subscribeMotion = (listener) => { globalThis.__lyricsSheetTest.motionChanged = listener; };
  `,
  "../lib/state": `
    export const getState = () => globalThis.__lyricsSheetTest.state;
    export const subscribe = (listener) => { globalThis.__lyricsSheetTest.stateChanged = listener; };
  `,
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "lyrics-sheet-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/]lyrics-sheet\.ts$/.test(importer) && source in mocks) {
        return `\0lyrics-sheet-test:${source}`;
      }
    },
    load(id) {
      if (id.startsWith("\0lyrics-sheet-test:")) return mocks[id.slice("\0lyrics-sheet-test:".length)];
    },
  }],
});
after(() => vite.close());

const { mountLyricsSheet } = await vite.ssrLoadModule("/src/ui/lyrics-sheet.ts");

class Element {
  listeners = new Map();
  properties = new Map();
  attributes = new Map();
  style = { setProperty: (name, value) => this.properties.set(name, value) };
  captures = new Set();

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  dispatch(type, values = {}) {
    const event = { type, button: 0, pointerId: 1, clientX: 100, clientY: 0, detail: 1, ...values };
    for (const handler of this.listeners.get(type) ?? []) handler(event);
    return event;
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  focus() { this.focused = true; }
}

test("the moving elements remain synchronized without per-frame layout reads", (t) => {
  const { context, stage, panel, dockGrab, dock, carousel, travel, advance } = setup(t);
  dockGrab.dispatch("click");
  const reads = context.heightReads;
  for (let frame = 0; frame < 10; frame += 1) {
    advance(16);
    assert.equal(dock.style.transform, `translateY(${-travel()}px)`);
    assert.equal(carousel.style.transform, dock.style.transform);
    assert.equal(panel.style.transform, `translateY(calc(100% - ${travel()}px))`);
  }
  assert.equal(context.heightReads, reads);
  assert.equal(stage.properties.has("--sheet-travel"), false);
});

function setup(t) {
  const context = { now: 0, reduced: false, state: { lyrics: [{ text: "line" }] } };
  globalThis.__lyricsSheetTest = context;
  t.mock.method(performance, "now", () => context.now);

  const stage = new Element();
  const topbar = new Element();
  topbar.offsetHeight = 40;
  const panel = new Element();
  let panelHeight = 600;
  context.heightReads = 0;
  Object.defineProperty(panel, "clientHeight", {
    get() { context.heightReads += 1; return panelHeight; },
    set(value) { panelHeight = value; },
  });
  const grab = new Element();
  const dockGrab = new Element();
  const dock = new Element();
  const carousel = new Element();
  const root = new Element();
  const frames = new Map();
  let frameId = 0;
  globalThis.document = {
    documentElement: root,
    querySelector: (selector) => ({ ".stage": stage, ".topbar": topbar })[selector] ?? null,
    getElementById: (id) => ({
      "lyrics-panel": panel, "lyrics-grab": grab, "dock-grab": dockGrab, dock, carousel,
    })[id] ?? null,
  };
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  globalThis.window = { cancelAnimationFrame: (id) => frames.delete(id) };
  globalThis.ResizeObserver = class {
    constructor(callback) { context.refit = callback; }
    observe() {}
  };

  const sheet = mountLyricsSheet();
  const travel = () => Number(panel.style.transform.match(/-\s*([\d.]+)px/)[1]);
  const advance = (ms) => {
    context.now += ms;
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(context.now);
  };
  const pointer = (type, clientY) => ({ type, clientY, clientX: 100, button: 0, pointerId: 1 });
  return { context, sheet, stage, panel, grab, dockGrab, dock, carousel, frames, travel, advance, pointer };
}

test("fast and slow upward swipes carry their own release velocity into the settle", (t) => {
  const run = (slow) => {
    const env = setup(t);
    const { sheet, advance, pointer, travel, frames, dockGrab } = env;
    sheet.press(pointer("pointerdown", 600));
    advance(slow ? 800 : 20);
    sheet.move(pointer("pointermove", slow ? 410 : 500));
    advance(slow ? 100 : 20);
    sheet.move(pointer("pointermove", 400));
    sheet.release(pointer("pointerup", 400));

    assert.equal(travel(), 200);
    assert.equal(dockGrab.attributes.get("aria-expanded"), "true");
    assert.equal(frames.size, 1);
    advance(1);
    const firstStep = travel() - 200;
    advance(1000);
    assert.equal(travel(), 600);
    assert.equal(frames.size, 0);
    return firstStep;
  };

  const fast = run(false);
  const slow = run(true);
  assert.ok(fast > 4 && fast < 6, `fast release moved ${fast}px`);
  assert.ok(slow > 0 && slow < 0.5, `slow release moved ${slow}px`);
  assert.ok(fast > slow * 5);
});

test("a downward swipe keeps its velocity and settles closed", (t) => {
  const { grab, dockGrab, panel, frames, travel, advance } = setup(t);
  dockGrab.dispatch("click");
  assert.equal(travel(), 0);
  assert.equal(panel.inert, false);
  advance(1000);
  assert.equal(travel(), 600);

  grab.dispatch("pointerdown", { clientY: 100 });
  advance(20);
  grab.dispatch("pointermove", { clientY: 200 });
  advance(20);
  grab.dispatch("pointermove", { clientY: 300 });
  grab.dispatch("pointerup", { clientY: 300 });
  assert.equal(travel(), 400);
  assert.equal(dockGrab.attributes.get("aria-expanded"), "false");
  advance(1);
  assert.ok(travel() < 396 && travel() > 394);
  advance(1000);
  assert.equal(travel(), 0);
  assert.equal(panel.inert, true);
  assert.equal(frames.size, 0);
});

test("holding still before release discards stale swipe momentum", (t) => {
  const { sheet, pointer, travel, advance } = setup(t);
  sheet.press(pointer("pointerdown", 600));
  advance(20);
  sheet.move(pointer("pointermove", 400));
  advance(150);
  sheet.release(pointer("pointerup", 400));
  advance(1);
  assert.ok(travel() > 200 && travel() < 200.1);
  advance(1000);
  assert.equal(travel(), 600);
});

test("a swipe that settles back reverses smoothly instead of snapping", (t) => {
  const { sheet, pointer, travel, advance } = setup(t);
  sheet.press(pointer("pointerdown", 600));
  advance(20);
  sheet.move(pointer("pointermove", 570));
  sheet.release(pointer("pointerup", 570));
  advance(1);
  assert.ok(travel() > 30);
  advance(1000);
  assert.equal(travel(), 0);
});

test("a new drag can interrupt a settling sheet without jumping", (t) => {
  const { sheet, grab, dockGrab, pointer, frames, travel, advance } = setup(t);
  dockGrab.dispatch("click");
  advance(100);
  const opening = travel();
  assert.ok(opening > 0 && opening < 600);
  grab.dispatch("pointerdown", { clientY: 100 });
  assert.equal(frames.size, 0);
  assert.equal(travel(), opening);
  grab.dispatch("pointermove", { clientY: 150 });
  assert.equal(travel(), opening - 50);
  grab.dispatch("pointerup", { clientY: 150 });
  advance(100);
  const closing = travel();
  assert.ok(closing < opening - 50);

  sheet.press(pointer("pointerdown", 600));
  assert.equal(frames.size, 0);
  assert.equal(travel(), closing);
  sheet.release(pointer("pointerup", 600));
  assert.equal(frames.size, 1);
  advance(1000);
  assert.equal(travel(), 0);
});

test("reduced motion finishes immediately, including when enabled mid-animation", (t) => {
  const { context, dockGrab, grab, frames, travel, advance } = setup(t);
  dockGrab.dispatch("click");
  advance(100);
  assert.ok(travel() > 0 && travel() < 600);
  context.reduced = true;
  context.motionChanged();
  assert.equal(travel(), 600);
  assert.equal(frames.size, 0);
  grab.dispatch("click");
  assert.equal(travel(), 0);
  assert.equal(frames.size, 0);
});

test("resizing during a settle preserves the current position and reaches the new height", (t) => {
  const { context, dockGrab, panel, travel, advance } = setup(t);
  dockGrab.dispatch("click");
  advance(100);
  const before = travel();
  panel.clientHeight = 750;
  context.refit();
  assert.equal(travel(), before);
  advance(1000);
  assert.equal(travel(), 750);
  panel.clientHeight = 500;
  context.refit();
  assert.equal(travel(), 500);
});

test("cancelled drags and disappearing lyrics do not leave the sheet stuck", (t) => {
  const { context, sheet, pointer, frames, travel, advance } = setup(t);
  sheet.press(pointer("pointerdown", 600));
  advance(20);
  sheet.move(pointer("pointermove", 400));
  sheet.release(pointer("pointercancel", 400));
  advance(1);
  assert.ok(travel() > 200 && travel() < 200.1);
  advance(1000);
  assert.equal(travel(), 600);

  context.state.lyrics = [];
  context.stateChanged();
  advance(1000);
  assert.equal(travel(), 0);
  assert.equal(frames.size, 0);
});
