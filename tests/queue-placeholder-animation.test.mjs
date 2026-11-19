import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const context = {
  kind: "android",
  ready: true,
  reducedMotion: false,
  state: { queueOpen: true, collections: [] },
  snapshot: null,
  swaps: [],
  player: {
    snapshot: () => context.snapshot,
    onChange: (callback) => { context.change = callback; },
  },
};
globalThis.__queueAnimationTest = context;

const mocks = {
  "../lib/device": "export const device = () => globalThis.__queueAnimationTest.kind;",
  "../lib/format": "export const escapeHtml = (value) => value;",
  "../lib/motion": `
    export const reduceMotionActive = () => globalThis.__queueAnimationTest.reducedMotion;
    export const subscribeMotion = (callback) => { globalThis.__queueAnimationTest.motionChanged = callback; };
  `,
  "../lib/steps": "export const stepLater = () => {};",
  "../lib/state": `
    const context = globalThis.__queueAnimationTest;
    export const player = context.player;
    export const getState = () => context.state;
    export const subscribe = (callback) => { context.render = callback; };
    export const trackById = (id) => id ? { id, title: id, artist: "artist", artworkPath: id } : undefined;
    export const artworkUrlFor = (track) => context.ready ? "url-" + track.id : null;
    export const colourFor = () => "#123456";
    export const mayRevealArtwork = () => context.kind === "desktop" || context.ready;
    export const ensureColour = () => {}, prefetchArtwork = () => {};
    export const prioritizeNearbyArtwork = () => {}, pruneArtworkQueue = () => {}, stepTrack = () => {};
  `,
  "./artwork": `
    export const coverStyle = (track, tier, reveal = true) =>
      reveal && globalThis.__queueAnimationTest.ready ? "url-" + track.id : "colour";
  `,
  "./library": "export const openTrackMenu = () => {};",
  "./wipe": `
    export const coverWipe = (swaps) => globalThis.__queueAnimationTest.swaps.push(swaps);
    export const setCoverStyle = (body, style) => body.setAttribute("style", style);
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
    name: "queue-placeholder-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/]queue\.ts$/.test(importer) && source in mocks) {
        return `\0queue-placeholder-test:${source}`;
      }
    },
    load(id) {
      if (id.startsWith("\0queue-placeholder-test:")) return mocks[id.slice("\0queue-placeholder-test:".length)];
    },
  }],
});
after(() => vite.close());

class FakeElement {
  constructor() {
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, force) => {
        const enabled = force ?? !this.classes.has(name);
        if (enabled) this.classes.add(name);
        else this.classes.delete(name);
        return enabled;
      },
    };
    this.parts = new Map();
    this.offsetWidth = 100;
    this.offsetHeight = 100;
    this.clientHeight = 800;
  }
  addEventListener() {}
  append(...elements) { elements.forEach((element) => this.appendChild(element)); }
  appendChild(element) {
    element.remove();
    element.parent = this;
    this.children.push(element);
    return element;
  }
  remove() {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    }
  }
  replaceChildren(...elements) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...elements);
  }
  querySelector(selector) {
    if (!this.parts.has(selector)) this.parts.set(selector, new FakeElement());
    return this.parts.get(selector);
  }
  setAttribute(name, value) { this[name] = value; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 400, bottom: 800 }; }
}

function snapshot(sourceId, count, cursor = 0) {
  const order = Array.from({ length: count }, (_, index) => `${sourceId}-${index}`);
  return { sourceId, order, cursor, currentId: order[cursor], repeat: "off", travel: 0 };
}

function setup(kind = "android") {
  context.kind = kind;
  context.ready = true;
  context.reducedMotion = false;
  context.swaps = [];
  context.snapshot = snapshot("first", 30);
  const carousel = new FakeElement();
  const stage = new FakeElement();
  const root = new FakeElement();
  const frames = new Map();
  let nextFrame = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  globalThis.window = {
    innerWidth: 400,
    innerHeight: 800,
    setTimeout: () => 1,
    clearTimeout() {},
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  globalThis.document = {
    documentElement: root,
    getElementById: (id) => id === "carousel" ? carousel : null,
    querySelector: (selector) => selector === ".stage" ? stage : null,
    createElement: () => new FakeElement(),
  };
  globalThis.getComputedStyle = () => ({
    fontSize: "16px",
    getPropertyValue: (name) => name === "--card-spacing" ? "9" : "14",
  });
  globalThis.ResizeObserver = undefined;
  mountQueue();
  return { live: carousel.children[0], wash: carousel.children[1], frames };
}

const { mountQueue } = await vite.ssrLoadModule("/src/ui/queue.ts");

test("unloaded phone cards appear without the entry animation after a search jump", () => {
  for (const kind of ["android", "linuxPhone"]) {
    const { live } = setup(kind);
    context.snapshot = snapshot("first", 30, 20);
    context.ready = false;
    context.change();
    const cards = live.children.filter((card) => card.dataset.slot !== undefined && !card.classList.contains("is-leaving"));
    assert.ok(cards.length > 0);
    assert.ok(cards.every((card) => !card.dataset.artwork && !card.classList.contains("is-entering")));

    context.ready = true;
    context.change();
    assert.ok(context.swaps.at(-1).some(({ style }) => style === "url-first-20"));
  }
});

test("a phone collection change does not sweep unloaded placeholder colours", () => {
  for (const kind of ["android", "linuxPhone"]) {
    const { live, wash, frames } = setup(kind);
    context.snapshot = snapshot("second", 30, 20);
    context.ready = false;
    context.change();
    assert.equal(wash.children.length, 0);
    assert.ok(!live.style.clipPath);
    assert.equal(frames.size, 0);
    assert.ok(live.children.every((card) => !card.dataset.artwork));

    context.ready = true;
    context.change();
    assert.ok(context.swaps.at(-1).some(({ style }) => style === "url-second-20"));
  }
});

test("loaded phone cards retain their entry animation after a search jump", () => {
  const { live } = setup();
  context.snapshot = snapshot("first", 30, 20);
  context.change();
  const current = live.children.find((card) => card.dataset.slot === "20");
  assert.ok(current?.dataset.artwork);
  assert.equal(current.classList.contains("is-entering"), true);
});

test("loaded phone covers and desktop collection changes retain their sweep", () => {
  for (const kind of ["android", "linuxPhone", "desktop"]) {
    const { live, wash, frames } = setup(kind);
    context.snapshot = snapshot("second", 12);
    context.ready = kind !== "desktop";
    context.change();
    assert.ok(wash.children.length > 0);
    assert.ok(live.style.clipPath);
    assert.equal(frames.size, 1);
  }
});

test("an unfinished sweep is cleared before unloaded phone placeholders appear", () => {
  const { live, wash, frames } = setup();
  context.snapshot = snapshot("second", 12);
  context.change();
  assert.equal(frames.size, 1);

  context.snapshot = snapshot("third", 12);
  context.ready = false;
  context.change();
  assert.equal(wash.children.length, 0);
  assert.ok(!live.style.clipPath);
  assert.equal(frames.size, 0);
});

test("backgrounding settles an active sweep and later queue changes do not animate", () => {
  const { live, wash, frames } = setup();
  context.snapshot = snapshot("second", 30);
  context.change();
  assert.ok(wash.children.length > 0);

  context.reducedMotion = true;
  context.motionChanged();
  assert.equal(wash.children.length, 0);
  assert.ok(!live.style.clipPath);
  assert.equal(frames.size, 0);

  for (const cursor of [10, 20, 29]) {
    context.snapshot = snapshot("second", 30, cursor);
    context.change();
  }
  assert.equal(frames.size, 0);
  assert.ok(live.children.every((card) => !card.classList.contains("is-entering")));
  assert.ok(live.children.every((card) => !card.classList.contains("is-leaving")));
});

test("artwork requested in the background is applied without a late reveal", () => {
  const { live } = setup();
  context.reducedMotion = true;
  context.motionChanged();
  context.snapshot = snapshot("second", 30, 20);
  context.ready = false;
  context.change();

  context.reducedMotion = false;
  context.ready = true;
  context.change();
  const current = live.children.find((card) => card.dataset.slot === "20");
  assert.equal(current?.querySelector(".card-body").style, "url-second-20");
  assert.deepEqual(context.swaps.at(-1), []);
});
