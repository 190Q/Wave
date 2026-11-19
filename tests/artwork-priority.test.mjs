import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: "Android" },
});

const timers = new Map();
let nextTimer = 0;
const started = [];
const requests = new Map();
let decode = () => Promise.resolve();

globalThis.Audio = class {
  paused = true;
  addEventListener() {}
};
globalThis.Image = class {
  decode() { return decode(this.src); }
};
globalThis.document = {
  addEventListener() {},
  documentElement: { dataset: {}, style: { setProperty() {} } },
};
globalThis.window = {
  setInterval() {},
  setTimeout(callback, delay) {
    const id = ++nextTimer;
    timers.set(id, { callback, delay });
    return id;
  },
  clearTimeout(id) { timers.delete(id); },
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
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
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
  player,
  whenArtworkReady,
} = await vite.ssrLoadModule("/src/lib/state.ts");
const { setDevice } = await vite.ssrLoadModule("/src/lib/device.ts");
const { mosaicHtml } = await vite.ssrLoadModule("/src/ui/artwork.ts");

function tracks(prefix, count) {
  const ids = Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
  for (const id of ids) {
    getState().tracksById.set(id, { id, artworkPath: id });
  }
  return ids;
}

const render = () => runTimer();

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

function runTimer(delay = 150) {
  const timer = [...timers].find(([, entry]) => entry.delay === delay);
  assert.ok(timer, `No timer scheduled for ${delay}ms`);
  timers.delete(timer[0]);
  timer[1].callback();
}

afterEach(async () => {
  decode = () => Promise.resolve();
  prioritizeNearbyArtwork([], 0, false);
  pruneArtworkQueue(new Set(), new Set());
  while (requests.size > 0) {
    await finish([...requests.keys()]);
  }
  while (timers.size > 0) {
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

test("mobile startup waits for current and neighboring artwork, including failures", async () => {
  const order = tracks("startup", 7);
  const priority = [order[3], order[2], order[4], order[1], order[5]];
  const snapshot = player.snapshot;
  setDevice("android");
  player.snapshot = () => ({ order, cursor: 3, currentId: order[3], repeat: "off" });
  try {
    let ready = false;
    const waiting = whenArtworkReady().then(() => { ready = true; });
    assert.deepEqual(started, priority.slice(0, 3));
    await finish(priority.slice(0, 3));
    render();
    assert.equal(ready, false);
    await finish(priority.slice(3), new Set([priority[4]]));
    render();
    await waiting;
    assert.equal(ready, true);
  } finally {
    player.snapshot = snapshot;
    setDevice("desktop");
  }
});

test("mobile startup eventually proceeds when an artwork read hangs", async () => {
  const order = tracks("startup-timeout", 1);
  const snapshot = player.snapshot;
  setDevice("android");
  player.snapshot = () => ({ order, cursor: 0, currentId: order[0], repeat: "off" });
  try {
    const waiting = whenArtworkReady();
    runTimer(8000);
    await waiting;
  } finally {
    player.snapshot = snapshot;
    setDevice("desktop");
  }
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
  assert.deepEqual(started.slice(2), priority.slice(0, 1));
  assert.equal(mayRevealArtwork(order[6]), false);
  assert.equal(mayRevealArtwork(order[0]), false);

  await finish(order.slice(0, 2));
  render();
  assert.equal(mayRevealArtwork(order[0]), false);
  assert.deepEqual(started.slice(2), priority.slice(0, 3));

  await finish(priority.slice(0, 3));
  render();
  assert.equal(mayRevealArtwork(order[0]), false);
  assert.equal(started.length, 7);

  const reveals = [];
  const unsubscribe = subscribe(() => reveals.push(mayRevealArtwork(order[0])));
  await finish(priority.slice(3), new Set([priority[4]]));
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
  assert.deepEqual(started, [order[3], order[2], order[4]]);
  prefetchArtwork(order);

  prioritizeNearbyArtwork(order, 10, false);
  pruneArtworkQueue(new Set(), new Set(order));
  assert.equal(mayRevealArtwork(order[3]), false);
  assert.equal(mayRevealArtwork(order[10]), false);
  assert.equal(started.length, 3);

  await finish([order[3], order[2], order[4]]);
  assert.deepEqual(started.slice(3), [order[10], order[9], order[11]]);
  assert.equal(started.includes(order[0]), false);

  await finish([order[10], order[9], order[11]]);
  assert.deepEqual(started.slice(6), [order[8], order[12]]);
  await finish([order[8], order[12]]);
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
  assert.equal(mayRevealArtwork(order[3]), false);
  assert.deepEqual(started, [order[3], order[4], order[1], order[5]]);
  prefetchArtwork(order);
  await finish([order[4], order[1], order[5]]);
  render();
  assert.equal(mayRevealArtwork(order[3]), true);
  assert.equal(mayRevealArtwork(order[0]), true);
  assert.equal(started.includes(order[0]), true);
});

test("reveals nearby search-result covers together after multiple read batches", async () => {
  const order = tracks("search", 12);
  const priority = [order[6], order[5], order[7], order[4], order[8]];
  const renders = [];
  const unsubscribe = subscribe(() => {
    prioritizeNearbyArtwork(order, 6, false);
    renders.push(priority.filter((id) =>
      mayRevealArtwork(id) && artworkUrlFor(getState().tracksById.get(id), "idle")));
  });

  try {
    prioritizeNearbyArtwork(order, 6, false);
    assert.deepEqual(started, priority.slice(0, 3));
    await finish(priority.slice(0, 3));
    render();
    assert.deepEqual(renders, [[]]);

    await finish([priority[3]]);
    render();
    assert.deepEqual(renders, [[], []]);

    await finish([priority[4]]);
    render();
    assert.deepEqual(renders, [[], [], priority]);
  } finally {
    unsubscribe();
  }
});

test("a failed nearby cover does not prevent the remaining covers revealing together", async () => {
  const order = tracks("failed-search", 9);
  const priority = [order[4], order[3], order[5], order[2], order[6]];
  prioritizeNearbyArtwork(order, 4, false);

  await finish(priority.slice(0, 3));
  render();
  assert.equal(mayRevealArtwork(priority[0]), false);

  await finish(priority.slice(3), new Set([priority[4]]));
  assert.equal(mayRevealArtwork(priority[0]), true);
  render();
  assert.equal(mayRevealArtwork(priority[4]), true);
  assert.equal(artworkUrlFor(getState().tracksById.get(priority[4]), "idle"), null);
});

test("navigation to a cached group releases an older priority barrier", async () => {
  const order = tracks("return", 12);
  const first = [order[3], order[2], order[4], order[1], order[5]];
  prioritizeNearbyArtwork(order, 3, false);
  await finish(first.slice(0, 3));
  await finish(first.slice(3));
  render();
  render();

  prioritizeNearbyArtwork(order, 9, false);
  assert.equal(mayRevealArtwork(order[0]), false);
  prioritizeNearbyArtwork(order, 3, false);
  prefetchArtwork(order);
  pruneArtworkQueue(new Set(), new Set(order));
  render();
  assert.equal(mayRevealArtwork(order[0]), true);
  assert.equal(started.includes(order[0]), false);
  await finish([order[9], order[8], order[10]]);
  assert.equal(started.includes(order[0]), true);
});

test("rapid navigation through 200 songs never exceeds the phone read limit", async () => {
  const order = tracks("stress", 200);
  for (let cursor = 0; cursor < order.length; cursor += 5) {
    prioritizeNearbyArtwork(order, cursor, false);
    pruneArtworkQueue(new Set(), new Set());
    assert.ok(requests.size <= 3);
  }
  assert.deepEqual(started, order.slice(0, 3));
  await finish(order.slice(0, 3));
  assert.deepEqual(started.slice(3), [order[195], order[194], order[196]]);
  assert.equal(requests.size, 3);
});

test("phone collection mosaics wait for their composed covers", () => {
  const order = tracks("mosaic", 4);
  const html = mosaicHtml(order, getState().tracksById);
  assert.match(html, /data-cover="mosaic-0\|mosaic-1\|mosaic-2\|mosaic-3"/);
  assert.deepEqual(started, []);
});

test("old phone artwork URLs are revoked and can be reloaded", async () => {
  const order = tracks("eviction", 70);
  const revoked = [];
  const original = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
    original(url);
  };
  try {
    let first;
    let last;
    for (const id of order) {
      const track = getState().tracksById.get(id);
      artworkUrlFor(track, "now");
      await finish([id]);
      const url = artworkUrlFor(track, "idle");
      if (id === order[0]) first = url;
      if (id === order.at(-1)) last = url;
    }
    assert.ok(revoked.includes(first));
    assert.ok(!revoked.includes(last));
    assert.equal(artworkUrlFor(getState().tracksById.get(order[0]), "now"), null);
    await finish([order[0]]);
    assert.ok(artworkUrlFor(getState().tracksById.get(order[0]), "idle"));
  } finally {
    URL.revokeObjectURL = original;
  }
});

test("normal artwork tiers share the phone concurrency limit", async () => {
  const order = tracks("desktop", 8);
  prioritizeNearbyArtwork([], 0, false);
  prefetchArtwork(order.slice(0, 2));
  artworkUrlFor(getState().tracksById.get(order[6]), "queue");
  artworkUrlFor(getState().tracksById.get(order[7]), "now");
  assert.deepEqual(started, [order[0], order[1], order[6]]);
  await finish([order[0]]);
  assert.deepEqual(started, [order[0], order[1], order[6], order[7]]);
  assert.equal(mayRevealArtwork(order[2]), true);
});

test("an old artwork read cannot replace a newer cover", async () => {
  const id = "replacement";
  getState().tracksById.set(id, { id, artworkPath: "old-cover" });
  artworkUrlFor(getState().tracksById.get(id), "now");
  getState().tracksById.set(id, { id, artworkPath: "new-cover" });
  await finish(["old-cover"]);
  assert.equal(artworkUrlFor(getState().tracksById.get(id), "now"), null);
  assert.deepEqual(started, ["old-cover", "new-cover"]);
  await finish(["new-cover"]);
  assert.ok(artworkUrlFor(getState().tracksById.get(id), "now"));
});

test("Android artwork is not exposed until the image has decoded", async () => {
  const id = "decode-before-reveal";
  const track = { id, artworkPath: id };
  getState().tracksById.set(id, track);
  let finishDecode;
  decode = () => new Promise((resolve) => { finishDecode = resolve; });

  assert.equal(artworkUrlFor(track, "now"), null);
  await finish([id]);
  assert.equal(artworkUrlFor(track, "idle"), null);
  assert.ok(finishDecode);

  finishDecode();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(artworkUrlFor(track, "idle"));
});

test("an old image finishing decoding cannot replace a newer cover", async () => {
  const id = "decode-replacement";
  const oldPath = "decode-old";
  const newPath = "decode-new";
  getState().tracksById.set(id, { id, artworkPath: oldPath });
  let finishDecode;
  let oldUrl;
  const revoked = [];
  const original = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
    original(url);
  };
  decode = (url) => {
    oldUrl = url;
    return new Promise((resolve) => { finishDecode = resolve; });
  };

  try {
    artworkUrlFor(getState().tracksById.get(id), "now");
    await finish([oldPath]);
    getState().tracksById.set(id, { id, artworkPath: newPath });
    decode = () => Promise.resolve();
    finishDecode();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(revoked.includes(oldUrl));
    assert.equal(artworkUrlFor(getState().tracksById.get(id), "idle"), null);
    await finish([newPath]);
    assert.ok(artworkUrlFor(getState().tracksById.get(id), "idle"));
  } finally {
    URL.revokeObjectURL = original;
  }
});

test("a failed Android decode revokes its URL and releases the artwork slot", async () => {
  const id = "decode-failure";
  const track = { id, artworkPath: id };
  getState().tracksById.set(id, track);
  let failedUrl;
  const revoked = [];
  const original = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
    original(url);
  };
  decode = (url) => {
    failedUrl = url;
    return Promise.reject(new Error("decode failed"));
  };

  try {
    artworkUrlFor(track, "now");
    await finish([id]);
    assert.ok(revoked.includes(failedUrl));
    assert.equal(artworkUrlFor(track, "now"), null);

    decode = () => Promise.resolve();
    const next = { id: "decode-after-failure", artworkPath: "decode-after-failure" };
    getState().tracksById.set(next.id, next);
    artworkUrlFor(next, "now");
    await finish([next.id]);
    assert.ok(artworkUrlFor(next, "idle"));
  } finally {
    URL.revokeObjectURL = original;
  }
});

test("a JPEG thumbnail is identified by its bytes instead of the source extension", async () => {
  const original = URL.createObjectURL;
  let mime;
  URL.createObjectURL = (blob) => {
    mime = blob.type;
    return original(blob);
  };
  try {
    const track = { id: "thumbnail", artworkPath: "thumbnail.png" };
    getState().tracksById.set(track.id, track);
    artworkUrlFor(track, "now");
    const request = requests.get(track.artworkPath);
    requests.delete(track.artworkPath);
    request.resolve(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(mime, "image/jpeg");
  } finally {
    URL.createObjectURL = original;
  }
});
