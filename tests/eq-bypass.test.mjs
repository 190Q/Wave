import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

globalThis.document = { hidden: true, addEventListener() {} };
const frames = new Map();
let frameId = 0;
globalThis.window = { cancelAnimationFrame(id) { frames.delete(id); } };
globalThis.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };

class FakeAudio {
  static instances = [];
  listeners = new Map();
  paused = true;
  ended = false;
  seeking = false;
  readyState = 0;
  currentTime = 0;
  duration = 120;
  src = "";
  currentSrc = "";

  constructor() { FakeAudio.instances.push(this); }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name) { for (const callback of [...(this.listeners.get(name) ?? [])]) callback(); }
  metadata() { this.readyState = 1; this.emit("loadedmetadata"); }
  play() { this.paused = false; this.emit("play"); return Promise.resolve(); }
  pause() { this.paused = true; this.emit("pause"); }
  removeAttribute() { this.src = ""; }
  load() {}
}

class FakeNode {
  gain = { value: 1 };
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
  connect() {}
  disconnect() { this.disconnected = true; }
}

class FakeContext {
  static instances = [];
  static routed = new WeakSet();
  state = "running";
  sampleRate = 48000;
  destination = new FakeNode();
  sources = new Map();
  requests = [];

  constructor() { FakeContext.instances.push(this); }
  createGain() { return new FakeNode(); }
  createDynamicsCompressor() { return new FakeNode(); }
  createAnalyser() { return new FakeNode(); }
  createMediaElementSource(element) {
    if (FakeContext.routed.has(element)) throw new Error("element already routed");
    FakeContext.routed.add(element);
    const node = new FakeNode();
    this.sources.set(element, node);
    return node;
  }
  setSinkId(id) {
    return new Promise((resolve, reject) => this.requests.push({ id, resolve, reject }));
  }
  suspend() { this.state = "suspended"; return Promise.resolve(); }
  resume() { this.state = "running"; this.onstatechange?.(); return Promise.resolve(); }
  close() { this.state = "closed"; return Promise.resolve(); }
}

globalThis.Audio = FakeAudio;
globalThis.AudioContext = FakeContext;

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
});
after(() => vite.close());
const { AudioEngine } = await vite.ssrLoadModule("/src/lib/audio.ts");
const { EqChain } = await vite.ssrLoadModule("/src/lib/eq.ts");
const settings = (enabled, output = "") => ({
  eqEnabled: enabled, eqBands: [], eqLimiter: false, eqAutoPreamp: false,
  eqPreampDb: 0, eqOutputId: output,
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

function player() {
  const eq = new EqChain();
  const engine = new AudioEngine({
    shouldReplace: (element) => eq.canBypass && eq.hasSource(element),
    onElement: (element, phase) => phase === "created" ? eq.attach(element) : eq.detach(element),
  });
  eq.onRoutingChange(() => {
    if (eq.canBypass && eq.hasSource(engine.element)) engine.bypass();
    else engine.cancelBypass();
  });
  engine.load("http://127.0.0.1:1234/one", { autoplay: true });
  engine.element.metadata();
  engine.setVolume(0.5);
  engine.seek(42000);
  eq.apply(settings(true));
  return { eq, engine, original: engine.element, context: FakeContext.instances.at(-1) };
}

test("disabled EQ waits for a direct element, closes the graph, and can be enabled again", async () => {
  const { eq, engine, original, context } = player();
  eq.apply(settings(false));
  const direct = FakeAudio.instances.at(-1);
  await settle();
  assert.equal(engine.element, original);
  assert.equal(original.paused, false);
  assert.equal(context.state, "running");
  direct.metadata();
  await settle();
  assert.equal(engine.element, direct);
  assert.equal(direct.currentTime, 42);
  assert.equal(direct.volume, 0.5);
  assert.equal(direct.paused, false);
  assert.equal(original.paused, true);
  assert.equal(context.state, "closed");
  assert.equal(eq.hasSource(direct), false);

  eq.apply(settings(true));
  const nextContext = FakeContext.instances.at(-1);
  assert.notEqual(nextContext, context);
  assert.equal(eq.hasSource(direct), true);
  eq.apply(settings(false));
  const second = FakeAudio.instances.at(-1);
  await settle();
  second.metadata();
  await settle();
  assert.equal(engine.element, second);
  assert.equal(second.currentTime, 42);
  assert.equal(nextContext.state, "closed");
});

test("a failed replacement leaves the original playing until a new track is loaded", async () => {
  const { eq, engine, original, context } = player();
  eq.apply(settings(false));
  const candidate = FakeAudio.instances.at(-1);
  await settle();
  candidate.emit("error");
  await settle();
  assert.equal(engine.element, original);
  assert.equal(original.paused, false);
  assert.equal(eq.hasSource(original), true);
  assert.equal(context.state, "running");
  engine.load("http://127.0.0.1:1234/two", { autoplay: true });
  assert.notEqual(engine.element, original);
  assert.equal(eq.hasSource(engine.element), false);
  assert.equal(context.state, "closed");
});

test("replacement metadata updates the player when it arrives before the original", async () => {
  const eq = new EqChain();
  const loaded = [];
  const engine = new AudioEngine({
    shouldReplace: (element) => eq.canBypass && eq.hasSource(element),
    onElement: (element, phase) => phase === "created" ? eq.attach(element) : eq.detach(element),
    onLoaded: () => loaded.push(engine.positionMs),
  });
  eq.onRoutingChange(() => {
    if (eq.canBypass && eq.hasSource(engine.element)) engine.bypass();
    else engine.cancelBypass();
  });
  engine.load("http://127.0.0.1:1234/one", { autoplay: true, positionMs: 21000 });
  eq.apply(settings(true));
  eq.apply(settings(false));
  const direct = FakeAudio.instances.at(-1);
  await settle();
  direct.metadata();
  await settle();
  assert.equal(engine.element, direct);
  assert.equal(engine.positionMs, 21000);
  assert.deepEqual(loaded, [21000]);
});

test("a visible handover fades both elements before closing the graph", async () => {
  document.hidden = false;
  try {
    const { eq, engine, original, context } = player();
    eq.apply(settings(false));
    const direct = FakeAudio.instances.at(-1);
    await settle();
    direct.metadata();
    await settle();
    assert.equal(engine.element, direct);
    assert.equal(original.paused, false);
    assert.equal(context.state, "running");
    assert.equal(direct.volume, 0);
    const step = (now) => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(now);
    };
    step(performance.now() + 150);
    assert.ok(original.volume > 0 && original.volume < 0.5);
    assert.ok(direct.volume > 0 && direct.volume < 0.5);
    step(performance.now() + 500);
    assert.equal(original.paused, true);
    assert.equal(direct.volume, 0.5);
    assert.equal(context.state, "closed");
  } finally {
    document.hidden = true;
    frames.clear();
  }
});

test("selecting a non-default output after bypass starts a flat graph for that device", async () => {
  const { eq, engine, context } = player();
  eq.apply(settings(false));
  const direct = FakeAudio.instances.at(-1);
  await settle();
  direct.metadata();
  await settle();
  assert.equal(context.state, "closed");
  assert.equal(eq.hasSource(direct), false);

  eq.apply(settings(false, "headphones"));
  const selected = FakeContext.instances.at(-1);
  assert.notEqual(selected, context);
  assert.equal(eq.hasSource(direct), false);
  selected.requests.at(-1).resolve();
  await settle();
  assert.equal(engine.element, direct);
  assert.equal(eq.hasSource(direct), true);
  assert.equal(eq.outputId, "headphones");

  eq.apply(settings(false));
  selected.requests.at(-1).reject(new Error("unavailable"));
  await settle();
  assert.equal(eq.hasSource(direct), true);
  assert.equal(eq.outputId, "headphones");
  assert.notEqual(selected.state, "closed");
});

test("reenabling EQ cancels a pending replacement without rerouting the original", async () => {
  const { eq, engine, original, context } = player();
  eq.apply(settings(false));
  const candidate = FakeAudio.instances.at(-1);
  await settle();
  eq.apply(settings(true));
  candidate.metadata();
  await settle();
  assert.equal(engine.element, original);
  assert.equal(original.paused, false);
  assert.equal(candidate.src, "");
  assert.equal(context.sources.size, 1);
  assert.equal(eq.live, true);
});

test("a pause and seek during preparation are reflected in the direct element", async () => {
  const { eq, engine, original, context } = player();
  eq.apply(settings(false));
  const candidate = FakeAudio.instances.at(-1);
  await settle();
  engine.seek(67000);
  engine.pause();
  candidate.metadata();
  await settle();
  assert.equal(engine.element, candidate);
  assert.equal(candidate.currentTime, 67);
  assert.equal(candidate.paused, true);
  assert.equal(original.paused, true);
  assert.equal(context.state, "closed");
});

test("a new track does not reuse a paused routed element while bypass is pending", async () => {
  const { eq, engine, original, context } = player();
  engine.pause();
  eq.apply(settings(false));
  const candidate = FakeAudio.instances.at(-1);
  await settle();
  engine.load("http://127.0.0.1:1234/two");
  assert.notEqual(engine.element, original);
  assert.notEqual(engine.element, candidate);
  assert.equal(candidate.src, "");
  assert.equal(eq.hasSource(engine.element), false);
  assert.equal(context.state, "closed");
});

test("a pending non-default output cancels bypass and keeps the selected output", async () => {
  const { eq, engine, original, context } = player();
  eq.apply(settings(false));
  const candidate = FakeAudio.instances.at(-1);
  await settle();
  eq.apply(settings(false, "headphones"));
  assert.equal(candidate.src, "");
  assert.equal(context.requests.at(-1).id, "headphones");
  context.requests.at(-1).resolve();
  await settle();
  assert.equal(engine.element, original);
  assert.equal(eq.outputId, "headphones");
  assert.equal(eq.hasSource(original), true);
  engine.load("http://127.0.0.1:1234/two", { autoplay: true });
  assert.equal(eq.hasSource(engine.element), true);
  assert.equal(eq.outputId, "headphones");

  eq.apply(settings(false));
  assert.equal(context.requests.at(-1).id, "");
  context.requests.at(-1).resolve();
  await settle();
  const direct = FakeAudio.instances.at(-1);
  direct.metadata();
  await settle();
  assert.equal(engine.element, direct);
  assert.equal(context.state, "closed");
});
