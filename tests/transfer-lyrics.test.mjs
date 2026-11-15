import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: "Android" },
});
globalThis.Audio = class {
  paused = true;
  addEventListener() {}
};
globalThis.document = { addEventListener() {} };

const lyricsRequests = [];
const exports = [];
globalThis.window = {
  setInterval() {},
  setTimeout() {},
  __TAURI_INTERNALS__: {
    invoke(command, args) {
      if (command === "load_lyrics") {
        return new Promise((resolve, reject) => lyricsRequests.push({ id: args.trackId, resolve, reject }));
      }
      if (command === "plugin:dialog|save") return Promise.resolve("content://exports/list");
      if (command === "export_wavelist") {
        exports.push(args);
        return Promise.resolve(args.trackIds.length);
      }
      throw new Error(`Unexpected command: ${command}`);
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

const { ensureLyrics, exportCollection, getState, subscribe } = await vite.ssrLoadModule("/src/lib/state.ts");

test("exports pending-only and mixed playlists using their ordered entries", async () => {
  const state = getState();
  state.collections = [
    { id: "pending", name: "Pending", kind: "generated", trackIds: [], entries: ["p1", "p2"] },
    { id: "mixed", name: "Mixed", kind: "playlist", trackIds: ["held"], entries: ["p1", "held", "p2"] },
    { id: "album", name: "Album", kind: "album", trackIds: ["held"], entries: ["held"] },
  ];
  await exportCollection("pending");
  await exportCollection("mixed");
  await exportCollection("album");
  assert.deepEqual(exports.map(({ name, trackIds, playlistId }) => ({ name, trackIds, playlistId })), [
    { name: "Pending", trackIds: ["p1", "p2"], playlistId: "pending" },
    { name: "Mixed", trackIds: ["p1", "held", "p2"], playlistId: "mixed" },
    { name: "Album", trackIds: ["held"], playlistId: null },
  ]);
});

test("an older failure cannot clear the current lyrics or emit another update", async () => {
  const a = ensureLyrics({ id: "a" });
  const b = ensureLyrics({ id: "b" });
  const [old, current] = lyricsRequests.splice(0);
  current.resolve("[00:01]Current");
  await b;
  let updates = 0;
  const unsubscribe = subscribe(() => { updates += 1; });
  old.reject(new Error("old request failed"));
  await a;
  unsubscribe();
  assert.equal(getState().lyricsTrackId, "b");
  assert.deepEqual(getState().lyrics, [{ timeMs: 1000, text: "Current" }]);
  assert.equal(updates, 0);
});

test("returning to a track rejects both old success and failure results", async () => {
  await ensureLyrics(undefined);
  const first = ensureLyrics({ id: "a" });
  const middle = ensureLyrics({ id: "b" });
  const latest = ensureLyrics({ id: "a" });
  const [old, skipped, current] = lyricsRequests.splice(0);
  current.resolve("[00:02]Newest");
  await latest;
  old.resolve("[00:01]Stale");
  skipped.reject(new Error("stale failure"));
  await Promise.all([first, middle]);
  assert.equal(getState().lyricsTrackId, "a");
  assert.deepEqual(getState().lyrics, [{ timeMs: 2000, text: "Newest" }]);

  const b = ensureLyrics({ id: "b" });
  const secondA = ensureLyrics({ id: "a" });
  const [oldB, currentA] = lyricsRequests.splice(0);
  currentA.resolve("[00:03]Latest");
  await secondA;
  oldB.resolve(null);
  await b;
  assert.deepEqual(getState().lyrics, [{ timeMs: 3000, text: "Latest" }]);
});

test("a current failure clears lyrics normally", async () => {
  const pending = ensureLyrics({ id: "failure" });
  const request = lyricsRequests.shift();
  request.reject(new Error("failed"));
  await pending;
  assert.equal(getState().lyricsTrackId, "failure");
  assert.deepEqual(getState().lyrics, []);
});

test("an old failure cannot clear a newer request for the same track", async () => {
  const first = ensureLyrics({ id: "same" });
  const middle = ensureLyrics({ id: "other" });
  const latest = ensureLyrics({ id: "same" });
  const [old, skipped, current] = lyricsRequests.splice(0);
  current.resolve("[00:04]Current again");
  await latest;
  old.reject(new Error("stale failure"));
  skipped.resolve(null);
  await Promise.all([first, middle]);
  assert.equal(getState().lyricsTrackId, "same");
  assert.deepEqual(getState().lyrics, [{ timeMs: 4000, text: "Current again" }]);
});
