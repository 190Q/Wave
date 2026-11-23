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
    export const currentTrack = () => globalThis.__lyricsSheetTest.track;
    export const subscribe = (listener) => { globalThis.__lyricsSheetTest.stateChanged = listener; };
    export const player = { onChange: (listener) => { globalThis.__lyricsSheetTest.trackChanged = listener; } };
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
  attributeWrites = 0;
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
  setAttribute(name, value) { this.attributeWrites += 1; this.attributes.set(name, value); }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  focus() { this.focused = true; }
}

function setup(t, { resizeObserver = true, initialHeight = 600 } = {}) {
  const context = { now: 0, reduced: false, track: { id: "one" }, state: { lyrics: [{ text: "line" }], lyricsLoading: false } };
  globalThis.__lyricsSheetTest = context;
  t.mock.method(performance, "now", () => context.now);

  const stage = new Element();
  const topbar = new Element();
  topbar.offsetHeight = 40;
  const panel = new Element();
  let panelHeight = initialHeight;
  context.heightReads = 0;
  context.inertWrites = 0;
  Object.defineProperty(panel, "clientHeight", {
    get() { context.heightReads += 1; return panelHeight; },
    set(value) { panelHeight = value; },
  });
  Object.defineProperty(panel, "inert", {
    get() { return context.inert; },
    set(value) { context.inertWrites += 1; context.inert = value; },
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
  globalThis.window = {
    cancelAnimationFrame: (id) => frames.delete(id),
    addEventListener: (type, callback) => { if (type === "resize") context.refit = callback; },
  };
  globalThis.ResizeObserver = resizeObserver ? class {
    constructor(callback) { context.refit = callback; }
    observe() {}
  } : undefined;

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

test("the moving elements stay synchronized without per-frame layout or accessibility writes", (t) => {
  const { context, stage, panel, dockGrab, dock, carousel, travel, advance } = setup(t);
  dockGrab.dispatch("click");
  const reads = context.heightReads;
  const inertWrites = context.inertWrites;
  const attributeWrites = dockGrab.attributeWrites;
  for (let frame = 0; frame < 10; frame += 1) {
    advance(16);
    assert.equal(dock.style.transform, `translateY(${-travel()}px)`);
    assert.equal(carousel.style.transform, dock.style.transform);
    assert.equal(panel.style.transform, `translateY(calc(100% - ${travel()}px))`);
  }
  assert.equal(context.heightReads, reads);
  assert.equal(context.inertWrites, inertWrites);
  assert.equal(dockGrab.attributeWrites, attributeWrites);
  assert.equal(stage.properties.has("--sheet-travel"), false);
});

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

test("fast releases near either endpoint decelerate instead of stopping in two frames", (t) => {
  for (const direction of ["open", "close"]) {
    const { sheet, grab, dockGrab, pointer, travel, advance } = setup(t);
    if (direction === "open") {
      sheet.press(pointer("pointerdown", 600));
      advance(20);
      sheet.move(pointer("pointermove", 500));
      advance(80);
      sheet.move(pointer("pointermove", 100));
      sheet.release(pointer("pointerup", 100));
    } else {
      dockGrab.dispatch("click");
      advance(1000);
      grab.dispatch("pointerdown", { clientY: 0 });
      advance(20);
      grab.dispatch("pointermove", { clientY: 100 });
      advance(80);
      grab.dispatch("pointermove", { clientY: 500 });
      grab.dispatch("pointerup", { clientY: 500 });
    }
    const remaining = () => direction === "open" ? 600 - travel() : travel();
    const distances = [remaining()];
    for (let i = 0; i < 3; i += 1) {
      advance(16);
      distances.push(remaining());
    }
    assert.ok(distances[3] > 1, `${direction}: ${distances}`);
    const steps = distances.slice(1).map((distance, index) => distances[index] - distance);
    assert.ok(steps[0] > steps[1] && steps[1] > steps[2] && steps[2] > 0, `${direction}: ${steps}`);
    advance(1000);
    assert.equal(remaining(), 0);
  }
});

test("a slow release accelerates gradually instead of surging immediately", (t) => {
  const { sheet, pointer, travel, advance } = setup(t);
  sheet.press(pointer("pointerdown", 600));
  advance(20);
  sheet.move(pointer("pointermove", 400));
  advance(150);
  sheet.release(pointer("pointerup", 400));
  advance(16);
  assert.ok(travel() > 200 && travel() < 206, `first frame: ${travel()}`);
  advance(1000);
  assert.equal(travel(), 600);
});

test("a release moving away from its target slows before reversing at the edge", (t) => {
  const { sheet, pointer, travel, advance } = setup(t);
  sheet.press(pointer("pointerdown", 600));
  advance(20);
  sheet.move(pointer("pointermove", 60));
  advance(100);
  sheet.move(pointer("pointermove", 560));
  sheet.release(pointer("pointerup", 560));
  advance(8);
  assert.ok(travel() > 0 && travel() < 40, `first frame: ${travel()}`);
  advance(8);
  assert.ok(travel() > 0 && travel() < 40, `second frame: ${travel()}`);
  advance(1000);
  assert.equal(travel(), 600);
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

test("resizing while dragging updates the travel limit", (t) => {
  const { context, sheet, panel, pointer, travel, advance } = setup(t);
  sheet.press(pointer("pointerdown", 600));
  sheet.move(pointer("pointermove", 400));
  panel.clientHeight = 250;
  context.refit();
  sheet.move(pointer("pointermove", 200));
  assert.equal(travel(), 250);
  sheet.release(pointer("pointerup", 200));
  advance(1000);
  assert.equal(travel(), 250);
});

test("a previously hidden panel is measured when opened", (t) => {
  const { panel, dockGrab, travel, advance } = setup(t, { initialHeight: 0 });
  panel.clientHeight = 600;
  dockGrab.dispatch("click");
  advance(1000);
  assert.equal(travel(), 600);
});

test("window resize updates the sheet when ResizeObserver is unavailable", (t) => {
  const { context, panel, dockGrab, travel, advance } = setup(t, { resizeObserver: false });
  dockGrab.dispatch("click");
  advance(1000);
  panel.clientHeight = 700;
  context.refit();
  assert.equal(travel(), 700);
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
  context.state.lyricsLoading = true;
  context.stateChanged();
  advance(1000);
  assert.equal(travel(), 600);

  context.state.lyricsLoading = false;
  context.stateChanged();
  advance(1000);
  assert.equal(travel(), 0);
  assert.equal(frames.size, 0);

  context.state.lyricsLoading = true;
  context.stateChanged();
  context.state.lyrics = [{ text: "new line" }];
  context.state.lyricsLoading = false;
  context.stateChanged();
  advance(1000);
  assert.equal(travel(), 600);
});

test("manual closing while lyrics load prevents automatic reopening", (t) => {
  const { context, dockGrab, grab, travel, advance } = setup(t);
  dockGrab.dispatch("click");
  advance(1000);
  context.state.lyrics = [];
  context.state.lyricsLoading = true;
  context.stateChanged();
  grab.dispatch("click");
  advance(1000);
  assert.equal(travel(), 0);
  context.state.lyricsLoading = false;
  context.stateChanged();
  context.state.lyrics = [{ text: "new line" }];
  context.stateChanged();
  advance(1000);
  assert.equal(travel(), 0);
});

test("a sheet that was never opened stays closed when lyrics return", (t) => {
  const { context, travel, advance } = setup(t);
  context.state.lyrics = [];
  context.stateChanged();
  context.state.lyrics = [{ text: "new line" }];
  context.stateChanged();
  advance(1000);
  assert.equal(travel(), 0);
});

test("lyrics returning during automatic closing reverse the sheet smoothly", (t) => {
  const { context, dockGrab, travel, advance } = setup(t);
  dockGrab.dispatch("click");
  advance(1000);
  context.state.lyrics = [];
  context.stateChanged();
  advance(100);
  const closing = travel();
  assert.ok(closing > 0 && closing < 600);
  context.state.lyrics = [{ text: "new line" }];
  context.stateChanged();
  assert.equal(travel(), closing);
  advance(1000);
  assert.equal(travel(), 600);
});

test("removing the current track forgets the open preference", (t) => {
  const { context, dockGrab, travel, advance } = setup(t);
  dockGrab.dispatch("click");
  advance(1000);
  context.track = null;
  context.trackChanged();
  advance(1000);
  assert.equal(travel(), 0);
  context.track = { id: "new" };
  context.trackChanged();
  advance(1000);
  assert.equal(travel(), 0);
});
