import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
});

after(() => vite.close());
const { EqChain } = await vite.ssrLoadModule("/src/lib/eq.ts");

class FakeNode {
  responseCalls = 0;
  connections = new Set();
  gain = { value: 1 };
  frequency = { value: 0 };
  Q = { value: 0 };
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
  connect(node) { this.connections.add(node); return node; }
  disconnect() { this.connections.clear(); }
  getFrequencyResponse(_freqs, magnitudes) { this.responseCalls += 1; magnitudes.fill(2); }
}

class FakeContext {
  static instances = [];
  state = "suspended";
  sampleRate = 48000;
  destination = new FakeNode();
  sources = [];
  sourceNodes = [];
  gains = [];
  filters = [];
  limiters = [];
  analysers = [];
  onstatechange = null;

  constructor(options) { this.options = options; FakeContext.instances.push(this); }
  createGain() { const gain = new FakeNode(); this.gains.push(gain); return gain; }
  createDynamicsCompressor() { const node = new FakeNode(); this.limiters.push(node); return node; }
  createAnalyser() { const node = new FakeNode(); this.analysers.push(node); return node; }
  createBiquadFilter() { const filter = new FakeNode(); this.filters.push(filter); return filter; }
  createMediaElementSource(element) {
    if (element.fail) throw new Error("cannot route");
    this.sources.push(element);
    const node = new FakeNode();
    this.sourceNodes.push(node);
    return node;
  }
  resume() {
    return new Promise((resolve, reject) => {
      this.finishResume = () => { this.state = "running"; this.onstatechange?.(); resolve(); };
      this.rejectResume = reject;
    });
  }
  suspend() {
    return Promise.resolve().then(() => { this.state = "suspended"; this.onstatechange?.(); });
  }
  close() { this.state = "closed"; return Promise.resolve(); }
}

globalThis.AudioContext = FakeContext;
globalThis.window = {};

const settings = (enabled = true) => ({
  eqEnabled: enabled,
  eqBands: [],
  eqLimiter: false,
  eqAutoPreamp: false,
  eqPreampDb: 0,
  eqOutputId: "",
});

test("the equalizer uses the requested playback latency without starting for disabled EQ", () => {
  const before = FakeContext.instances.length;
  const eq = new EqChain({ latencyHint: "playback" });
  eq.apply(settings(false));
  assert.equal(FakeContext.instances.length, before);
  eq.apply(settings());
  const context = FakeContext.instances.at(-1);
  assert.deepEqual(context.options, { latencyHint: "playback" });
  eq.apply(settings(false));
  assert.equal(context.state, "closed");
  eq.apply(settings());
  assert.notEqual(FakeContext.instances.at(-1), context);
});

test("the equalizer leaves the audio context defaults unchanged without options", () => {
  const eq = new EqChain();
  eq.apply(settings());
  assert.equal(FakeContext.instances.at(-1).options, undefined);
});

test("disabling or blocking EQ keeps a unity path without filters or limiter", async () => {
  for (const action of ["disable", "block"]) {
    const eq = new EqChain();
    const element = { crossOrigin: "anonymous", paused: false };
    const config = {
      ...settings(), eqLimiter: true, eqPreampDb: -6,
      eqBands: [{ id: "boost", kind: "peaking", freq: 1000, q: 1, gain: 6, enabled: true }],
    };
    eq.attach(element);
    eq.apply(config);
    const context = FakeContext.instances.at(-1);
    context.finishResume();
    await Promise.resolve();
    const [input, output, preamp] = context.gains;
    const [filter] = context.filters;
    const [limiter] = context.limiters;
    const [source] = context.sourceNodes;
    assert.deepEqual([...source.connections], [input]);
    assert.deepEqual([...input.connections], [filter]);
    assert.deepEqual([...filter.connections], [preamp]);
    assert.deepEqual([...preamp.connections], [limiter]);
    assert.ok(preamp.gain.value < 1);

    if (action === "disable") eq.apply({ ...config, eqEnabled: false });
    else eq.block("cors");
    assert.deepEqual([...source.connections], [input]);
    assert.deepEqual([...input.connections], [preamp]);
    assert.deepEqual([...preamp.connections], [output]);
    assert.deepEqual([...filter.connections], []);
    assert.deepEqual([...output.connections], [context.destination, context.analysers[0]]);
    assert.equal(preamp.gain.value, 1);
    assert.equal(eq.preampDb, 0);
    assert.equal(eq.live, false);

    if (action === "disable") {
      eq.apply(config);
      assert.deepEqual([...input.connections], [filter]);
      assert.deepEqual([...preamp.connections], [limiter]);
      assert.equal(context.sourceNodes.length, 1);
      assert.equal(eq.live, true);
    }
  }
});

test("the response is cached until the equalizer settings or availability change", () => {
  const eq = new EqChain();
  const band = { id: "boost", kind: "peaking", freq: 1000, q: 1, gain: 6, enabled: true };
  eq.apply({ ...settings(), eqBands: [band] });
  const context = FakeContext.instances.at(-1);
  const filter = context.filters[0];
  assert.equal(filter.responseCalls, 0);
  const response = eq.curve();
  assert.equal(filter.responseCalls, 1);
  assert.ok(response[0] > 0);
  assert.equal(eq.curve(), response);
  assert.equal(filter.responseCalls, 1);

  eq.apply({ ...settings(), eqBands: [{ ...band, gain: 3 }] });
  eq.curve();
  assert.equal(filter.responseCalls, 2);
  eq.apply(settings(false));
  assert.equal(eq.curve().length, 0);
  assert.equal(filter.responseCalls, 2);
  eq.apply({ ...settings(), eqBands: [band] });
  const replacementFilter = FakeContext.instances.at(-1).filters[0];
  assert.ok(eq.curve()[0] > 0);
  assert.equal(replacementFilter.responseCalls, 1);
  eq.block("cors");
  assert.equal(eq.curve().length, 0);
  assert.equal(replacementFilter.responseCalls, 1);
});

test("a boosted suspended graph applies its automatic preamp before audio is routed", async () => {
  const eq = new EqChain();
  eq.attach({ crossOrigin: "anonymous" });
  eq.apply({
    ...settings(),
    eqAutoPreamp: true,
    eqBands: [{ id: "boost", kind: "peaking", freq: 1000, q: 1, gain: 6, enabled: true }],
  });
  const context = FakeContext.instances.at(-1);
  const expectedDb = -20 * Math.log10(2) - 0.5;
  assert.equal(eq.live, false);
  assert.ok(Math.abs(eq.preampDb - expectedDb) < 0.001);
  assert.ok(Math.abs(context.gains[2].gain.value - 10 ** (expectedDb / 20)) < 0.001);
  assert.equal(typeof context.finishResume, "function");
  context.finishResume();
  await Promise.resolve();
  assert.equal(eq.live, true);
  assert.ok(Math.abs(eq.preampDb - expectedDb) < 0.001);
});

test("a suspended graph routes existing elements once it actually resumes", async () => {
  const eq = new EqChain();
  const element = { crossOrigin: "anonymous" };
  const changes = [];
  eq.onStatusChange(() => changes.push(eq.live));
  eq.attach(element);
  eq.apply(settings());
  const context = FakeContext.instances.at(-1);
  assert.equal(eq.live, false);
  assert.deepEqual(context.sources, []);
  eq.resume();
  context.finishResume();
  await Promise.resolve();
  assert.deepEqual(context.sources, [element]);
  assert.equal(eq.live, true);
  eq.resume();
  assert.deepEqual(context.sources, [element]);
  context.state = "suspended";
  context.onstatechange();
  assert.equal(eq.live, false);
  assert.deepEqual(changes, [true, false]);
});

test("disabling the equalizer or retiring an element while resume is pending never routes it", async () => {
  for (const action of ["disable", "detach"]) {
    const eq = new EqChain();
    const element = { crossOrigin: "anonymous" };
    eq.attach(element);
    eq.apply(settings());
    const context = FakeContext.instances.at(-1);
    eq.resume();
    if (action === "disable") eq.apply(settings(false));
    else eq.detach(element);
    context.finishResume();
    await Promise.resolve();
    assert.deepEqual(context.sources, []);
    assert.equal(eq.live, false);
  }
});

test("unreadable or failed sources do not claim the equalizer is live", async () => {
  const eq = new EqChain();
  const plain = { crossOrigin: null };
  eq.attach(plain);
  eq.apply(settings());
  const context = FakeContext.instances.at(-1);
  eq.resume();
  context.finishResume();
  await Promise.resolve();
  assert.equal(eq.live, false);
  const failed = { crossOrigin: "anonymous", fail: true };
  eq.attach(failed);
  eq.detach(plain);
  assert.equal(eq.live, false);
  const readable = { crossOrigin: "anonymous" };
  eq.attach(readable);
  assert.equal(eq.live, false);
  if (context.state !== "running") {
    context.finishResume();
    await Promise.resolve();
  }
  eq.detach(failed);
  assert.equal(eq.live, true);
});

test("reenabling routes elements that arrived while the equalizer was off", async () => {
  const eq = new EqChain();
  const first = { crossOrigin: "anonymous" };
  eq.attach(first);
  eq.apply(settings());
  const context = FakeContext.instances.at(-1);
  eq.resume();
  context.finishResume();
  await Promise.resolve();
  eq.apply(settings(false));
  eq.detach(first);
  const next = { crossOrigin: "anonymous" };
  eq.attach(next);
  assert.equal(eq.live, false);
  eq.apply(settings());
  const replacement = FakeContext.instances.at(-1);
  replacement.finishResume();
  await Promise.resolve();
  assert.equal(eq.live, true);
  assert.equal(context.state, "closed");
  assert.deepEqual(replacement.sources, [next]);
});

test("new elements bypass the graph while the equalizer is off on the default output", async () => {
  const eq = new EqChain();
  const main = { crossOrigin: "anonymous" };
  const preview = { crossOrigin: "anonymous" };
  eq.attach(main);
  eq.apply(settings());
  const context = FakeContext.instances.at(-1);
  context.finishResume();
  await Promise.resolve();
  eq.apply(settings(false));
  eq.attach(preview);
  assert.deepEqual(context.sources, [main]);
  assert.equal(eq.live, false);
});

test("the audio graph sleeps only after every source pauses and resumes after a pause/play race", async () => {
  class Element extends EventTarget {
    paused = true;
    crossOrigin = "anonymous";
    play() { this.paused = false; this.dispatchEvent(new Event("play")); }
    pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
  }
  const eq = new EqChain();
  const main = new Element();
  const preview = new Element();
  eq.attach(main);
  eq.attach(preview);
  eq.apply(settings());
  const context = FakeContext.instances.at(-1);
  context.finishResume();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.state, "suspended");

  main.play();
  context.finishResume();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.state, "running");
  assert.deepEqual(context.sources, [main, preview]);

  preview.play();
  main.pause();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.state, "running");
  preview.pause();
  main.play();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.state, "suspended");
  context.finishResume();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.state, "running");

  main.pause();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.state, "suspended");
});

test("output changes are confirmed, serialized, and still work with a disabled graph", async () => {
  const requests = [];
  FakeContext.prototype.setSinkId = function(id) {
    return new Promise((resolve, reject) => requests.push({ id, resolve, reject }));
  };
  const eq = new EqChain();
  eq.attach({ crossOrigin: "anonymous" });
  eq.apply(settings());
  const context = FakeContext.instances.at(-1);
  context.finishResume();
  await Promise.resolve();

  eq.setOutput("first");
  eq.setOutput("second");
  assert.equal(eq.outputId, "");
  assert.deepEqual(requests.map((request) => request.id), ["first"]);
  requests[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eq.outputId, "first");
  assert.deepEqual(requests.map((request) => request.id), ["first", "second"]);
  requests[1].reject(new Error("unavailable"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eq.outputId, "first");

  eq.apply({ ...settings(false), eqOutputId: "" });
  assert.equal(requests[2].id, "");
  requests[2].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eq.outputId, "");
  delete FakeContext.prototype.setSinkId;
});
