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
  gain = { value: 0 };
  frequency = { value: 0 };
  Q = { value: 0 };
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
  connect() {}
  disconnect() {}
  getFrequencyResponse(_freqs, magnitudes) { this.responseCalls += 1; magnitudes.fill(2); }
}

class FakeContext {
  static instances = [];
  state = "suspended";
  sampleRate = 48000;
  destination = new FakeNode();
  sources = [];
  gains = [];
  filters = [];
  onstatechange = null;

  constructor() { FakeContext.instances.push(this); }
  createGain() { const gain = new FakeNode(); this.gains.push(gain); return gain; }
  createDynamicsCompressor() { return new FakeNode(); }
  createAnalyser() { return new FakeNode(); }
  createBiquadFilter() { const filter = new FakeNode(); this.filters.push(filter); return filter; }
  createMediaElementSource(element) {
    if (element.fail) throw new Error("cannot route");
    this.sources.push(element);
    return new FakeNode();
  }
  resume() {
    return new Promise((resolve, reject) => {
      this.finishResume = () => { this.state = "running"; this.onstatechange?.(); resolve(); };
      this.rejectResume = reject;
    });
  }
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
  assert.equal(eq.curve()[0], 0);
  assert.equal(filter.responseCalls, 2);
  eq.apply({ ...settings(), eqBands: [band] });
  assert.ok(eq.curve()[0] > 0);
  assert.equal(filter.responseCalls, 3);
  eq.block("cors");
  assert.equal(eq.curve()[0], 0);
  assert.equal(filter.responseCalls, 3);
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
  assert.equal(eq.live, true);
  assert.deepEqual(context.sources, [first, next]);
});
