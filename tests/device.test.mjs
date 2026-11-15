import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/605.1.15" },
});

const storage = new Map();
const root = { dataset: {}, style: { setProperty() {} } };
let primaryCoarse = false;
let anyCoarse = false;

globalThis.document = { documentElement: root };
globalThis.window = {
  screen: { width: 360, height: 720 },
  location: { search: "" },
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
  matchMedia: (query) => ({
    matches: query === "(pointer: coarse)" ? primaryCoarse : anyCoarse,
  }),
  addEventListener() {},
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

const { device, initDevice, setDevice, titlebarVisible } = await vite.ssrLoadModule("/src/lib/device.ts");

function detect(width, height, primary, any = primary) {
  storage.clear();
  window.location.search = "";
  window.screen = { width, height };
  primaryCoarse = primary;
  anyCoarse = any;
  initDevice();
  return device();
}

test("detects touch-driven Linux phones in either orientation", () => {
  assert.equal(detect(360, 720, true), "linuxPhone");
  assert.equal(detect(720, 360, true), "linuxPhone");
  assert.equal(detect(360, 720, false, true), "linuxPhone");
  assert.equal(detect(600, 900, true), "linuxPhone");
  assert.equal(root.dataset.device, "linuxPhone");
});

test("keeps touch-enabled desktops and small mouse-driven screens in desktop mode", () => {
  assert.equal(detect(1920, 1080, true), "desktop");
  assert.equal(detect(601, 900, true), "desktop");
  assert.equal(detect(360, 720, false), "desktop");
  assert.equal(detect(0, 0, true), "desktop");
  assert.equal(root.dataset.device, "desktop");
});

test("the device override still takes precedence and can be cleared", () => {
  detect(1920, 1080, false);
  window.location.search = "?device=linuxPhone";
  initDevice();
  assert.equal(device(), "linuxPhone");

  window.location.search = "";
  initDevice();
  assert.equal(device(), "linuxPhone");

  window.location.search = "?device=auto";
  initDevice();
  assert.equal(device(), "desktop");

  window.location.search = "?device=desktop";
  window.screen = { width: 360, height: 720 };
  primaryCoarse = true;
  initDevice();
  assert.equal(device(), "desktop");
});

test("title bar follows device defaults until an override is saved", () => {
  assert.equal(titlebarVisible(null, "desktop"), true);
  assert.equal(titlebarVisible(null, "linuxPhone"), false);
  assert.equal(titlebarVisible(null, "android"), false);

  for (const kind of ["desktop", "linuxPhone"]) {
    assert.equal(titlebarVisible(true, kind), true);
    assert.equal(titlebarVisible(false, kind), false);
  }
  assert.equal(titlebarVisible(true, "android"), false);
  assert.equal(titlebarVisible(false, "android"), false);

  setDevice("linuxPhone");
  assert.equal(titlebarVisible(null), false);
  setDevice("desktop");
  assert.equal(titlebarVisible(null), true);
});
