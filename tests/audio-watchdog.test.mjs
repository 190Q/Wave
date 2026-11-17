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
  plugins: [{
    name: "watchdog-test-device",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "./device" && /[\\/]src[\\/]lib[\\/]player\.ts/.test(importer ?? "")) {
        return "\0watchdog-test-device";
      }
    },
    load(id) {
      if (id === "\0watchdog-test-device") return "export const isAndroidPlatform = false;";
    },
  }],
});
after(() => vite.close());

const { mountAudioWatchdog } = await vite.ssrLoadModule("/src/lib/audio-watchdog.ts");
const { AudioEngine } = await vite.ssrLoadModule("/src/lib/audio.ts");
const { Player } = await vite.ssrLoadModule("/src/lib/player.ts");

function environment(t, hidden = false) {
  const saved = new Map(["performance", "document", "window", "requestAnimationFrame", "Audio", "HTMLMediaElement"]
    .map((key) => [key, globalThis[key]]));
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });

  let now = 0;
  globalThis.performance = { now: () => now };
  globalThis.document = { hidden, addEventListener() {} };
  globalThis.window = {
    setInterval(callback) { this.check = callback; return 1; },
    cancelAnimationFrame() {},
  };
  globalThis.requestAnimationFrame = () => 1;

  return { advance: (ms) => { now += ms; } };
}

function audioElement() {
  return { paused: false, ended: false, seeking: false, volume: 1, muted: false, readyState: 4, networkState: 1 };
}

function watchdog(t, hidden = false) {
  const clock = environment(t, hidden);
  const reports = [];
  const engine = { element: audioElement(), positionMs: 0 };
  const player = {
    playing: true,
    currentId: "one",
    reloads: 0,
    pauses: 0,
    snapshot() { return { playing: this.playing, currentId: this.currentId }; },
    reloadCurrent() { this.reloads += 1; },
    pause() { this.pauses += 1; this.playing = false; },
  };
  mountAudioWatchdog(engine, player, (message) => reports.push(message));
  const check = (ms = 1000) => {
    clock.advance(ms);
    window.check();
  };
  window.check();
  return { engine, player, reports, check };
}

test("bunched callbacks do not count as seconds of stalled playback", (t) => {
  const { player, check } = watchdog(t);
  for (let i = 0; i < 49; i += 1) check(100);
  assert.equal(player.reloads, 0);
  check(100);
  assert.equal(player.reloads, 1);
});

test("any media progress prevents a reload", (t) => {
  const { engine, player, check } = watchdog(t);
  for (let i = 0; i < 20; i += 1) {
    engine.positionMs += 100;
    check();
  }
  assert.equal(player.reloads, 0);
});

test("background timer gaps do not count as observed stalls", (t) => {
  const { engine, player, check } = watchdog(t, true);
  for (let i = 0; i < 4; i += 1) check();
  check(60000);
  for (let i = 0; i < 14; i += 1) check();
  assert.equal(player.reloads, 0);
  engine.positionMs += 1000;
  check();
  assert.equal(player.reloads, 0);
});

test("a sustained background stall is retried after a longer grace period", (t) => {
  const { player, reports, check } = watchdog(t, true);
  for (let i = 0; i < 14; i += 1) check();
  assert.equal(player.reloads, 0);
  check();
  assert.equal(player.reloads, 1);
  assert.match(reports[0], /asked for again/);
  for (let i = 0; i < 5; i += 1) check();
  assert.equal(player.reloads, 1);
});

test("seeks, track changes, element changes, and visibility changes reset stall detection", (t) => {
  const { engine, player, check } = watchdog(t);
  for (let i = 0; i < 4; i += 1) check();
  engine.element.seeking = true;
  check();
  for (let i = 0; i < 4; i += 1) check();
  engine.element.seeking = false;
  check();
  for (let i = 0; i < 4; i += 1) check();
  player.currentId = "two";
  check();
  for (let i = 0; i < 4; i += 1) check();
  engine.element = audioElement();
  check();
  for (let i = 0; i < 4; i += 1) check();
  document.hidden = true;
  check();
  for (let i = 0; i < 14; i += 1) check();
  document.hidden = false;
  check();
  assert.equal(player.reloads, 0);
  for (let i = 0; i < 5; i += 1) check();
  assert.equal(player.reloads, 1);
});

test("an unexpected pause is reconciled only when visible", (t) => {
  const { engine, player, reports, check } = watchdog(t, true);
  engine.element.paused = true;
  for (let i = 0; i < 20; i += 1) check();
  assert.equal(player.pauses, 0);
  document.hidden = false;
  check();
  for (let i = 0; i < 5; i += 1) check();
  assert.equal(player.pauses, 1);
  assert.match(reports[0], /taken away by the system/);
});

test("reloading uses the media clock rather than the extrapolated display position", (t) => {
  const clock = environment(t, true);
  globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
  globalThis.Audio = class {
    paused = true;
    ended = false;
    seeking = false;
    currentTime = 0;
    duration = 120;
    readyState = 1;
    addEventListener() {}
    removeEventListener() {}
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute() {}
    load() {}
  };

  const engine = new AudioEngine();
  const player = new Player(engine, (id) => ({
    path: `http://127.0.0.1:1234/${id}`, durationMs: 120000, gain: 1,
  }));
  player.setQueue("queue", "Queue", ["one"]);
  player.play();
  engine.element.currentTime = 30;
  assert.equal(player.positionMs, 30000);
  clock.advance(500);
  assert.equal(player.positionMs, 30400);
  player.reloadCurrent();
  assert.equal(engine.positionMs, 30000);
});
