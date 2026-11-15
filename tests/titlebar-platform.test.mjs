import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const context = { windowCalls: 0, closeCalls: 0, maximizeCalls: 0, resize: null };
globalThis.__titlebarTest = context;

const mocks = {
  "@tauri-apps/api/window": `
    export const getCurrentWindow = () => {
      const context = globalThis.__titlebarTest;
      context.windowCalls += 1;
      return {
        onCloseRequested: () => {
          context.closeCalls += 1;
          return Promise.reject({ message: "unavailable" });
        },
        onResized: (callback) => {
          context.resize = callback;
          return Promise.reject({ message: "unavailable" });
        },
        isMaximized: () => {
          context.maximizeCalls += 1;
          return Promise.reject({ message: "unavailable" });
        },
      };
    };
  `,
  "../assets/icons/index": "export const setIcon = () => {};",
  "../lib/device": "export let isAndroidPlatform = false; globalThis.__setTitlebarAndroid = (value) => { isAndroidPlatform = value; };",
  "../lib/ipc": "export const resetWindowGeometry = async () => {}; export const saveWindowGeometry = async () => {};",
  "../lib/state": "export const flushSession = async () => {}; export const getState = () => ({ settings: { showTitlebar: null } }); export const subscribe = () => {};",
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  ssr: { noExternal: ["@tauri-apps/api"] },
  plugins: [{
    name: "titlebar-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !/[\\/]src[\\/]ui[\\/]titlebar\.ts/.test(importer)) return;
      if (source in mocks) return `\0titlebar-test:${source}`;
    },
    load(id) {
      if (id.startsWith("\0titlebar-test:")) return mocks[id.slice("\0titlebar-test:".length)];
    },
  }],
});
after(() => vite.close());

const { mountTitlebar } = await vite.ssrLoadModule("/src/ui/titlebar.ts");

function setup() {
  context.windowCalls = 0;
  context.closeCalls = 0;
  context.maximizeCalls = 0;
  context.resize = null;
  const button = { addEventListener() {}, querySelector: () => ({}), setAttribute() {} };
  globalThis.document = {
    documentElement: { dataset: {} },
    getElementById: () => button,
  };
}

test("Android preserves close handling without desktop-only titlebar APIs", async () => {
  setup();
  globalThis.__setTitlebarAndroid(true);
  mountTitlebar();
  assert.equal(document.documentElement.dataset.titlebar, "auto");
  assert.equal(context.windowCalls, 1);
  assert.equal(context.closeCalls, 1);
  assert.equal(context.maximizeCalls, 0);
  assert.equal(context.resize, null);
  await new Promise((resolve) => setImmediate(resolve));
});

test("desktop titlebar handles rejected window API promises", async () => {
  setup();
  globalThis.__setTitlebarAndroid(false);
  mountTitlebar();
  assert.equal(context.windowCalls, 1);
  assert.equal(context.maximizeCalls, 1);
  context.resize();
  assert.equal(context.maximizeCalls, 2);
  await new Promise((resolve) => setImmediate(resolve));
});
