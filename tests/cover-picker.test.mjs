import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

let selected = null;
const calls = [];
globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke(command, args) {
      calls.push({ command, args });
      return Promise.resolve(selected);
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
const { pickCover, replaceCover } = await vite.ssrLoadModule("/src/lib/ipc.ts");

test("cover picker filters supported images and preserves Android document URIs", async () => {
  selected = "content://documents/image/123";
  assert.equal(await pickCover(), selected);
  assert.equal(calls.at(-1).command, "plugin:dialog|open");
  assert.equal(calls.at(-1).args.options.multiple, false);
  assert.deepEqual(calls.at(-1).args.options.filters[0].extensions,
    ["jpg", "jpeg", "png", "webp", "gif", "bmp"]);

  await replaceCover("song-1", selected);
  assert.deepEqual(calls.at(-1), {
    command: "replace_cover",
    args: { trackId: "song-1", path: selected },
  });
});

test("cancelling the picker returns null", async () => {
  selected = null;
  assert.equal(await pickCover(), null);
});
