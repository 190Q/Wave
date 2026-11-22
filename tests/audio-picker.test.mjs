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
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
});
after(() => vite.close());
const { importPickedFiles, pickAudioFiles, pickPhoneAudioFiles } = await vite.ssrLoadModule("/src/lib/ipc.ts");

test("Android uses the document picker and returns its selected URIs", async () => {
  selected = ["content://documents/one", "content://documents/two"];
  assert.deepEqual(await pickPhoneAudioFiles(), selected);
  assert.equal(calls.at(-1).command, "pick_phone_audio_files");
  selected = [];
  assert.equal(await pickPhoneAudioFiles(), null);
});

test("desktop keeps the filtered native audio picker", async () => {
  selected = ["D:\\Music\\song.flac", "D:\\Music\\another.mp3"];
  assert.deepEqual(await pickAudioFiles(), selected);
  assert.equal(calls.at(-1).command, "plugin:dialog|open");
  assert.equal(calls.at(-1).args.options.multiple, true);
  assert.ok(calls.at(-1).args.options.filters[0].extensions.includes("flac"));
  selected = "D:\\Music\\song.flac";
  assert.deepEqual(await pickAudioFiles(), [selected]);
  selected = null;
  assert.equal(await pickAudioFiles(), null);
});

test("the import command receives every selected file", async () => {
  const paths = ["D:\\Music\\song.flac", "D:\\Music\\another.mp3"];
  selected = { songs: 2 };
  assert.deepEqual(await importPickedFiles(paths), selected);
  assert.deepEqual(calls.at(-1), { command: "import_picked_files", args: { paths } });
});
