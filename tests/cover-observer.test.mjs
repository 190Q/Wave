import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const watched = new Set();
let deliver;
globalThis.IntersectionObserver = class {
  constructor(callback) { deliver = callback; }
  observe(element) { watched.add(element); }
  unobserve(element) { watched.delete(element); }
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "cover-observer-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/]covers\.ts$/.test(importer) && source === "../lib/state") {
        return "\0cover-observer-state";
      }
    },
    load(id) {
      if (id === "\0cover-observer-state") {
        return "export const cachedCoverUrl = () => null; export const coverUrl = async () => 'cover-url';";
      }
    },
  }],
});
after(() => vite.close());

const { hydrateCovers, releaseCovers } = await vite.ssrLoadModule("/src/ui/covers.ts");

function element(path) {
  return {
    dataset: { cover: path },
    style: {},
    classList: { add() {} },
    removeAttribute() {},
    replaceChildren() {},
  };
}

test("rehydrating and closing a root unobserves its detached covers", async () => {
  const first = element("first.jpg");
  const second = element("second.jpg");
  let elements = [first];
  const root = { querySelectorAll: () => elements };
  hydrateCovers(root);
  assert.deepEqual([...watched], [first]);

  elements = [second];
  hydrateCovers(root);
  assert.deepEqual([...watched], [second]);

  releaseCovers(root);
  assert.equal(watched.size, 0);
  deliver([{ target: second, isIntersecting: true }]);
  await Promise.resolve();
  assert.equal(second.style.backgroundImage, undefined);
});
