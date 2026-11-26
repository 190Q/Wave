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
    clearInterval() { this.check = null; },
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
    samples: 0,
    snapshot() { return { playing: this.playing, currentId: this.currentId }; },
    onChange(listener) { this.change = listener; },
    sampleListening() { this.samples += 1; },
    reloadCurrent() { this.reloads += 1; },
    pause() { this.pauses += 1; this.playing = false; this.change(); },
    pauseForInterruption() { this.pause(); },
  };
  mountAudioWatchdog(engine, player, (message) => reports.push(message));
  const check = (ms = 1000) => {
    clock.advance(ms);
    window.check();
  };
  window.check();
  return { engine, player, reports, check };
}

test("the watchdog only runs while a track is playing", (t) => {
  const { player, check } = watchdog(t);
  assert.equal(typeof window.check, "function");
  player.pause();
  assert.equal(window.check, null);
  player.playing = true;
  player.change();
  assert.equal(typeof window.check, "function");
  for (let i = 0; i < 4; i += 1) check();
  assert.equal(player.reloads, 0);
  check();
  assert.equal(player.reloads, 0);
  check();
  assert.equal(player.reloads, 1);
});

test("background listening is sampled without a separate timer", (t) => {
  const { player, check } = watchdog(t, true);
  assert.equal(player.samples, 1);
  check();
  assert.equal(player.samples, 2);
  document.hidden = false;
  check();
  assert.equal(player.samples, 2);
  player.pause();
  assert.equal(window.check, null);
});

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
  assert.equal(reports[0], "Playback stopped unexpectedly. Wave is trying to resume the song.");
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

test("an unexpected background pause is reconciled after the longer grace period", (t) => {
  const { engine, player, reports, check } = watchdog(t, true);
  engine.element.paused = true;
  for (let i = 0; i < 14; i += 1) check();
  assert.equal(player.pauses, 0);
  check();
  assert.equal(player.pauses, 1);
  assert.equal(reports[0], "Playback was interrupted by your device. Press play to resume.");
});

function interruptedPlayback(t, hidden = false, reconcile = true) {
  const clock = environment(t, hidden);
  globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
  globalThis.Audio = class {
    paused = true;
    ended = false;
    seeking = false;
    currentTime = 0;
    duration = 120;
    readyState = 1;
    listeners = new Map();
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    removeEventListener(name) { this.listeners.delete(name); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === "src") this.src = ""; }
    load() {}
    dispatch(name) { this.listeners.get(name)?.(); }
  };
  let player;
  const engine = new AudioEngine({
    onPlaying: () => player.handlePlaying(),
    onPause: () => player.handlePaused(),
  });
  player = new Player(engine, (id) => ({
    path: `http://127.0.0.1:1234/${id}`, durationMs: 120000, gain: 1,
  }));
  mountAudioWatchdog(engine, player, () => {});
  player.setQueue("queue", "Queue", ["one", "two"]);
  player.play();
  player.finishTransitions();
  engine.element.paused = true;
  if (reconcile) {
    for (let i = 0; i < (hidden ? 16 : 6); i += 1) {
      clock.advance(1000);
      window.check();
    }
    assert.equal(player.snapshot().playing, false);
    player.finishTransitions();
  }
  return { engine, player };
}

for (const hidden of [false, true]) {
  test(`an external pause is reflected immediately and resumes in place when ${hidden ? "hidden" : "visible"}`, (t) => {
    const { engine, player } = interruptedPlayback(t, hidden, false);
    const element = engine.element;
    element.currentTime = 42;
    element.dispatch("pause");
    assert.equal(player.snapshot().playing, false);
    assert.equal(player.positionMs, 42000);
    assert.ok(element.volume > 0);
    assert.equal(window.check, null);

    element.paused = false;
    player.finishTransitions();
    assert.equal(element.paused, false);
    assert.ok(element.volume > 0);
    element.dispatch("playing");
    assert.equal(player.snapshot().playing, true);
    assert.equal(engine.element, element);
    assert.equal(player.positionMs, 42000);
    assert.ok(element.volume > 0);
  });
}

test("a stale pause event cannot interrupt an element already playing", (t) => {
  const { engine, player } = interruptedPlayback(t, false, false);
  engine.element.paused = false;
  engine.element.dispatch("pause");
  assert.equal(player.snapshot().playing, true);
});

test("an external pause during a fade preserves the requested volume for automatic playback", (t) => {
  const { engine, player } = interruptedPlayback(t, false, false);
  player.setVolume(40);
  engine.element.dispatch("pause");
  assert.equal(engine.element.volume, 0.4 * 0.7);
  engine.element.paused = false;
  engine.element.dispatch("playing");
  assert.equal(engine.element.volume, 0.4 * 0.7);
});

test("volume changes made during an interruption are applied before automatic playback", (t) => {
  const { engine, player } = interruptedPlayback(t, false, false);
  engine.element.dispatch("pause");
  player.setVolume(40);
  assert.equal(engine.element.volume, 0.4 * 0.7);
  player.toggleMute();
  assert.equal(engine.element.volume, 0);
  player.toggleMute();
  assert.equal(engine.element.volume, 0.4 * 0.7);
});

test("a manual pause after an external pause prevents automatic playback and keeps the position", (t) => {
  const { engine, player } = interruptedPlayback(t, false, false);
  const old = engine.element;
  old.currentTime = 42;
  old.dispatch("pause");
  player.pause();
  assert.notEqual(engine.element, old);
  assert.equal(engine.positionMs, 42000);
  old.paused = false;
  old.dispatch("playing");
  assert.equal(player.snapshot().playing, false);
  assert.equal(engine.element.paused, true);
});

test("an interrupted element restores the player and volume when it resumes", (t) => {
  const { engine, player } = interruptedPlayback(t);
  assert.ok(engine.element.volume > 0);
  engine.element.paused = false;
  engine.element.dispatch("playing");
  assert.equal(player.snapshot().playing, true);
  player.finishTransitions();
  assert.ok(engine.element.volume > 0);
  assert.equal(typeof window.check, "function");
});

test("a user pause during an interruption prevents an automatic resume", (t) => {
  const { engine, player } = interruptedPlayback(t);
  const old = engine.element;
  player.pause();
  assert.notEqual(engine.element, old);
  assert.equal(old.src, "");
  assert.equal(old.listeners.has("playing"), false);
  engine.element.paused = false;
  engine.element.dispatch("playing");
  assert.equal(player.snapshot().playing, false);
  assert.equal(engine.element.paused, true);
});

test("a user pause before the watchdog fires retires the interrupted element", (t) => {
  const { engine, player } = interruptedPlayback(t, false, false);
  const old = engine.element;
  player.pause();
  assert.equal(player.snapshot().playing, false);
  assert.notEqual(engine.element, old);
  assert.equal(old.src, "");
  assert.equal(old.listeners.has("playing"), false);
});

test("a long background interruption can resume without losing volume", (t) => {
  const { engine, player } = interruptedPlayback(t, true);
  engine.element.paused = false;
  engine.element.dispatch("playing");
  assert.equal(player.snapshot().playing, true);
  assert.ok(engine.element.volume > 0);
});

test("a stale playing event cannot resume an element that is still paused", (t) => {
  const { engine, player } = interruptedPlayback(t);
  engine.element.dispatch("playing");
  assert.equal(player.snapshot().playing, false);
  engine.element.paused = false;
  engine.element.dispatch("playing");
  assert.equal(player.snapshot().playing, true);
});

test("replacing a track cancels the old interruption", (t) => {
  const { engine, player } = interruptedPlayback(t);
  player.moveTo("two");
  engine.element.paused = false;
  engine.element.dispatch("playing");
  assert.equal(player.snapshot().playing, false);
  assert.equal(engine.element.paused, true);
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
