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

const { AudioEngine } = await vite.ssrLoadModule("/src/lib/audio.ts");

function environment(t) {
  const keys = ["performance", "document", "window", "Audio", "HTMLMediaElement", "requestAnimationFrame"];
  const saved = new Map(keys.map((key) => [key, globalThis[key]]));
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });

  let now = 0;
  globalThis.performance = { now: () => now };
  globalThis.document = { hidden: true, addEventListener() {} };
  globalThis.window = { cancelAnimationFrame() {} };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
  globalThis.Audio = class {
    listeners = new Map();
    paused = true;
    ended = false;
    seeking = false;
    readyState = 1;
    networkState = 1;
    currentTime = 0;
    duration = 120;

    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name, callback) {
      if (this.listeners.get(name) === callback) this.listeners.delete(name);
    }
    emit(name) { this.listeners.get(name)?.(); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; this.emit("pause"); }
    removeAttribute() {}
    load() {}
  };
  return { advance(ms) { now += ms; } };
}

test("reports only sustained buffering after playback starts", (t) => {
  const clock = environment(t);
  const reports = [];
  const engine = new AudioEngine({ onBuffering: (ms, element) => reports.push({ ms, element }) });
  engine.load("http://127.0.0.1:1234/one", { autoplay: true });
  const audio = engine.element;

  audio.emit("waiting");
  clock.advance(1000);
  audio.emit("playing");
  assert.deepEqual(reports, []);

  audio.emit("waiting");
  clock.advance(100);
  audio.emit("playing");
  assert.deepEqual(reports, []);

  audio.emit("waiting");
  clock.advance(300);
  audio.emit("waiting");
  clock.advance(200);
  audio.emit("playing");
  assert.deepEqual(reports, [{ ms: 500, element: audio }]);

  audio.emit("waiting");
  clock.advance(250);
  audio.emit("playing");
  assert.deepEqual(reports.map((report) => report.ms), [500, 250]);
});

test("seeks and pauses cancel a pending buffering report", (t) => {
  const clock = environment(t);
  const reports = [];
  const engine = new AudioEngine({ onBuffering: (ms) => reports.push(ms) });
  engine.load("http://127.0.0.1:1234/one", { autoplay: true });
  const audio = engine.element;
  audio.emit("playing");

  audio.emit("waiting");
  clock.advance(300);
  audio.seeking = true;
  audio.emit("seeking");
  audio.emit("waiting");
  clock.advance(300);
  audio.seeking = false;
  audio.emit("playing");

  audio.emit("waiting");
  clock.advance(300);
  audio.pause();
  clock.advance(300);
  void audio.play();
  audio.emit("playing");
  assert.deepEqual(reports, []);
});

test("retired and reused elements cannot report the previous track's buffering", (t) => {
  const clock = environment(t);
  const reports = [];
  const engine = new AudioEngine({ onBuffering: (ms) => reports.push(ms) });
  engine.load("http://127.0.0.1:1234/one", { autoplay: true });
  const old = engine.element;
  old.emit("playing");
  old.emit("waiting");
  clock.advance(500);
  engine.load("http://127.0.0.1:1234/two", { autoplay: true });
  old.emit("playing");
  const current = engine.element;
  current.emit("waiting");
  clock.advance(500);
  current.emit("playing");
  assert.deepEqual(reports, []);

  current.pause();
  engine.load("http://127.0.0.1:1234/three", { autoplay: true });
  assert.equal(engine.element, current);
  current.emit("waiting");
  clock.advance(500);
  current.emit("playing");
  assert.deepEqual(reports, []);
  current.emit("waiting");
  clock.advance(300);
  current.emit("playing");
  assert.deepEqual(reports, [300]);
});

test("a reused element treats a new CORS failure as an unloaded track", (t) => {
  environment(t);
  let refusals = 0;
  let errors = 0;
  const engine = new AudioEngine({
    onCorsRefused: () => { refusals += 1; },
    onError: () => { errors += 1; },
  });
  engine.load("http://127.0.0.1:1234/one");
  engine.element.emit("loadedmetadata");
  engine.load("http://127.0.0.1:1234/two");
  engine.element.emit("error");
  assert.equal(refusals, 1);
  assert.equal(errors, 0);
});

test("a pending seek remains visible before its metadata event applies the position", (t) => {
  environment(t);
  const positions = [];
  let engine;
  engine = new AudioEngine({ onLoaded: () => positions.push(engine.positionMs) });
  engine.element.readyState = 0;
  engine.load("http://127.0.0.1:1234/one", { positionMs: 42000 });
  const audio = engine.element;
  assert.equal(engine.positionMs, 42000);

  audio.readyState = 1;
  audio.emit("durationchange");
  assert.deepEqual(positions, [42000]);
  audio.emit("loadedmetadata");
  assert.equal(audio.currentTime, 42);
  assert.equal(engine.positionMs, 42000);
  assert.deepEqual(positions, [42000, 42000]);
});
