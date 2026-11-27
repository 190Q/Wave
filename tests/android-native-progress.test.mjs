import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: "Android" },
});
globalThis.document = { hidden: false, addEventListener() {} };
globalThis.window = {
  setTimeout() { return 1; },
  clearTimeout() {},
  cancelAnimationFrame() {},
};
globalThis.requestAnimationFrame = () => 1;
globalThis.Audio = class {
  paused = true;
  ended = false;
  seeking = false;
  addEventListener() {}
  removeEventListener() {}
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
});
after(() => vite.close());
const { AndroidAudioEngine } = await vite.ssrLoadModule("/src/lib/android-audio.ts");
const { Player } = await vite.ssrLoadModule("/src/lib/player.ts");

async function setup() {
  const messages = [];
  const state = (patch = {}) => ({
    type: "state", available: true, live: true, currentId: "one", path: "/one",
    positionMs: 10000, durationMs: 120000, playing: false, ...patch,
  });
  const bridge = {
    onmessage: null,
    postMessage(data) {
      const message = JSON.parse(data);
      messages.push(message);
      if (message.type === "connect") this.emit(state({ type: "snapshot" }));
    },
    emit(message) { this.onmessage({ data: JSON.stringify(message) }); },
  };
  window.waveNativePlayback = bridge;
  const engine = new AndroidAudioEngine({}, () => {});
  await engine.connect();
  const sources = new Map([
    ["one", { path: "/one", durationMs: 120000, gain: 1 }],
    ["two", { path: "/two", durationMs: 180000, gain: 1 }],
  ]);
  const player = new Player(engine, (id) => sources.get(id));
  engine.onState((snapshot) => {
    if (snapshot.currentId) player.followNative(snapshot.currentId, snapshot.playing);
  });
  const progress = [];
  player.onProgress((position, duration) => progress.push({ position, duration }));
  player.setQueue("queue", "Queue", ["one", "two"]);
  bridge.emit(state({ positionMs: 0, commandId: messages.at(-1).commandId }));
  return { bridge, engine, messages, player, progress, state };
}

test("a paused seek is visible immediately and ignores older native snapshots", async () => {
  const { bridge, messages, player, progress, state } = await setup();
  player.seek(45000);
  const command = messages.at(-1);
  assert.equal(command.type, "seek");
  assert.equal(player.positionMs, 45000);
  assert.deepEqual(progress.at(-1), { position: 45000, duration: 120000 });

  bridge.emit(state({ positionMs: 0 }));
  assert.equal(player.positionMs, 45000);
  bridge.emit(state({ positionMs: 45000, commandId: command.commandId }));
  assert.equal(player.positionMs, 45000);

  bridge.emit(state({ positionMs: 46000 }));
  assert.deepEqual(progress.at(-1), { position: 46000, duration: 120000 });
});

test("rapid seeks keep the latest position until its own acknowledgement", async () => {
  const { bridge, messages, player, state } = await setup();
  player.seek(15000);
  const first = messages.at(-1);
  player.seek(30000);
  const second = messages.at(-1);
  bridge.emit(state({ positionMs: 15000, commandId: first.commandId }));
  bridge.emit(state({ positionMs: 15000 }));
  assert.equal(player.positionMs, 30000);
  bridge.emit(state({ positionMs: 30000, commandId: second.commandId }));
  assert.equal(player.positionMs, 30000);
  bridge.emit(state({ positionMs: 15000, commandId: first.commandId }));
  assert.equal(player.positionMs, 30000);
});

test("switching songs resets position and duration before the native load completes", async () => {
  const { bridge, messages, player, progress, state } = await setup();
  player.seek(60000);
  bridge.emit(state({ positionMs: 60000, commandId: messages.at(-1).commandId }));
  player.moveTo("two");
  const load = messages.at(-1);
  assert.equal(load.type, "load");
  assert.equal(player.snapshot().currentId, "two");
  assert.equal(player.positionMs, 0);
  assert.deepEqual(progress.at(-1), { position: 0, duration: 180000 });

  bridge.emit(state({ positionMs: 60000 }));
  assert.equal(player.positionMs, 0);
  bridge.emit(state({ currentId: "two", path: "/two", positionMs: 0, durationMs: 180000, commandId: load.commandId }));
  assert.deepEqual(progress.at(-1), { position: 0, duration: 180000 });
});

test("a seek during a pending load supersedes the load acknowledgement", async () => {
  const { bridge, messages, player, state } = await setup();
  player.moveTo("two");
  const load = messages.at(-1);
  player.seek(90000);
  const seek = messages.at(-1);
  bridge.emit(state({ currentId: "two", path: "/two", positionMs: 0, durationMs: 180000, commandId: load.commandId }));
  assert.equal(player.positionMs, 90000);
  assert.equal(player.currentDurationMs, 180000);
  bridge.emit(state({ currentId: "two", path: "/two", positionMs: 90000, durationMs: 180000, commandId: seek.commandId }));
  assert.equal(player.positionMs, 90000);
});

test("play and pause update the pending clock without losing the requested position", async () => {
  const { bridge, engine, messages, player, state } = await setup();
  player.seek(20000);
  const seek = messages.at(-1);
  player.play();
  assert.equal(engine.isPlaying, true);
  assert.ok(player.positionMs >= 20000 && player.positionMs < 20100);
  player.pause();
  assert.equal(engine.isPlaying, false);
  assert.ok(player.positionMs >= 20000 && player.positionMs < 20100);
  bridge.emit(state({ positionMs: 20000, commandId: seek.commandId }));
  assert.equal(player.snapshot().playing, false);
  assert.equal(player.positionMs, 20000);
});
