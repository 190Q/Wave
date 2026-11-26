import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: "Windows" },
});
globalThis.Audio = class {
  paused = true;
  addEventListener() {}
  removeEventListener() {}
  pause() {}
  removeAttribute() {}
  load() {}
};
globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
globalThis.document = { addEventListener() {} };
const commands = [];
globalThis.window = {
  setInterval() {},
  setTimeout() {},
  __TAURI_INTERNALS__: {
    invoke(command) {
      commands.push(command);
      if (command === "plugin:dialog|open") return Promise.resolve("playlist.wavelist");
      if (command === "import_wavelist") return Promise.resolve({
        songs: 16, images: 0, lyrics: 0, skipped: 4, duplicates: 0, similar: 0,
        playlist: "Imported", playlistId: "playlist", trackIds: [], errors: ["Download failed"], state: {},
      });
      if (command === "scan_library") return Promise.resolve({
        changed: [], removed: [], total: 16, root: "library", skipped: 0, errors: [],
      });
      if (command === "library_info") return Promise.resolve({ tracks: 16 });
      if (command === "get_state") return Promise.resolve({});
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

const { getState, importWaveList } = await vite.ssrLoadModule("/src/lib/state.ts");

test("desktop playlist imports report songs waiting for retry", async () => {
  await importWaveList(async () => true);
  const progress = getState().transferProgress;
  assert.equal(progress.phase, "failed");
  assert.match(progress.message, /16 songs imported/);
  assert.match(progress.message, /4 songs waiting for audio/);
  assert.deepEqual(progress.failures, ["Download failed"]);
  assert.ok(!commands.includes("download_playlist"));
});
