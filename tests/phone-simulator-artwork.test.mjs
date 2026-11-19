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

const { buildTracks } = await vite.ssrLoadModule("/src/lib/mock/fixtures.ts");
const { artworkJpeg } = await vite.ssrLoadModule("/src/lib/mock/artwork.ts");

test("every simulated track cover can be drawn", async () => {
  const original = globalThis.document;
  let circles = 0;
  const context = {
    createLinearGradient: () => ({ addColorStop() {} }),
    fillRect() {},
    beginPath() {},
    arc(_x, _y, radius) {
      assert.ok(radius >= 0, `invalid artwork radius: ${radius}`);
      circles += 1;
    },
    fill() {},
  };
  globalThis.document = {
    createElement: () => ({
      getContext: () => context,
      toBlob: (callback) => callback(new Blob(["jpeg"])),
    }),
  };
  try {
    const tracks = buildTracks();
    for (const track of tracks) {
      assert.ok((await artworkJpeg(track.artworkPath)).byteLength > 0, track.id);
    }
    assert.equal(circles, tracks.length * 4);
  } finally {
    globalThis.document = original;
  }
});
