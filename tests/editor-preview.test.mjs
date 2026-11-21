import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: "Windows" },
});
globalThis.document = { hidden: true, addEventListener() {} };
globalThis.window = {
  setTimeout() { return 1; },
  clearTimeout() {},
  setInterval() { return 1; },
  clearInterval() {},
  cancelAnimationFrame() {},
};
globalThis.requestAnimationFrame = () => 1;
globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };

class FakeAudio {
  static instances = [];
  listeners = new Map();
  paused = true;
  ended = false;
  readyState = 1;
  currentTime = 0;
  duration = 120;
  src = "";

  constructor() { FakeAudio.instances.push(this); }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name) { for (const callback of this.listeners.get(name) ?? []) callback(); }
  play() { this.paused = false; this.emit("play"); return Promise.resolve(); }
  pause() { this.paused = true; this.emit("pause"); }
  removeAttribute() { this.src = ""; }
  load() {}
}

class FakeNode {
  gain = { value: 0 };
  frequency = { value: 0 };
  Q = { value: 0 };
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
  connections = [];
  disconnected = false;
  connect(node) { this.connections.push(node); }
  disconnect() { this.disconnected = true; }
  getFrequencyResponse(_freqs, magnitudes) { magnitudes.fill(1); }
}

class FakeContext {
  static instances = [];
  state = "running";
  sampleRate = 48000;
  destination = new FakeNode();
  sources = new Map();
  filters = [];

  constructor() { FakeContext.instances.push(this); }
  createGain() { return new FakeNode(); }
  createDynamicsCompressor() { return new FakeNode(); }
  createAnalyser() { return new FakeNode(); }
  createBiquadFilter() { const filter = new FakeNode(); this.filters.push(filter); return filter; }
  createMediaElementSource(element) {
    assert.equal(this.sources.has(element), false);
    const source = new FakeNode();
    this.sources.set(element, source);
    return source;
  }
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
const app = await vite.ssrLoadModule("/src/lib/state.ts");
const { gainFor } = await vite.ssrLoadModule("/src/lib/loudness.ts");

test("preview follows playback volume, mute, selected track gain and the shared equaliser", () => {
  const state = app.getState();
  const current = {
    id: "current", title: "Current", path: "http://127.0.0.1:1234/current",
    durationMs: 120000, lufs: -14, peak: 0.5,
  };
  const edited = {
    id: "edited", title: "Edited", path: "http://127.0.0.1:1234/edited",
    durationMs: 120000, lufs: -20, peak: 0.5,
  };
  state.tracksById = new Map([[current.id, current], [edited.id, edited]]);
  state.settings.normalizeVolume = true;
  app.player.setQueue("queue", "Queue", [current.id]);
  app.player.setVolume(37.4);
  app.player.play();
  const main = FakeAudio.instances.at(-1);
  const before = app.player.snapshot();
  app.setEqEnabled(true);

  const preview = new Audio();
  preview.crossOrigin = "anonymous";
  const disconnect = app.connectPreviewAudio(preview, edited.id, () => true);
  const context = FakeContext.instances.at(-1);
  assert.equal(context.sources.get(preview).connections[0], context.sources.get(main).connections[0]);
  assert.equal(preview.volume, Math.min(1, 0.374 * 0.7 * gainFor(edited)));
  assert.equal(app.player.snapshot().currentId, before.currentId);
  assert.equal(app.player.snapshot().playing, before.playing);
  const sameTrack = new Audio();
  sameTrack.crossOrigin = "anonymous";
  const disconnectSameTrack = app.connectPreviewAudio(sameTrack, current.id, () => true);
  assert.equal(sameTrack.volume, main.volume);
  disconnectSameTrack();

  app.addEqBand();
  const band = state.settings.eqBands.at(-1);
  app.updateEqBand(band.id, { gain: 8 });
  assert.equal(context.filters.at(-1).gain.value, 8);
  app.setEqPreampDb(-3);
  assert.equal(app.eqChain.preampDb, -3);

  app.player.setVolume(80);
  assert.equal(preview.volume, Math.min(1, 0.8 * 0.7 * gainFor(edited)));
  app.player.toggleMute();
  assert.equal(preview.volume, 0);
  app.player.toggleMute();
  assert.equal(preview.volume, Math.min(1, 0.8 * 0.7 * gainFor(edited)));

  state.settings.normalizeVolume = false;
  app.setEqPreampDb(-4);
  assert.equal(preview.volume, 0.8 * 0.7);
  state.settings.normalizeVolume = true;
  edited.lufs = -14;
  app.setEqPreampDb(-5);
  assert.equal(preview.volume, 0.8 * 0.7);

  const source = context.sources.get(preview);
  disconnect();
  assert.equal(source.disconnected, true);
  const oldVolume = preview.volume;
  app.player.setVolume(25);
  assert.equal(preview.volume, oldVolume);
  assert.equal(preview.listeners.get("play").size, 0);
});

test("replacement and plain fallback audio retain playback volume without stale track loudness", () => {
  const state = app.getState();
  const edited = state.tracksById.get("edited");
  edited.lufs = -25;
  state.settings.normalizeVolume = true;
  app.player.setVolume(50);
  app.setEqEnabled(false);

  const replacement = new Audio();
  replacement.crossOrigin = "anonymous";
  const disconnect = app.connectPreviewAudio(replacement, edited.id, () => false);
  const context = FakeContext.instances.at(-1);
  assert.equal(replacement.volume, 0.5 * 0.7);
  assert.ok(context.sources.has(replacement));
  app.setEqEnabled(true);
  assert.equal(context.sources.get(replacement).disconnected, false);
  disconnect();
  assert.equal(context.sources.get(replacement).disconnected, true);

  const fallback = new Audio();
  fallback.crossOrigin = null;
  const disconnectFallback = app.connectPreviewAudio(fallback, edited.id, () => true);
  assert.equal(context.sources.has(fallback), false);
  assert.equal(fallback.volume, Math.min(1, 0.5 * 0.7 * gainFor(edited)));
  app.player.setVolume(0);
  assert.equal(fallback.volume, 0);
  disconnectFallback();
});
