import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const mocks = {
  "../lib/device": 'export const device = () => globalThis.__lyricsScrubTest.device;',
  "../lib/format": "export const escapeHtml = (value) => value; export const joinMeta = () => '';",
  "../lib/motion": `
    export const reduceMotionActive = () => globalThis.__lyricsScrubTest.reduced;
    export const subscribeMotion = (callback) => { globalThis.__lyricsScrubTest.motionChanged = callback; };
  `,
  "../lib/state": `
    const context = () => globalThis.__lyricsScrubTest;
    export const currentTrack = () => context().track;
    export const getState = () => context().state;
    export const ensureColour = () => {};
    export const ensureLyrics = (track) => context().loadLyrics?.(track);
    export const toggleLibrary = () => {};
    export const subscribe = (callback) => { context().render = callback; };
    export const player = {
      snapshot: () => ({ ...context().navigation, positionMs: context().position, sourceName: "All" }),
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
    this.attributes = new Map();
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
  querySelectorAll(selector) {
    if (selector === "[id]") return this.clonedTrack ? [this.clonedTrack] : [];
    return this.lines;
  }
  querySelector(selector) { return selector === ".lyrics-track" ? this.clonedTrack : null; }
  closest() { return null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  cloneNode() {
    const clone = new Element();
    clone.clonedTrack = new Element();
    return clone;
  }
  append(child) { child.parent = this; }
  remove() { this.removed = true; }
  animate(keyframes, options) {
    const animation = { keyframes, options, element: this, cancelled: false, cancel() { this.cancelled = true; } };
    globalThis.__lyricsScrubTest.animations.push(animation);
    return animation;
  }
}

function setup(t, heights = [], device = "android") {
  const lyrics = Array.from({ length: 12 }, (_, index) => ({ timeMs: 2000 + index * 6000, text: `line ${index}` }));
  const context = {
    now: 0,
    heights,
    reduced: false,
    device,
    renderedOffset: null,
    position: 2000,
    seeks: [],
    animations: [],
    navigation: { sourceId: "all", order: ["track", "second", "third"], cursor: 0, travel: 0, repeat: "off" },
    track: { id: "track", title: "Song", artist: "Artist", album: null, year: null },
    state: { lyrics, lyricsLoading: false, tracks: [{}], libraryOpen: false },
  };
  globalThis.__lyricsScrubTest = context;
  t.mock.method(performance, "now", () => context.now);

  const ids = ["hero", "now-cover", "now-source", "now-title", "now-artist", "now-meta", "lyrics-panel", "lyrics-page", "lyrics"];
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

function loadOnTrackChange(context) {
  context.loadLyrics = () => {
    context.state.lyrics = [];
    context.state.lyricsLoading = true;
    context.render();
  };
}

function changeTrack(context, id, cursor, travel) {
  context.track = { ...context.track, id };
  context.navigation.cursor = cursor;
  context.navigation.travel = travel;
  context.render();
}

function finishLoading(context, lyrics = [{ timeMs: 0, text: "new lyric" }]) {
  context.state.lyrics = lyrics;
  context.state.lyricsLoading = false;
  context.render();
}

test("new lyrics enter from the next track's side and old lyrics leave in the opposite direction", (t) => {
  const { context, elements, panel } = setup(t);
  panel.inert = false;
  loadOnTrackChange(context);
  panel.dispatch("pointerdown");
  assert.equal(panel.hasPointerCapture(1), true);

  changeTrack(context, "second", 1, 1);
  assert.equal(panel.hidden, false);
  assert.equal(panel.hasPointerCapture(1), false);
  assert.equal(context.animations.length, 1);
  assert.deepEqual(context.animations[0].keyframes, [
    { transform: "translateX(0)" }, { transform: "translateX(-100%)" },
  ]);
  assert.equal(context.animations[0].element.attributes.get("aria-hidden"), "true");

  finishLoading(context);
  assert.deepEqual(context.animations[1].keyframes, [
    { transform: "translateX(100%)" }, { transform: "translateX(0)" },
  ]);
  assert.equal(context.animations[1].element, elements["lyrics-page"]);
  context.animations[0].onfinish();
  assert.equal(context.animations[0].element.removed, true);

  changeTrack(context, "track", 0, 0);
  assert.deepEqual(context.animations[2].keyframes, [
    { transform: "translateX(0)" }, { transform: "translateX(100%)" },
  ]);
  finishLoading(context);
  assert.deepEqual(context.animations[3].keyframes, [
    { transform: "translateX(-100%)" }, { transform: "translateX(0)" },
  ]);
});

test("repeat wrapping follows actual next and previous travel", (t) => {
  const { context, panel } = setup(t);
  panel.inert = false;
  context.navigation.repeat = "all";
  context.render();
  loadOnTrackChange(context);

  changeTrack(context, "third", 2, -1);
  assert.equal(context.animations[0].keyframes[1].transform, "translateX(100%)");
  finishLoading(context);
  assert.equal(context.animations[1].keyframes[0].transform, "translateX(-100%)");

  changeTrack(context, "track", 0, 0);
  assert.equal(context.animations[2].keyframes[1].transform, "translateX(-100%)");
  finishLoading(context);
  assert.equal(context.animations[3].keyframes[0].transform, "translateX(100%)");
});

test("direct queue jumps use the nearest side when repeat is enabled", (t) => {
  const { context, panel } = setup(t);
  panel.inert = false;
  context.navigation.repeat = "all";
  context.render();
  loadOnTrackChange(context);
  changeTrack(context, "third", 2, 0);
  finishLoading(context);
  assert.equal(context.animations[0].keyframes[1].transform, "translateX(100%)");
  assert.equal(context.animations[1].keyframes[0].transform, "translateX(-100%)");
});

test("rapid track changes discard old slides and animate the latest lyrics", (t) => {
  const { context, panel } = setup(t);
  panel.inert = false;
  loadOnTrackChange(context);
  changeTrack(context, "second", 1, 1);
  changeTrack(context, "third", 2, 2);
  assert.equal(context.animations[0].cancelled, true);
  assert.equal(context.animations[0].element.removed, true);
  assert.equal(context.animations.length, 2);
  finishLoading(context);
  assert.equal(context.animations[2].keyframes[0].transform, "translateX(100%)");
});

test("a missing lyric result does not slide in stale content", (t) => {
  const { context, panel } = setup(t);
  panel.inert = false;
  loadOnTrackChange(context);
  changeTrack(context, "second", 1, 1);
  finishLoading(context, []);
  assert.equal(panel.hidden, false);
  assert.equal(context.animations.length, 1);
  context.state.lyrics = [{ timeMs: 0, text: "edited lyric" }];
  context.render();
  assert.equal(context.animations.length, 1);
});

test("closed sheets, desktop layouts and reduced motion do not slide", (t) => {
  for (const mode of ["closed", "desktop", "reduced"]) {
    const { context, panel } = setup(t, [], mode === "desktop" ? "desktop" : "android");
    panel.inert = mode === "closed";
    context.reduced = mode === "reduced";
    loadOnTrackChange(context);
    changeTrack(context, "second", 1, 1);
    finishLoading(context);
    assert.equal(context.animations.length, 0, mode);
  }
});

test("enabling reduced motion cancels a slide in progress", (t) => {
  const { context, panel } = setup(t);
  panel.inert = false;
  loadOnTrackChange(context);
  changeTrack(context, "second", 1, 1);
  context.reduced = true;
  context.motionChanged();
  assert.equal(context.animations[0].cancelled, true);
  assert.equal(context.animations[0].element.removed, true);
  finishLoading(context);
  assert.equal(context.animations.length, 1);
});
