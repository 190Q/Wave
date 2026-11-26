import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

globalThis.window = {
  __TAURI_INTERNALS__: {
    convertFileSrc: (path) => `asset:${path}`,
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
const { assetUrl, trackAudioPath } = await vite.ssrLoadModule("/src/lib/audio.ts");

test("audio uses the protected loopback URL when streaming is available", () => {
  const path = trackAudioPath("/music/audio.mp3", "track-123", "http://127.0.0.1:4321/token");
  assert.equal(path, "http://127.0.0.1:4321/token/track-123?file=audio.mp3");
  assert.equal(assetUrl(path), path);
});

test("streamed versions have distinct URLs and escape their filenames", () => {
  const base = "http://127.0.0.1:4321/token";
  assert.equal(
    trackAudioPath("/music/old song & café.mp3", "track-123", base),
    `${base}/track-123?file=old%20song%20%26%20caf%C3%A9.mp3`,
  );
  assert.notEqual(trackAudioPath("/music/audio.mp3", "track-123", base),
    trackAudioPath("/music/audio-new.mp3", "track-123", base));
});

test("audio retains asset paths when no stream is available", () => {
  const path = trackAudioPath("C:\\Music\\audio.mp3", "track-123", null);
  assert.equal(path, "C:\\Music\\audio.mp3");
  assert.equal(assetUrl(path), "asset:C:\\Music\\audio.mp3");
});
