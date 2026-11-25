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
  seeking = false;
  readyState = 1;
  currentTime = 0;
  duration = 120;
  src = "";
  pauses = 0;

  constructor() { FakeAudio.instances.push(this); }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name) { for (const callback of this.listeners.get(name) ?? []) callback(); }
  play() { this.paused = false; this.emit("play"); return Promise.resolve(); }
  pause() { this.pauses += 1; this.paused = true; this.emit("pause"); }
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
  connect() {}
  disconnect() {}
  getFrequencyResponse(_freqs, magnitudes) { magnitudes.fill(1); }
}

class FakeContext {
  static instances = [];
  state = "running";
  sampleRate = 48000;
  destination = new FakeNode();
  sources = [];

  constructor() { FakeContext.instances.push(this); }
  createGain() { return new FakeNode(); }
  createDynamicsCompressor() { return new FakeNode(); }
  createAnalyser() { return new FakeNode(); }
  createBiquadFilter() { return new FakeNode(); }
  createMediaElementSource(element) { this.sources.push(element); return new FakeNode(); }
  suspend() {
    return Promise.resolve().then(() => { this.state = "suspended"; this.onstatechange?.(); });
  }
  resume() {
    return Promise.resolve().then(() => { this.state = "running"; this.onstatechange?.(); });
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

test("enabling EQ keeps the playing element and its position", () => {
  const state = app.getState();
  const tracks = ["one", "two"].map((id) => ({
    id, title: id, path: `http://127.0.0.1:1234/${id}`, durationMs: 120000,
  }));
  state.tracks = tracks;
  state.tracksById = new Map(tracks.map((track) => [track.id, track]));
  state.settings.normalizeVolume = false;
  app.player.setQueue("queue", "Queue", ["one", "two"]);
  app.player.play();

  const audio = FakeAudio.instances.at(-1);
  audio.currentTime = 42;
  assert.equal(audio.crossOrigin, "anonymous");
  const count = FakeAudio.instances.length;
  app.setEqEnabled(true);

  assert.equal(FakeAudio.instances.length, count);
  assert.equal(audio.paused, false);
  assert.equal(audio.pauses, 0);
  assert.equal(audio.currentTime, 42);
  assert.equal(app.eqStatus().live, true);
  assert.deepEqual(FakeContext.instances.at(-1).sources, [audio]);

  app.setEqEnabled(false);
  assert.equal(FakeAudio.instances.length, count);
  assert.equal(audio.paused, false);
  assert.equal(audio.currentTime, 42);
});

test("tracks loaded with EQ off can be routed without reloading", () => {
  app.player.next();
  const audio = FakeAudio.instances.at(-1);
  audio.currentTime = 17;
  assert.equal(audio.crossOrigin, "anonymous");
  const count = FakeAudio.instances.length;
  app.setEqEnabled(true);

  assert.equal(FakeAudio.instances.length, count);
  assert.equal(audio.paused, false);
  assert.equal(audio.pauses, 0);
  assert.equal(audio.currentTime, 17);
  assert.equal(app.eqStatus().live, true);
  assert.equal(FakeContext.instances.at(-1).sources.at(-1), audio);
});

test("toggling EQ while paused preserves the element and position", () => {
  app.player.pause();
  app.player.finishTransitions();
  const audio = FakeAudio.instances.at(-1);
  const count = FakeAudio.instances.length;
  const pauses = audio.pauses;
  app.setEqEnabled(false);
  app.setEqEnabled(true);

  assert.equal(FakeAudio.instances.length, count);
  assert.equal(audio.paused, true);
  assert.equal(audio.pauses, pauses);
  assert.equal(audio.currentTime, 17);
  assert.equal(app.eqStatus().live, true);
  app.player.play();
});

test("changing tracks during a CORS retry keeps the next track EQ-readable", () => {
  app.setEqEnabled(false);
  FakeAudio.instances.at(-1).emit("error");
  const fallback = FakeAudio.instances.at(-1);
  assert.equal(fallback.crossOrigin, null);

  app.player.previous();
  const next = FakeAudio.instances.at(-1);
  assert.notEqual(next, fallback);
  assert.equal(next.crossOrigin, "anonymous");
  next.emit("loadedmetadata");
  assert.equal(app.eqStatus().blocked, null);
  app.player.next();
});

test("a failed plain retry does not disable EQ for later playback", () => {
  app.setEqEnabled(false);
  const audio = FakeAudio.instances.at(-1);
  audio.currentTime = 23;
  audio.emit("error");

  const fallback = FakeAudio.instances.at(-1);
  assert.notEqual(fallback, audio);
  assert.equal(fallback.crossOrigin, null);
  assert.equal(fallback.currentTime, 23);
  assert.equal(fallback.paused, false);
  assert.equal(app.eqStatus().blocked, null);

  fallback.paused = true;
  fallback.emit("error");
  assert.equal(app.eqStatus().blocked, null);
  assert.match(app.getState().notice, /Could not play/);
  app.player.play();
  assert.equal(FakeAudio.instances.at(-1), fallback);
  assert.equal(fallback.crossOrigin, "anonymous");
  assert.equal(fallback.paused, false);
});

test("a successful plain retry marks EQ unavailable", () => {
  app.getState().notice = null;
  const audio = FakeAudio.instances.at(-1);
  audio.currentTime = 23;
  audio.emit("error");

  const fallback = FakeAudio.instances.at(-1);
  assert.notEqual(fallback, audio);
  assert.equal(fallback.crossOrigin, null);
  assert.equal(fallback.currentTime, 23);
  assert.equal(fallback.paused, false);
  fallback.emit("loadedmetadata");
  assert.equal(app.eqStatus().blocked, "cors");
  assert.equal(app.getState().notice, null);
});
