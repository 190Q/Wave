import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const context = {
  kind: "android",
  ready: true,
  readyIds: null,
  missing: new Set(),
  reducedMotion: false,
  state: { queueOpen: true, collections: [] },
  snapshot: null,
  swaps: [],
  player: {
    snapshot: () => context.snapshot,
    onChange: (callback) => { context.change = callback; },
    moveTo: (id) => {
      context.moves.push(id);
      context.snapshot.cursor = context.snapshot.order.indexOf(id);
      context.snapshot.currentId = id;
      context.change();
    },
    playTrack: (id) => { context.plays.push(id); },
  },
};
globalThis.__queueAnimationTest = context;

const mocks = {
  "../lib/device": "export const device = () => globalThis.__queueAnimationTest.kind; export const isWebKitGtk = false;",
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
    export const trackById = (id) => id ? {
      id, title: id, artist: "artist", artworkPath: context.missing.has(id) ? null : id,
    } : undefined;
    export const artworkUrlFor = (track, tier) =>
      track.artworkPath && !(tier === "idle" && context.idleUnloaded.has(track.id)) &&
      (context.readyIds ? context.readyIds.has(track.id) : context.ready)
        ? "url-" + track.id : null;
    export const colourFor = () => "#123456";
    export const mayRevealArtwork = () => context.kind === "desktop" || context.ready;
    export const ensureColour = () => {};
    export const prefetchArtwork = (ids) => context.prefetches.push(ids);
    export const prioritizeNearbyArtwork = (order, cursor, looping) => {
      context.priority = { order, cursor, looping };
      context.priorityRuns += 1;
    };
    export const pruneArtworkQueue = (window, queue) => {
      context.pruned = { window, queue };
      context.pruneRuns += 1;
    };
    export const stepTrack = () => {};
  `,
  "./artwork": `
    export const coverStyle = (track, tier, reveal = true) =>
      reveal && track.artworkPath &&
      !(tier === "idle" && globalThis.__queueAnimationTest.idleUnloaded.has(track.id)) &&
      (globalThis.__queueAnimationTest.readyIds
        ? globalThis.__queueAnimationTest.readyIds.has(track.id)
        : globalThis.__queueAnimationTest.ready) ? "url-" + track.id : "colour-" + track.id;
  `,
  "./library": "export const openTrackMenu = () => {};",
  "./wipe": `
    export const coverWipe = (swaps) => globalThis.__queueAnimationTest.swaps.push(swaps);
    export const finishCoverWipe = () => {};
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
    this.listeners = new Map();
    this.capturedPointers = new Set();
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  dispatch(type, properties = {}) {
    const event = { type, target: this, button: 0, pointerId: 1, clientX: 0, ...properties };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  closest(selector) { return selector === ".card" && this.className === "card" ? this : null; }
  setPointerCapture(id) { this.capturedPointers.add(id); }
  hasPointerCapture(id) { return this.capturedPointers.has(id); }
  releasePointerCapture(id) { this.capturedPointers.delete(id); }
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
  set innerHTML(value) {
    this.html = value;
    const style = value.match(/class="card-body" style="([^"]*)"/)?.[1];
    if (style !== undefined) this.querySelector(".card-body").setAttribute("style", style);
  }
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name] ?? null; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 400, bottom: 800 }; }
}

function snapshot(sourceId, count, cursor = 0) {
  const order = Array.from({ length: count }, (_, index) => `${sourceId}-${index}`);
  return { sourceId, order, cursor, currentId: order[cursor], repeat: "off", travel: 0,
    get queueRevision() { return this.order.join("|"); } };
}

function setup(kind = "android", observeSize = false, visibility, idleUnloaded = new Set()) {
  context.kind = kind;
  context.state = { queueOpen: true, collections: [] };
  context.ready = true;
  context.readyIds = null;
  context.idleUnloaded = idleUnloaded;
  context.missing = new Set();
  context.reducedMotion = false;
  context.swaps = [];
  context.prefetches = [];
  context.pruned = null;
  context.priority = null;
  context.priorityRuns = 0;
  context.pruneRuns = 0;
  context.moves = [];
  context.plays = [];
  context.snapshot = snapshot("first", 30);
  const carousel = new FakeElement();
  const stage = new FakeElement();
  const root = new FakeElement();
  const dock = new FakeElement();
  const titlebar = new FakeElement();
  let resizeObserver;
  const frames = new Map();
  const timers = new Map();
  let nextFrame = 0;
  let nextTimer = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  globalThis.window = {
    innerWidth: 400,
    innerHeight: 800,
    setTimeout: (callback, delay) => {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    clearTimeout: (id) => timers.delete(id),
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  globalThis.document = {
    documentElement: root,
    getElementById: (id) => id === "carousel" ? carousel
      : observeSize && id === "dock" ? dock
      : observeSize && id === "titlebar" ? titlebar
      : null,
    querySelector: (selector) => selector === ".stage" ? stage : null,
    createElement: () => new FakeElement(),
  };
  globalThis.getComputedStyle = () => ({
    fontSize: "16px",
    marginTop: "0px",
    marginBottom: "0px",
    getPropertyValue: (name) => name === "--card-spacing" ? "9" : "14",
  });
  globalThis.ResizeObserver = observeSize ? class {
    constructor(callback) {
      this.callback = callback;
      this.observed = new Set();
      resizeObserver = this;
    }
    observe(element) { this.observed.add(element); }
    resize(element) {
      if (this.observed.has(element)) this.callback();
    }
  } : undefined;
  mountQueue(visibility);
  return { carousel, live: carousel.children[0], wash: carousel.children[1], frames, timers, root, stage, dock, titlebar, resizeObserver };
}

const { mountQueue } = await vite.ssrLoadModule("/src/ui/queue.ts");
const { createSheetVisibility } = await vite.ssrLoadModule("/src/ui/sheet-visibility.ts");

function runFrame(frames) {
  const [id, callback] = frames.entries().next().value;
  frames.delete(id);
  callback();
}

test("Linux phone drag frames update positions without repeating artwork work", () => {
  const { carousel, live, frames } = setup("linuxPhone");
  const priorityRuns = context.priorityRuns;
  const pruneRuns = context.pruneRuns;
  const swaps = context.swaps.length;
  const first = live.children.find((card) => card.dataset.slot === "0");
  const second = live.children.find((card) => card.dataset.slot === "1");

  carousel.dispatch("pointerdown", { clientX: 200 });
  carousel.dispatch("pointermove", { clientX: 150 });
  carousel.dispatch("pointermove", { clientX: 104 });
  assert.equal(frames.size, 1);
  runFrame(frames);

  assert.equal(context.priorityRuns, priorityRuns);
  assert.equal(context.pruneRuns, pruneRuns);
  assert.equal(context.swaps.length, swaps);
  assert.equal(first.dataset.offset, String(-2 / 3));
  assert.equal(first.style.transition, "none");
  assert.ok(Number(second.style.zIndex) > Number(first.style.zIndex));
  assert.match(second.style.zIndex, /^-?\d+$/);

  carousel.dispatch("pointerup", { clientX: 104 });
  assert.deepEqual(context.moves, ["first-1"]);
  assert.equal(carousel.classList.contains("is-dragging"), false);
  assert.equal(carousel.hasPointerCapture(1), false);
});

test("Linux phone drag loads artwork when a card enters the visible range", () => {
  const { carousel, live, frames } = setup("linuxPhone", false, undefined, new Set(["first-6"]));
  const sixth = live.children.find((card) => card.dataset.slot === "6");
  assert.equal(sixth.dataset.artwork, "");

  carousel.dispatch("pointerdown", { clientX: 300 });
  carousel.dispatch("pointermove", { clientX: 170 });
  const priorityRuns = context.priorityRuns;
  runFrame(frames);
  assert.equal(context.priorityRuns, priorityRuns);
  assert.equal(sixth.dataset.artwork, "");

  carousel.dispatch("pointermove", { clientX: 140 });
  runFrame(frames);
  assert.ok(context.priorityRuns > priorityRuns);
  assert.equal(sixth.dataset.artwork, "url-first-6");
  assert.ok(context.swaps.at(-1).some(({ style }) => style === "url-first-6"));
});

test("Linux phone drag rebuilds its card window and retains normal artwork updates", () => {
  const { carousel, live, frames } = setup("linuxPhone");
  const priorityRuns = context.priorityRuns;
  carousel.dispatch("pointerdown", { clientX: 900 });
  carousel.dispatch("pointermove", { clientX: 468 });
  runFrame(frames);

  assert.ok(context.priorityRuns > priorityRuns);
  assert.ok(live.children.some((card) => card.dataset.slot === "11"));
  assert.equal(live.children.find((card) => card.dataset.slot === "3").dataset.offset, "0");
  assert.ok(live.children.every((card) => !card.classList.contains("is-entering")));
  assert.equal(frames.size, 0);

  carousel.dispatch("pointermove", { clientX: -396 });
  runFrame(frames);
  assert.equal(live.children.some((card) => card.dataset.slot === "0"), false);
  assert.ok(live.children.every((card) => !card.classList.contains("is-leaving")));
  assert.equal(frames.size, 0);
  carousel.dispatch("pointerup", { clientX: -396 });
  assert.deepEqual(context.moves, ["first-9"]);

  context.ready = false;
  context.snapshot = snapshot("second", 30, 3);
  context.change();
  assert.ok(live.children.some((card) => card.dataset.trackId === "second-3"));
  context.ready = true;
  context.change();
  assert.ok(context.swaps.at(-1).some(({ style }) => style === "url-second-3"));
});

test("a Linux phone drag ignores other pointers and cancellation uses the last position", () => {
  const { carousel, frames } = setup("linuxPhone");
  carousel.dispatch("pointerdown", { clientX: 200 });
  carousel.dispatch("pointerdown", { pointerId: 2, clientX: 500, isPrimary: false });
  carousel.dispatch("pointermove", { pointerId: 2, clientX: -500 });
  carousel.dispatch("pointerup", { pointerId: 2, clientX: -500 });
  assert.equal(frames.size, 0);
  assert.equal(carousel.classList.contains("is-dragging"), true);
  assert.equal(carousel.hasPointerCapture(1), true);

  carousel.dispatch("pointermove", { clientX: 100 });
  carousel.dispatch("pointercancel", { clientX: 0 });
  assert.deepEqual(context.moves, ["first-1"]);
  assert.equal(frames.size, 0);
  assert.equal(carousel.hasPointerCapture(1), false);
});

test("Linux phone dragging wraps a looping queue without turning the swipe into a tap", () => {
  const { carousel, live, frames } = setup("linuxPhone");
  context.snapshot.repeat = "all";
  context.change();
  while (frames.size > 0) runFrame(frames);

  const previous = live.children.find((card) => card.dataset.slot === "-1");
  carousel.dispatch("pointerdown", { target: previous, clientX: 100 });
  carousel.dispatch("pointermove", { clientX: 244 });
  runFrame(frames);
  assert.equal(previous.dataset.offset, "0");
  carousel.dispatch("pointerup", { clientX: 244 });
  carousel.dispatch("click", { target: previous });
  assert.deepEqual(context.moves, ["first-29"]);
  assert.deepEqual(context.plays, []);

  carousel.dispatch("pointerdown", { target: previous, clientX: 100 });
  carousel.dispatch("pointerup", { clientX: 100 });
  carousel.dispatch("click", { target: previous });
  assert.deepEqual(context.plays, ["first-29"]);
});

test("Android and desktop drag frames retain their existing full render", () => {
  for (const kind of ["android", "desktop"]) {
    const { carousel, frames } = setup(kind);
    const pruneRuns = context.pruneRuns;
    carousel.dispatch("pointerdown", { clientX: 200 });
    carousel.dispatch("pointermove", { clientX: 100 });
    runFrame(frames);
    assert.ok(context.pruneRuns > pruneRuns);
  }
});

test("an unchanged hidden queue stops transitions without rendering again on reveal", () => {
  const visibility = createSheetVisibility();
  const { carousel, live } = setup("android", false, visibility);
  const original = [...live.children];
  const renders = context.swaps.length;
  visibility.update(600, 600);
  assert.equal(carousel.classList.contains("is-catching-up"), true);
  visibility.update(599, 600);
  assert.equal(carousel.classList.contains("is-catching-up"), false);
  assert.deepEqual(live.children, original);
  assert.equal(context.swaps.length, renders);
});

test("hidden queue keeps artwork prioritised and catches up without a sweep or card animation", () => {
  for (const kind of ["android", "linuxPhone"]) {
    const visibility = createSheetVisibility();
    const { live, wash, frames } = setup(kind, false, visibility);
    const original = [...live.children];
    visibility.update(600, 600);
    context.snapshot = snapshot("second", 30, 20);
    context.ready = false;
    context.change();
    assert.deepEqual(live.children, original);
    assert.equal(context.priority.cursor, 20);
    assert.equal(context.priority.order, context.snapshot.order);

    context.ready = true;
    context.change();
    assert.deepEqual(live.children, original);
    visibility.update(599, 600);
    const current = live.children.find((card) => card.dataset.trackId === "second-20");
    assert.ok(current);
    assert.equal(current.querySelector(".card-body").style, "url-second-20");
    assert.equal(current.style.transition, "");
    assert.ok(live.children.every((card) => !card.classList.contains("is-entering")));
    assert.equal(wash.children.length, 0);
    assert.equal(frames.size, 0);
    assert.deepEqual(context.swaps.at(-1), []);
  }
});

test("artwork still loading at reveal appears later without an old wipe", () => {
  const visibility = createSheetVisibility();
  const { live } = setup("linuxPhone", false, visibility);
  visibility.update(600, 600);
  context.snapshot = snapshot("second", 30, 20);
  context.ready = false;
  context.change();
  visibility.update(599, 600);
  context.ready = true;
  context.change();
  const current = live.children.find((card) => card.dataset.trackId === "second-20");
  assert.equal(current?.querySelector(".card-body").style, "url-second-20");
  assert.deepEqual(context.swaps.at(-1), []);
});

test("desktop requests visible artwork without prefetching the entire queue", () => {
  const { live } = setup("desktop");
  context.snapshot = snapshot("large", 5000);
  context.change();
  assert.equal(context.prefetches.length, 0);
  assert.ok(live.children.length > 0);
  assert.ok(context.pruned.window.has("large-0"));
  assert.equal(context.pruned.queue.size, 5000);
});

test("unchanged large queues avoid full scans on repeated renders", () => {
  const { live } = setup("linuxPhone");
  context.reducedMotion = true;
  const order = Array.from({ length: 5000 }, (_, index) => `large-${index}`);
  let joins = 0;
  let iterations = 0;
  order.join = function (...args) {
    joins += 1;
    return Array.prototype.join.apply(this, args);
  };
  order[Symbol.iterator] = function () {
    iterations += 1;
    return Array.prototype[Symbol.iterator].call(this);
  };
  context.snapshot = {
    sourceId: "large", order, cursor: 0, currentId: order[0],
    repeat: "off", travel: 0, queueRevision: 100,
  };
  context.change();
  const firstJoins = joins;
  const firstIterations = iterations;
  assert.equal(firstJoins, 1);
  assert.ok(firstIterations > 0);

  for (let index = 0; index < 25; index += 1) context.change();
  assert.equal(joins, firstJoins);
  assert.equal(iterations, firstIterations);

  [order[0], order[1]] = [order[1], order[0]];
  context.snapshot.queueRevision += 1;
  context.snapshot.currentId = order[0];
  context.change();
  assert.equal(joins, firstJoins + 1);
  assert.ok(iterations > firstIterations);
  assert.equal(live.children.find((card) => card.dataset.slot === "0")?.dataset.trackId, "large-1");
  assert.ok(context.pruned.queue.has("large-1"));
});

test("the queue follows dock size changes when leaving mini mode", () => {
  for (const open of [true, false]) {
    const { root, stage, dock, titlebar, resizeObserver } = setup("desktop", true);
    context.state.queueOpen = open;
    context.render();

    stage.clientHeight = 92;
    dock.offsetHeight = 92;
    titlebar.offsetHeight = 0;
    resizeObserver.resize(stage);
    assert.equal(root.classList.contains("is-cramped"), true);
    assert.equal(context.state.queueOpen, open);

    stage.clientHeight = 800;
    dock.offsetHeight = 800;
    resizeObserver.resize(stage);
    assert.equal(root.classList.contains("is-cramped"), true);

    dock.offsetHeight = 100;
    titlebar.offsetHeight = 36;
    resizeObserver.resize(dock);
    assert.equal(root.classList.contains("is-cramped"), false);
    assert.equal(stage.classList.contains("queue-open"), open);

    context.state.queueOpen = !open;
    context.render();
    assert.equal(stage.classList.contains("queue-open"), !open);
  }
});

test("the queue is refitted when the titlebar changes without a window resize", () => {
  const { root, stage, titlebar, resizeObserver } = setup("desktop", true);
  stage.clientHeight = 500;
  titlebar.offsetHeight = 100;
  resizeObserver.resize(stage);
  assert.equal(root.classList.contains("is-cramped"), true);

  titlebar.offsetHeight = 0;
  resizeObserver.resize(titlebar);
  assert.equal(root.classList.contains("is-cramped"), false);
  assert.equal(stage.classList.contains("queue-open"), true);
});

test("phone cards do not enter with an animation while the app starts", () => {
  const { live, root } = setup();
  root.classList.add("is-starting");
  context.snapshot = snapshot("first", 30, 20);
  context.change();
  assert.ok(live.children.every((card) => !card.classList.contains("is-entering")));
});

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

test("Android replaces ready covers directly and applies slow placeholders without a sweep", () => {
  const { live, wash, frames, timers } = setup();
  const old = [...live.children];
  context.snapshot = snapshot("second", 30);
  context.ready = false;
  context.readyIds = new Set(["second-0", "second-2"]);
  context.change();

  assert.equal(wash.children.length, 0);
  assert.equal(frames.size, 0);
  assert.equal(live.children[0], old[0]);
  assert.equal(live.children[1], old[1]);
  assert.equal(live.children[1].dataset.trackId, "second-1");
  assert.equal(live.children[1].querySelector(".card-title").textContent, "second-1");
  assert.equal(live.children[1].querySelector(".card-body").style, "url-first-1");
  assert.deepEqual(context.swaps.at(-1).map(({ style }) => style), ["url-second-0", "url-second-2"]);

  for (const [id, timer] of [...timers]) {
    if (timer.delay === 200) {
      timers.delete(id);
      timer.callback();
    }
  }
  assert.equal(live.children[1].querySelector(".card-body").style, "colour-second-1");

  context.readyIds.add("second-1");
  context.change();
  assert.deepEqual(context.swaps.at(-1).map(({ style }) => style), ["url-second-1"]);
});

test("a quickly loaded Android cover replaces the old cover without showing a colour", () => {
  const { live, timers } = setup();
  const body = live.children[0].querySelector(".card-body");
  context.snapshot = snapshot("second", 30);
  context.ready = false;
  context.readyIds = new Set();
  context.change();
  const timeout = [...timers.values()].find((timer) => timer.delay === 200);
  assert.ok(timeout);
  assert.equal(body.style, "url-first-0");

  context.readyIds.add("second-0");
  context.change();
  assert.ok(context.swaps.at(-1).some(({ style }) => style === "url-second-0"));
  timeout.callback();
  assert.equal(body.style, "url-first-0");
});

test("Android settles entering cards before reusing them for unloaded covers", () => {
  const { live } = setup();
  context.snapshot = snapshot("first", 30, 20);
  context.change();
  const current = live.children.find((card) => card.dataset.slot === "20");
  assert.equal(current.classList.contains("is-entering"), true);

  context.snapshot = snapshot("second", 30, 20);
  context.ready = false;
  context.change();
  assert.equal(live.children.find((card) => card.dataset.slot === "20"), current);
  assert.equal(current.classList.contains("is-entering"), false);
  assert.equal(current.classList.contains("is-settling"), false);
});

test("Android shuffle reuses positions and does not let an older fallback overwrite a new cover", () => {
  const { live, wash, timers } = setup();
  const old = [...live.children];
  const shuffled = snapshot("first", 30);
  [shuffled.order[1], shuffled.order[2]] = [shuffled.order[2], shuffled.order[1]];
  context.snapshot = shuffled;
  context.ready = false;
  context.readyIds = new Set(["first-0"]);
  context.change();
  const stale = [...timers.values()].find((timer) => timer.delay === 200);
  assert.ok(stale);
  assert.equal(live.children[1], old[1]);
  assert.equal(live.children[1].dataset.trackId, "first-2");
  assert.equal(live.children[1].dataset.index, "1");
  assert.equal(wash.children.length, 0);

  context.snapshot = snapshot("third", 30);
  context.readyIds = new Set(["third-1"]);
  context.change();
  assert.ok(context.swaps.at(-1).some(({ style }) => style === "url-third-1"));
  stale.callback();
  assert.notEqual(live.children[1].querySelector(".card-body").style, "colour-first-2");
});

test("Android applies missing covers and backgrounded fallbacks immediately", () => {
  const { live, timers } = setup();
  context.snapshot = snapshot("second", 30);
  context.ready = false;
  context.readyIds = new Set();
  context.missing.add("second-0");
  context.change();
  assert.equal(live.children[0].querySelector(".card-body").style, "colour-second-0");
  assert.equal(live.children[1].querySelector(".card-body").style, "url-first-1");
  assert.ok(timers.size > 0);

  context.reducedMotion = true;
  context.motionChanged();
  assert.equal(live.children[1].querySelector(".card-body").style, "colour-second-1");
  assert.equal(timers.size, 0);

  context.reducedMotion = false;
  context.readyIds.add("second-1");
  context.change();
  assert.equal(live.children[1].querySelector(".card-body").style, "url-second-1");
  assert.deepEqual(context.swaps.at(-1), []);
});

test("loaded Linux phone covers and desktop collection changes retain their sweep", () => {
  for (const kind of ["linuxPhone", "desktop"]) {
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
  const { live, wash, frames } = setup("linuxPhone");
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
  const { live, wash, frames } = setup("linuxPhone");
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
