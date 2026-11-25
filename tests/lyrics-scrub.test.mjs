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
      next: () => context().step(1),
      previous: () => context().step(-1),
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
const { createSheetVisibility } = await vite.ssrLoadModule("/src/ui/sheet-visibility.ts");

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
    const event = { type, button: 0, pointerId: 1, clientX: 200, clientY: 400, target: this, ...values };
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

function setup(t, heights = [], device = "android", visibility) {
  const lyrics = Array.from({ length: 12 }, (_, index) => ({ timeMs: 2000 + index * 6000, text: `line ${index}` }));
  const context = {
    now: 0,
    heights,
    reduced: false,
    device,
    renderedOffset: null,
    renderedPageOffset: null,
    position: 2000,
    seeks: [],
    animations: [],
    steps: [],
    measurements: 0,
    navigation: { sourceId: "all", order: ["track", "second", "third"], cursor: 0, travel: 0, repeat: "off" },
    track: { id: "track", title: "Song", artist: "Artist", album: null, year: null },
    state: { lyrics, lyricsLoading: false, tracks: [{}], libraryOpen: false },
  };
  context.step = (direction) => {
    context.steps.push(direction);
    const { order, cursor, repeat } = context.navigation;
    const index = repeat === "off" ? cursor + direction : (cursor + direction + order.length) % order.length;
    if (index < 0 || index >= order.length) return;
    context.navigation.cursor = index;
    context.navigation.travel += direction;
    context.track = { ...context.track, id: order[index] };
    context.render();
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
    createRange: () => ({
      selectNodeContents() {},
      getClientRects: () => {
        context.measurements += 1;
        return [{}];
      },
    }),
  };
  globalThis.window = {
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  globalThis.ResizeObserver = class {
    constructor(callback) { context.resize = callback; }
    observe() {}
  };
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
      : element === elements["lyrics-page"] && context.renderedPageOffset !== null
        ? `matrix(1, 0, 0, 1, ${context.renderedPageOffset}, 0)`
        : "none",
  });
  globalThis.DOMMatrixReadOnly = class {
    constructor(value) {
      const parts = value.match(/matrix\((.+)\)/)[1].split(",").map(Number);
      this.m41 = parts[4];
      this.m42 = parts[5];
    }
  };

  mountHero(visibility);
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

test("pressing before the first lyric does not highlight it or seek", (t) => {
  for (const device of ["android", "linuxPhone", "desktop"]) {
    for (const action of ["tap", "jitter", "backward", "cancel", ...(device === "desktop" ? [] : ["sideways"])]) {
      const { context, panel, track, advance } = setup(t, [], device);
      context.position = 0;
      context.progress(0);
      assert.equal(track.lines[0].classList.contains("is-active"), false);
      panel.dispatch("pointerdown");
      assert.equal(track.lines[0].classList.contains("is-active"), false, `${device} ${action}`);
      if (action === "jitter") panel.dispatch("pointermove", { clientY: 396 });
      if (action === "backward") panel.dispatch("pointermove", { clientY: 440 });
      if (action === "sideways") {
        panel.dispatch("pointermove", { clientX: 180 });
        advance(16);
      }
      panel.dispatch(action === "cancel" ? "pointercancel" : "pointerup", {
        clientY: action === "backward" ? 440 : action === "jitter" ? 396 : 400,
        clientX: action === "sideways" ? 180 : 200,
      });
      advance(1000);
      assert.equal(track.lines[0].classList.contains("is-active"), false, `${device} ${action}`);
      assert.deepEqual(context.seeks, [], `${device} ${action}`);
      assert.equal(context.position, 0, `${device} ${action}`);
      panel.dispatch("pointerdown");
      assert.equal(track.lines[0].classList.contains("is-active"), false, `${device} ${action} again`);
      panel.dispatch("pointercancel");
    }
  }
});

test("scrolling forward before the first lyric selects and seeks to it", (t) => {
  const { context, panel, track } = setup(t);
  context.position = 0;
  context.progress(0);
  panel.dispatch("pointerdown");
  panel.dispatch("pointermove", { clientY: 380 });
  assert.equal(track.lines[0].classList.contains("is-active"), true);
  assert.equal(context.seeks.at(-1), context.state.lyrics[0].timeMs);
});

test("playback can reach the first lyric while a stationary press is held", (t) => {
  const { context, panel, track } = setup(t);
  context.position = 0;
  context.progress(0);
  panel.dispatch("pointerdown");
  context.position = context.state.lyrics[0].timeMs;
  context.progress(context.position);
  assert.equal(track.lines[0].classList.contains("is-active"), false);
  panel.dispatch("pointerup");
  assert.equal(track.lines[0].classList.contains("is-active"), true);
  assert.deepEqual(context.seeks, []);
});

test("scrolling backwards before the first lyric does not select it", (t) => {
  const { context, panel, track, frames, advance } = setup(t);
  context.position = 0;
  context.progress(0);
  panel.dispatch("wheel", { deltaY: -100, deltaMode: 0, preventDefault() {} });
  advance(50);
  assert.equal(track.lines[0].classList.contains("is-active"), false);
  assert.deepEqual(context.seeks, []);
  assert.equal(frames.size, 0);
});

test("scrolling forward with the wheel reaches the first lyric without an early seek", (t) => {
  const { context, panel, track, advance } = setup(t);
  context.position = 0;
  context.progress(0);
  panel.dispatch("wheel", { deltaY: -50, deltaMode: 0, preventDefault() {} });
  panel.dispatch("wheel", { deltaY: 100, deltaMode: 0, preventDefault() {} });
  advance(16);
  assert.equal(track.lines[0].classList.contains("is-active"), false);
  assert.deepEqual(context.seeks, []);
  advance(1000);
  assert.equal(track.lines[0].classList.contains("is-active"), true);
  assert.equal(context.seeks.at(-1), context.state.lyrics[0].timeMs);
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

test("phone swipes follow the finger and continue into synchronised song slides", (t) => {
  for (const device of ["android", "linuxPhone"]) {
    const { context, elements, panel, advance, frames } = setup(t, [], device);
    panel.inert = false;
    loadOnTrackChange(context);
    panel.dispatch("pointerdown");
    advance(20);
    panel.dispatch("pointermove", { clientX: 160, clientY: 398 });
    panel.dispatch("pointermove", { clientX: 100, clientY: 395 });
    assert.equal(frames.size, 1);
    assert.equal(elements["lyrics-page"].style.transform, "translateX(0px)");
    advance(16);
    assert.equal(elements["lyrics-page"].style.transform, "translateX(-100px)");
    assert.deepEqual(context.seeks, []);

    panel.dispatch("pointerup", { clientX: 100, clientY: 395 });
    assert.deepEqual(context.steps, [1]);
    assert.equal(context.track.id, "second");
    assert.equal(panel.hasPointerCapture(1), false);
    assert.deepEqual(context.animations[0].keyframes, [
      { transform: "translateX(-100px)" }, { transform: "translateX(-100%)" },
    ]);
    assert.equal(elements["lyrics-page"].style.transform, "");

    advance(50);
    finishLoading(context);
    assert.deepEqual(context.animations[1].keyframes, [
      { transform: "translateX(260px)" }, { transform: "translateX(0)" },
    ]);
    assert.equal(context.animations[1].currentTime, 50);
  }
});

test("a deliberate right swipe plays the previous song", (t) => {
  const { context, panel, advance } = setup(t);
  panel.inert = false;
  context.navigation.cursor = 1;
  context.track = { ...context.track, id: "second" };
  context.render();
  context.animations.length = 0;
  loadOnTrackChange(context);
  panel.dispatch("pointerdown");
  advance(40);
  panel.dispatch("pointermove", { clientX: 320, clientY: 405 });
  advance(16);
  panel.dispatch("pointerup", { clientX: 320, clientY: 405 });
  assert.deepEqual(context.steps, [-1]);
  assert.equal(context.track.id, "track");
  assert.deepEqual(context.animations[0].keyframes, [
    { transform: "translateX(120px)" }, { transform: "translateX(100%)" },
  ]);
  finishLoading(context);
  assert.equal(context.animations[1].keyframes[0].transform, "translateX(-240px)");
});

test("diagonal drags favour vertical scrubbing, even if they later turn sideways", (t) => {
  for (const movement of [
    { x: 140, y: 360 },
    { x: 160, y: 360 },
    { x: 188, y: 392 },
  ]) {
    const { context, panel, track, advance } = setup(t);
    panel.dispatch("pointerdown");
    advance(20);
    panel.dispatch("pointermove", { clientX: movement.x, clientY: movement.y });
    panel.dispatch("pointermove", { clientX: 20, clientY: 320 });
    panel.dispatch("pointerup", { clientX: 20, clientY: 320 });
    assert.deepEqual(context.steps, []);
    assert.ok(context.seeks.length > 0);
    assert.equal(track.style.transform, "translateY(-104px)");
  }
});

test("small sideways movement does not steal a subsequent vertical drag", (t) => {
  const { context, panel, advance } = setup(t);
  panel.dispatch("pointerdown");
  panel.dispatch("pointermove", { clientX: 185, clientY: 396 });
  panel.dispatch("pointermove", { clientX: 180, clientY: 390 });
  panel.dispatch("pointermove", { clientX: 50, clientY: 320 });
  panel.dispatch("pointerup", { clientX: 50, clientY: 320 });
  advance(1000);
  assert.deepEqual(context.steps, []);
  assert.ok(context.seeks.length > 0);
});

test("queue edges, short swipes and cancelled swipes return without changing song", (t) => {
  for (const mode of ["edge", "short", "cancel", "single"]) {
    const { context, elements, panel, advance, frames } = setup(t);
    if (mode === "single") context.navigation.order = ["track"];
    const x = mode === "edge" || mode === "single" ? 320 : mode === "short" ? 180 : 80;
    panel.dispatch("pointerdown");
    advance(mode === "short" ? 500 : 40);
    panel.dispatch("pointermove", { clientX: x });
    advance(16);
    const painted = elements["lyrics-page"].style.transform;
    panel.dispatch(mode === "cancel" ? "pointercancel" : "pointerup", { clientX: x });
    assert.deepEqual(context.steps, [], mode);
    assert.deepEqual(context.seeks, [], mode);
    assert.equal(frames.size, 0, mode);
    assert.equal(panel.hasPointerCapture(1), false, mode);
    assert.deepEqual(context.animations[0].keyframes, [
      { transform: painted }, { transform: "translateX(0)" },
    ], mode);
  }
});

test("swiping wraps with repeat and stays immediate with reduced motion", (t) => {
  const { context, panel, advance } = setup(t);
  panel.inert = false;
  context.navigation.repeat = "all";
  context.reduced = true;
  loadOnTrackChange(context);
  panel.dispatch("pointerdown");
  advance(40);
  panel.dispatch("pointermove", { clientX: 320 });
  advance(16);
  panel.dispatch("pointerup", { clientX: 320 });
  assert.deepEqual(context.steps, [-1]);
  assert.equal(context.track.id, "third");
  finishLoading(context);
  assert.equal(context.animations.length, 0);
});

test("re-grabbing a returning page continues from its visible position", (t) => {
  const { context, elements, panel, advance } = setup(t);
  panel.dispatch("pointerdown");
  advance(100);
  panel.dispatch("pointermove", { clientX: 180 });
  advance(16);
  panel.dispatch("pointerup", { clientX: 180 });
  assert.equal(context.animations.length, 1);

  context.renderedPageOffset = -12;
  panel.dispatch("pointerdown");
  panel.dispatch("pointermove", { clientX: 180 });
  assert.equal(context.animations[0].cancelled, true);
  assert.equal(elements["lyrics-page"].style.transform, "translateX(-12px)");
  advance(16);
  assert.equal(elements["lyrics-page"].style.transform, "translateX(-32px)");
  panel.dispatch("pointercancel", { clientX: 180 });
  assert.deepEqual(context.animations[1].keyframes, [
    { transform: "translateX(-32px)" }, { transform: "translateX(0)" },
  ]);
});

test("a track change during a swipe keeps the last painted position and releases capture", (t) => {
  const { context, panel, advance, frames } = setup(t);
  panel.inert = false;
  loadOnTrackChange(context);
  panel.dispatch("pointerdown");
  panel.dispatch("pointermove", { clientX: 120 });
  advance(16);
  panel.dispatch("pointermove", { clientX: 100 });
  assert.equal(frames.size, 1);
  changeTrack(context, "second", 1, 1);
  assert.equal(panel.hasPointerCapture(1), false);
  assert.equal(frames.size, 0);
  assert.equal(context.animations[0].keyframes[0].transform, "translateX(-80px)");
  panel.dispatch("pointerup", { clientX: 100 });
  assert.deepEqual(context.steps, []);
  finishLoading(context);
  assert.equal(context.animations[1].keyframes[0].transform, "translateX(280px)");
});

test("hiding the sheet cancels a swipe without leaving an old lyric highlighted", (t) => {
  const visibility = createSheetVisibility();
  visibility.update(1, 720);
  const { context, elements, panel, track, advance } = setup(t, [], "android", visibility);
  context.progress(context.state.lyrics[3].timeMs);
  panel.dispatch("pointerdown");
  panel.dispatch("pointermove", { clientX: 120 });
  advance(16);
  assert.equal(panel.hasPointerCapture(1), true);
  visibility.update(0, 720);
  assert.equal(panel.hasPointerCapture(1), false);
  assert.equal(elements["lyrics-page"].style.transform, "");

  context.position = context.state.lyrics[4].timeMs;
  visibility.update(1, 720);
  assert.deepEqual(track.lines.map((line, index) => line.classList.contains("is-active") ? index : -1)
    .filter((index) => index >= 0), [4]);
  panel.dispatch("pointerup", { clientX: 120 });
  assert.deepEqual(context.steps, []);
});

test("a tap still seeks the nearest lyric without starting a swipe", (t) => {
  const { context, panel } = setup(t);
  context.renderedOffset = -60;
  panel.dispatch("pointerdown");
  panel.dispatch("pointerup");
  assert.deepEqual(context.steps, []);
  assert.equal(context.seeks.at(-1), context.state.lyrics[1].timeMs);
});

test("desktop horizontal drags do not switch songs", (t) => {
  const { context, panel, advance } = setup(t, [], "desktop");
  panel.dispatch("pointerdown");
  advance(20);
  panel.dispatch("pointermove", { clientX: 50 });
  panel.dispatch("pointerup", { clientX: 50 });
  assert.deepEqual(context.steps, []);
});

test("hidden lyrics prepare track changes and catch up without animation on reveal", (t) => {
  const visibility = createSheetVisibility();
  visibility.update(1, 720);
  const { context, panel, track, offset, advance } = setup(t, [], "android", visibility);
  assert.equal(offset(), 24);
  const originalLines = track.lines;
  visibility.update(0, 720);
  context.position = 20000;
  context.progress(context.position);
  assert.equal(offset(), 24);

  loadOnTrackChange(context);
  changeTrack(context, "second", 1, 1);
  const lyrics = [
    { timeMs: 0, text: "first" },
    { timeMs: 10000, text: "second" },
    { timeMs: 20000, text: "third" },
  ];
  finishLoading(context, lyrics);
  assert.notEqual(track.lines, originalLines);
  assert.equal(track.lines.length, 3);
  const preparedLines = track.lines;
  assert.equal(offset(), 24);
  assert.equal(context.animations.length, 0);

  const writes = [];
  let transform = track.style.transform;
  Object.defineProperty(track.style, "transform", {
    get: () => transform,
    set: (value) => {
      transform = value;
      writes.push({ value, catchingUp: panel.classList.contains("is-catching-up") });
    },
  });
  visibility.update(1, 720);
  assert.equal(offset(), 120);
  assert.equal(track.lines, preparedLines);
  assert.ok(writes.length > 0 && writes.every((write) => write.catchingUp));
  assert.equal(track.lines[2].classList.contains("is-active"), true);
  assert.equal(context.animations.length, 0);
  assert.equal(panel.classList.contains("is-catching-up"), true);
  advance(16);
  assert.equal(panel.classList.contains("is-catching-up"), true);
  advance(16);
  assert.equal(panel.classList.contains("is-catching-up"), false);

  context.progress(10000);
  assert.equal(offset(), 72);
  assert.equal(writes.at(-1).catchingUp, false);
});

test("hidden lyric resizes are measured before the sheet is revealed", (t) => {
  const visibility = createSheetVisibility();
  const { context, panel, track, offset } = setup(t, [], "android", visibility);
  assert.equal(panel.classList.contains("is-catching-up"), true);
  const beforeResize = context.measurements;
  track.lines[2].offsetTop = 150;
  context.resize();
  assert.equal(context.measurements, beforeResize + track.lines.length);

  let layouts = 0;
  Object.defineProperty(track, "offsetHeight", {
    get: () => {
      layouts += 1;
      return 48;
    },
  });
  context.position = 14000;
  const beforeReveal = context.measurements;
  visibility.update(1, 720);
  assert.equal(offset(), 174);
  assert.equal(context.measurements, beforeReveal);
  assert.equal(layouts, 0);
});

test("rapid sheet reversals cancel catch-up cleanup until the next reveal", (t) => {
  const visibility = createSheetVisibility();
  const { panel, frames, advance } = setup(t, [], "android", visibility);
  visibility.update(1, 720);
  advance(16);
  assert.equal(frames.size, 1);
  visibility.update(0, 720);
  assert.equal(frames.size, 0);
  assert.equal(panel.classList.contains("is-catching-up"), true);

  visibility.update(1, 720);
  advance(16);
  assert.equal(panel.classList.contains("is-catching-up"), true);
  advance(16);
  assert.equal(panel.classList.contains("is-catching-up"), false);
  assert.equal(frames.size, 0);
});

test("closed lyrics stay measurable and a partly revealed sheet keeps updating", (t) => {
  const visibility = createSheetVisibility();
  const { context, panel, track, offset } = setup(t, [], "android", visibility);
  assert.equal(panel.hidden, false);
  assert.equal(track.lines.length, 12);
  context.position = 14000;
  visibility.update(1, 720);
  assert.equal(offset(), 120);
  panel.inert = true;
  context.progress(20000);
  assert.equal(offset(), 168);
});

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

test("incoming phone lyrics start at the playback position without a vertical transition", (t) => {
  for (const { device, delayed, position } of [
    { device: "android", delayed: true, position: 0 },
    { device: "linuxPhone", delayed: false, position: 2000 },
  ]) {
    const { context, elements, panel, track, offset } = setup(t, [], device);
    panel.inert = false;
    context.progress(context.state.lyrics[7].timeMs);
    assert.equal(offset(), 360);

    const writes = [];
    const layouts = [];
    let transform = track.style.transform;
    Object.defineProperty(track.style, "transform", {
      get: () => transform,
      set: (value) => {
        transform = value;
        writes.push({ transform, transition: track.style.transition });
      },
    });
    Object.defineProperty(track, "offsetHeight", {
      get: () => {
        layouts.push({ transform, transition: track.style.transition });
        return 48;
      },
    });

    const lyrics = [
      { timeMs: 0, text: "first" },
      { timeMs: 2000, text: "second" },
      { timeMs: 4000, text: "third" },
    ];
    if (delayed) {
      loadOnTrackChange(context);
    } else {
      context.loadLyrics = () => {
        context.state.lyrics = lyrics;
        context.render();
      };
    }

    context.position = position;
    changeTrack(context, "second", 1, 1);
    assert.equal(context.animations[0].element.clonedTrack.style.transform, "matrix(1, 0, 0, 1, 0, -360)");
    if (delayed) {
      writes.length = 0;
      layouts.length = 0;
      finishLoading(context, lyrics);
    }

    const expected = position === 0 ? "translateY(-24px)" : "translateY(-72px)";
    assert.equal(track.style.transform, expected);
    assert.ok(writes.length > 0);
    assert.ok(writes.every((write) => write.transition === "none"));
    assert.deepEqual(layouts.at(-1), { transform: expected, transition: "none" });
    assert.equal(track.style.transition, "");
    assert.equal(context.animations[1].element, elements["lyrics-page"]);

    context.progress(4000);
    assert.equal(offset(), 120);
    assert.equal(writes.at(-1).transition, "");
  }
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
