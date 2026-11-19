import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const mocks = {
  "../lib/device": 'export const device = () => "android";',
  "../lib/format": "export const escapeHtml = (value) => value; export const joinMeta = () => '';",
  "../lib/motion": "export const reduceMotionActive = () => globalThis.__lyricsScrubTest.reduced;",
  "../lib/state": `
    const context = () => globalThis.__lyricsScrubTest;
    export const currentTrack = () => context().track;
    export const getState = () => context().state;
    export const ensureColour = () => {};
    export const ensureLyrics = () => {};
    export const toggleLibrary = () => {};
    export const subscribe = (callback) => { context().render = callback; };
    export const player = {
      snapshot: () => ({ positionMs: context().position, sourceName: "All" }),
      seek: (position) => {
        context().position = position;
        context().seeks.push(position);
        context().progress?.(position);
      },
      onChange: () => {},
      onProgress: (callback) => { context().progress = callback; },
    };
  `,
  "./artwork": 'export const plainCoverStyle = () => "";',
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "lyrics-scrub-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/]hero\.ts$/.test(importer) && source in mocks) {
        return `\0lyrics-scrub-test:${source}`;
      }
    },
    load(id) {
      if (id.startsWith("\0lyrics-scrub-test:")) return mocks[id.slice("\0lyrics-scrub-test:".length)];
    },
  }],
});
after(() => vite.close());
const { mountHero } = await vite.ssrLoadModule("/src/ui/hero.ts");

class Element {
  constructor() {
    this.listeners = new Map();
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, enabled) => {
        const next = enabled ?? !this.classes.has(name);
        if (next) this.classes.add(name);
        else this.classes.delete(name);
        return next;
      },
    };
    this.style = { setProperty() {}, transform: "" };
    this.clientHeight = 720;
    this.clientWidth = 360;
    this.scrollHeight = 48;
    this.offsetHeight = 48;
    this.captures = new Set();
    this.lines = [];
  }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  dispatch(type, values = {}) {
    const event = { type, button: 0, pointerId: 1, clientY: 400, target: this, ...values };
    for (const callback of this.listeners.get(type) ?? []) callback(event);
    return event;
  }
  set innerHTML(html) {
    let top = 0;
    this.lines = [...html.matchAll(/<p class="lyric">/g)].map((_, index) => {
      const line = new Element();
      line.offsetTop = top;
      line.offsetHeight = globalThis.__lyricsScrubTest.heights?.[index] ?? 48;
      top += line.offsetHeight;
      return line;
    });
  }
  querySelectorAll() { return this.lines; }
  closest() { return null; }
  setAttribute() {}
  removeAttribute() {}
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
}

function setup(t, heights = []) {
  const lyrics = Array.from({ length: 12 }, (_, index) => ({ timeMs: 2000 + index * 6000, text: `line ${index}` }));
  const context = {
    now: 0,
    heights,
    reduced: false,
    renderedOffset: null,
    position: 2000,
    seeks: [],
    track: { id: "track", title: "Song", artist: "Artist", album: null, year: null },
    state: { lyrics, tracks: [{}], libraryOpen: false },
  };
  globalThis.__lyricsScrubTest = context;
  t.mock.method(performance, "now", () => context.now);

  const ids = ["hero", "now-cover", "now-source", "now-title", "now-artist", "now-meta", "lyrics-panel", "lyrics"];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  const root = new Element();
  const frames = new Map();
  let frameId = 0;
  globalThis.document = {
    documentElement: root,
    getElementById: (id) => elements[id] ?? null,
    querySelector: () => null,
    createRange: () => ({ selectNodeContents() {}, getClientRects: () => [{}] }),
  };
  globalThis.window = {
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  globalThis.ResizeObserver = undefined;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  globalThis.getComputedStyle = (element) => ({
    fontSize: "16px",
    paddingLeft: "0px",
    paddingRight: "0px",
    marginTop: "0px",
    marginBottom: "0px",
    transform: element === elements.lyrics
      ? `matrix(1, 0, 0, 1, 0, ${context.renderedOffset ?? (parseFloat(element.style.transform.slice(11)) || 0)})`
      : "none",
  });
  globalThis.DOMMatrixReadOnly = class {
    constructor(value) { this.m42 = Number(value.match(/,\s*([-\d.]+)\)$/)[1]); }
  };

  mountHero();
  const track = elements.lyrics;
  const panel = elements["lyrics-panel"];
  const offset = () => -parseFloat(track.style.transform.slice(11));
  const advance = (ms) => {
    context.now += ms;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(context.now);
  };
  return { context, elements, panel, track, frames, offset, advance };
}

test("lyric text follows the finger immediately and seeks as lines pass", (t) => {
  const { context, panel, offset, advance } = setup(t);
  assert.equal(offset(), 24);
  panel.dispatch("pointerdown", { clientY: 400 });
  advance(40);
  panel.dispatch("pointermove", { clientY: 340 });
  assert.equal(offset(), 84);
  assert.equal(context.seeks.at(-1), context.state.lyrics[1].timeMs);
  panel.dispatch("pointerup", { clientY: 340 });
  assert.equal(offset(), 84);
  advance(1);
  assert.ok(offset() > 85 && offset() < 86);
  advance(1000);
  assert.ok(!panel.classList.contains("is-scrubbing"));
  assert.equal(context.position, context.seeks.at(-1));
});

test("dragging follows pixel distance across uneven lyric heights", (t) => {
  const { context, elements, panel, offset, advance } = setup(t, [48, 96, 48, 72]);
  panel.dispatch("pointerdown", { clientY: 400 });
  advance(50);
  panel.dispatch("pointermove", { clientY: 300 });
  assert.equal(offset(), 124);
  assert.equal(context.seeks.at(-1), context.state.lyrics[1].timeMs);
  panel.dispatch("pointerup", { clientY: 300 });
  advance(1000);
  const active = context.state.lyrics.findIndex((line) => line.timeMs === context.position);
  assert.ok(active >= 0);
  const line = elements.lyrics.lines[active];
  assert.ok(Math.abs(offset() - line.offsetTop - line.offsetHeight / 2) < 0.001);
});

test("fast and slow releases start at their measured drag speeds", (t) => {
  const swipe = (slow) => {
    const { panel, offset, advance } = setup(t);
    panel.dispatch("pointerdown", { clientY: 400 });
    advance(slow ? 800 : 20);
    panel.dispatch("pointermove", { clientY: slow ? 310 : 350 });
    advance(slow ? 100 : 20);
    panel.dispatch("pointermove", { clientY: 300 });
    assert.equal(offset(), 124);
    panel.dispatch("pointerup", { clientY: 300 });
    assert.equal(offset(), 124);
    advance(1);
    return offset() - 124;
  };

  const fast = swipe(false);
  const slow = swipe(true);
  assert.ok(fast > 2 && fast < 3, `fast release moved ${fast}px`);
  assert.ok(slow > 0 && slow < 0.3, `slow release moved ${slow}px`);
  assert.ok(fast > slow * 5);
});

test("a fast release decelerates smoothly instead of snapping to a line", (t) => {
  const { panel, offset, advance } = setup(t);
  panel.dispatch("pointerdown", { clientY: 400 });
  advance(20);
  panel.dispatch("pointermove", { clientY: 350 });
  advance(20);
  panel.dispatch("pointermove", { clientY: 300 });
  panel.dispatch("pointerup", { clientY: 300 });

  let previous = offset();
  let previousStep = Infinity;
  for (let frame = 0; frame < 8; frame += 1) {
    advance(16);
    const next = offset();
    const step = next - previous;
    assert.ok(step > 0 && step <= previousStep && step < 45, `frame ${frame} moved ${step}px`);
    previous = next;
    previousStep = step;
  }
  assert.ok(panel.classList.contains("is-scrubbing"));
  advance(1000);
  assert.ok(!panel.classList.contains("is-scrubbing"));
});

test("downward dragging follows the finger and continues in the same direction", (t) => {
  const { context, panel, offset, advance } = setup(t);
  context.progress(context.state.lyrics[7].timeMs);
  assert.equal(offset(), 360);
  panel.dispatch("pointerdown", { clientY: 250 });
  advance(20);
  panel.dispatch("pointermove", { clientY: 300 });
  advance(20);
  panel.dispatch("pointermove", { clientY: 350 });
  assert.equal(offset(), 260);
  panel.dispatch("pointerup", { clientY: 350 });
  advance(1);
  assert.ok(offset() < 258 && offset() > 257);
  advance(1000);
  assert.ok(offset() < 260);
  assert.ok(context.seeks.at(-1) < context.state.lyrics[7].timeMs);
});

test("grabbing during a playback transition keeps the visible position", (t) => {
  const { context, panel, offset } = setup(t);
  context.progress(context.state.lyrics[4].timeMs);
  assert.equal(offset(), 216);
  context.renderedOffset = -110;
  panel.dispatch("pointerdown", { clientY: 400 });
  assert.ok(Math.abs(offset() - 110) < 0.001);
  panel.dispatch("pointermove", { clientY: 380 });
  assert.ok(Math.abs(offset() - 130) < 0.001);
});

test("holding still before release removes stale momentum", (t) => {
  const { panel, offset, advance } = setup(t);
  panel.dispatch("pointerdown", { clientY: 400 });
  advance(20);
  panel.dispatch("pointermove", { clientY: 340 });
  advance(150);
  panel.dispatch("pointerup", { clientY: 340 });
  advance(1);
  assert.ok(offset() < 84 && offset() > 83.99);
  advance(1000);
  assert.equal(offset(), 72);
});

test("sparse touch events retain the recent swipe direction on release", (t) => {
  const { panel, offset, advance } = setup(t);
  panel.dispatch("pointerdown", { clientY: 400 });
  advance(100);
  panel.dispatch("pointermove", { clientY: 340 });
  advance(40);
  panel.dispatch("pointerup", { clientY: 340 });
  advance(1);
  assert.ok(offset() > 84);
  advance(1000);
  assert.ok(offset() > 84);
});

test("re-grabbing during a settle starts from the current visible position", (t) => {
  const { panel, frames, offset, advance } = setup(t);
  panel.dispatch("pointerdown", { clientY: 400 });
  advance(40);
  panel.dispatch("pointermove", { clientY: 300 });
  panel.dispatch("pointerup", { clientY: 300 });
  advance(40);
  const before = offset();
  assert.equal(frames.size, 1);
  panel.dispatch("pointerdown", { clientY: 300 });
  assert.equal(frames.size, 0);
  assert.ok(Math.abs(offset() - before) < 0.001);
  panel.dispatch("pointermove", { clientY: 280 });
  assert.ok(Math.abs(offset() - before - 20) < 0.001);
});

test("reduced motion and cancelled gestures settle without momentum", (t) => {
  const { context, panel, frames, offset, advance } = setup(t);
  panel.dispatch("pointerdown", { clientY: 400 });
  advance(20);
  panel.dispatch("pointermove", { clientY: 340 });
  context.reduced = true;
  panel.dispatch("pointercancel", { clientY: 340 });
  assert.equal(offset(), 72);
  assert.equal(frames.size, 0);
  assert.ok(!panel.classList.contains("is-scrubbing"));
});

test("dragging back from the last lyric seeks earlier without getting stuck", (t) => {
  const { context, panel, offset, advance } = setup(t);
  const last = context.state.lyrics.at(-1);
  context.progress(last.timeMs);
  assert.equal(offset(), 552);
  panel.dispatch("pointerdown", { clientY: 300 });
  advance(40);
  panel.dispatch("pointermove", { clientY: 400 });
  panel.dispatch("pointerup", { clientY: 400 });
  advance(1000);
  assert.ok(offset() < 552);
  assert.ok(context.seeks.at(-1) < last.timeMs);
});

test("changing tracks during a drag cancels its pointer capture", (t) => {
  const { context, panel, frames, advance } = setup(t);
  panel.dispatch("pointerdown");
  advance(20);
  panel.dispatch("pointermove", { clientY: 340 });
  assert.equal(panel.hasPointerCapture(1), true);
  context.state.lyrics = [{ timeMs: 2000, text: "new" }];
  context.render();
  assert.equal(panel.hasPointerCapture(1), false);
  panel.dispatch("pointerup", { clientY: 340 });
  assert.equal(frames.size, 0);
});

test("wheel scrolling still chases and seeks to the next line", (t) => {
  const { context, panel, offset, advance } = setup(t);
  let prevented = false;
  panel.dispatch("wheel", { deltaY: 100, deltaMode: 0, preventDefault: () => { prevented = true; } });
  assert.ok(prevented);
  advance(50);
  assert.ok(offset() > 24 && offset() < 72);
  advance(1000);
  assert.equal(offset(), 72);
  assert.equal(context.seeks.at(-1), context.state.lyrics[1].timeMs);
});
