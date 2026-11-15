import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: "Android" },
});

const timers = [];
const started = [];
const requests = new Map();

globalThis.Audio = class {
  paused = true;
  addEventListener() {}
};
globalThis.document = { addEventListener() {} };
globalThis.window = {
  setInterval() {},
  setTimeout(callback) {
    timers.push(callback);
    return timers.length;
  },
  __TAURI_INTERNALS__: {
    invoke(command, { path }) {
      assert.equal(command, "artwork_bytes");
      started.push(path);
      return new Promise((resolve, reject) => requests.set(path, { resolve, reject }));
    },
  },
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});
after(() => vite.close());

const { nearbyArtwork } = await vite.ssrLoadModule("/src/lib/artwork-priority.ts");
const {
  artworkUrlFor,
  getState,
  mayRevealArtwork,
  prefetchArtwork,
  prioritizeNearbyArtwork,
  pruneArtworkQueue,
  subscribe,
} = await vite.ssrLoadModule("/src/lib/state.ts");

function tracks(prefix, count) {
  const ids = Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
  for (const id of ids) {
    getState().tracksById.set(id, { id, artworkPath: id });
  }
  return ids;
}

async function finish(ids, failed = new Set()) {
  for (const id of ids) {
    const request = requests.get(id);
    assert.ok(request, `No artwork request for ${id}`);
    requests.delete(id);
    if (failed.has(id)) {
      request.reject(new Error("Artwork unavailable"));
    } else {
      request.resolve(new Uint8Array([1]).buffer);
    }
  }
  await new Promise((resolve) => setImmediate(resolve));
}

function render() {
  const callback = timers.shift();
  assert.ok(callback, "No render scheduled");
  callback();
}

afterEach(async () => {
  prioritizeNearbyArtwork([], 0, false);
  pruneArtworkQueue(new Set(), new Set());
  while (requests.size > 0) {
    await finish([...requests.keys()]);
  }
  while (timers.length > 0) {
    render();
  }
  started.length = 0;
});

test("selects the current track and two neighbors in playback order", () => {
  const order = ["a", "b", "c", "d", "e", "f", "g"];
  assert.deepEqual(nearbyArtwork(order, 3, false), ["d", "c", "e", "b", "f"]);
  assert.deepEqual(nearbyArtwork(["g", "b", "f", "a", "e", "c", "d"], 3, false),
    ["a", "f", "e", "b", "c"]);
  assert.deepEqual(nearbyArtwork([], 0, false), []);
  assert.deepEqual(nearbyArtwork(order, -1, true), []);
});

test("honors repeat boundaries and avoids duplicates in short queues", () => {
  const order = ["a", "b", "c", "d", "e", "f"];
  assert.deepEqual(nearbyArtwork(order, 0, false), ["a", "b", "c"]);
  assert.deepEqual(nearbyArtwork(order, 5, false), ["f", "e", "d"]);
  assert.deepEqual(nearbyArtwork(order, 0, true), ["a", "f", "b", "e", "c"]);
  assert.deepEqual(nearbyArtwork(order, 5, true), ["f", "e", "a", "d", "b"]);
  assert.deepEqual(nearbyArtwork(["a", "b", "c"], 0, true), ["a", "c", "b"]);
  assert.deepEqual(nearbyArtwork(["a"], 0, true), ["a"]);
});

test("promotes pending covers and waits for all nearby covers to be painted", async () => {
  const order = tracks("priority", 12);
  prefetchArtwork(order);
  assert.deepEqual(started, order.slice(0, 2));

  prioritizeNearbyArtwork(order, 6, false);
  const priority = [order[6], order[5], order[7], order[4], order[8]];
  assert.deepEqual(started.slice(2), priority);
  assert.equal(mayRevealArtwork(order[6]), true);
  assert.equal(mayRevealArtwork(order[0]), false);

  await finish(order.slice(0, 2));
  render();
  assert.equal(mayRevealArtwork(order[0]), false);
  assert.equal(started.length, 7);

  await finish(priority.slice(0, 4));
  render();
  assert.equal(mayRevealArtwork(order[0]), false);
  assert.equal(started.length, 7);

  const reveals = [];
  const unsubscribe = subscribe(() => reveals.push(mayRevealArtwork(order[0])));
  await finish([priority[4]], new Set([priority[4]]));
  assert.equal(started.length, 7);
  render();
  assert.deepEqual(reveals, [false]);
  assert.equal(mayRevealArtwork(order[0]), true);
  assert.deepEqual(started.slice(7), [order[2], order[3]]);
  render();
  assert.deepEqual(reveals, [false, true]);
  unsubscribe();
});

test("updates priority when the current track changes during loading", async () => {
  const order = tracks("move", 14);
  prioritizeNearbyArtwork(order, 3, false);
  assert.deepEqual(started, [order[3], order[2], order[4], order[1], order[5]]);
  prefetchArtwork(order);

  prioritizeNearbyArtwork(order, 10, false);
  pruneArtworkQueue(new Set(), new Set(order));
  assert.equal(mayRevealArtwork(order[3]), false);
  assert.equal(mayRevealArtwork(order[10]), true);
  assert.deepEqual(started.slice(5), [order[10], order[9], order[11], order[8], order[12]]);

  await finish([order[3]]);
  await finish([order[2], order[4], order[1], order[5]]);
  assert.equal(started.includes(order[0]), false);

  await finish([order[10], order[9], order[11], order[8], order[12]]);
  render();
  assert.equal(started.includes(order[0]), true);
});

test("missing or already-cached priority covers do not block other artwork", async () => {
  const order = tracks("cached", 8);
  artworkUrlFor(getState().tracksById.get(order[3]), "now");
  await finish([order[3]]);
  render();

  getState().tracksById.get(order[2]).artworkPath = null;
  prioritizeNearbyArtwork(order, 3, false);
  assert.deepEqual(started, [order[3], order[4], order[1], order[5]]);
  prefetchArtwork(order);
  await finish([order[4], order[1], order[5]]);
  render();
  assert.equal(mayRevealArtwork(order[0]), true);
  assert.equal(started.includes(order[0]), true);
});

test("navigation to a cached group releases an older priority barrier", async () => {
  const order = tracks("return", 12);
  const first = [order[3], order[2], order[4], order[1], order[5]];
  prioritizeNearbyArtwork(order, 3, false);
  await finish(first);
  render();
  render();

  prioritizeNearbyArtwork(order, 9, false);
  assert.equal(mayRevealArtwork(order[0]), false);
  prioritizeNearbyArtwork(order, 3, false);
  prefetchArtwork(order);
  render();
  assert.equal(mayRevealArtwork(order[0]), true);
  assert.equal(started.includes(order[0]), true);
});

test("without phone priority the normal artwork tiers remain independent", async () => {
  const order = tracks("desktop", 8);
  prioritizeNearbyArtwork([], 0, false);
  prefetchArtwork(order.slice(0, 2));
  artworkUrlFor(getState().tracksById.get(order[6]), "queue");
  artworkUrlFor(getState().tracksById.get(order[7]), "now");
  assert.deepEqual(started, [order[0], order[1], order[6], order[7]]);
  assert.equal(mayRevealArtwork(order[2]), true);
});
