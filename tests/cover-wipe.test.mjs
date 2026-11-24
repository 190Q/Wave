import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const context = { reduced: false, listener: null };
globalThis.__coverWipeTest = context;
const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "cover-wipe-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/]wipe\.ts$/.test(importer)) {
        if (source === "../lib/motion") return "\0cover-wipe-motion";
        if (source === "../lib/device") return "\0cover-wipe-device";
      }
    },
    load(id) {
      if (id === "\0cover-wipe-motion") return `
        export const reduceMotionActive = () => globalThis.__coverWipeTest.reduced;
        export const subscribeMotion = (listener) => { globalThis.__coverWipeTest.listener = listener; };
      `;
      if (id === "\0cover-wipe-device") return "export const isWebKitGtk = false;";
    },
  }],
});
after(() => vite.close());

const animations = [];
globalThis.document = {
  documentElement: { classList: { contains: () => false } },
  createElement: () => {
    const overlay = {
      style: {},
      setAttribute() {},
      remove() { this.removed = true; },
      animate() {
        let resolve;
        const finished = new Promise((done) => { resolve = done; });
        const animation = { finished, resolve, cancel() { this.cancelled = true; } };
        animations.push(animation);
        return animation;
      },
    };
    return overlay;
  },
};
const { coverWipe, finishCoverWipe, setCoverStyle, themeWipe } = await vite.ssrLoadModule("/src/ui/wipe.ts");

function body() {
  return {
    offsetWidth: 100,
    overlays: [],
    style: "",
    getBoundingClientRect: () => ({ left: 0, right: 100 }),
    prepend(overlay) { this.overlays.push(overlay); },
    setAttribute(name, value) { if (name === "style") this.style = value; },
  };
}

test("superseded wipes cannot overwrite a newer cover", async () => {
  const element = body();
  coverWipe([{ body: element, style: "first" }]);
  const first = animations.at(-1);
  coverWipe([{ body: element, style: "second" }]);
  const second = animations.at(-1);
  assert.equal(first.cancelled, true);
  first.resolve();
  await Promise.resolve();
  assert.equal(element.style, "");

  setCoverStyle(element, "latest");
  assert.equal(second.cancelled, true);
  second.resolve();
  await Promise.resolve();
  assert.equal(element.style, "latest");
  assert.ok(element.overlays.every((overlay) => overlay.removed));
});

test("settling a hidden cover cancels its wipe and retains the intended cover", async () => {
  context.reduced = false;
  const element = body();
  coverWipe([{ body: element, style: "ready" }]);
  const animation = animations.at(-1);
  finishCoverWipe(element);
  assert.equal(animation.cancelled, true);
  assert.equal(element.style, "ready");
  assert.equal(element.overlays[0].removed, true);
  animation.resolve();
  await Promise.resolve();
  assert.equal(element.style, "ready");
});

test("backgrounding settles active wipes and applies later changes without animation", async () => {
  context.reduced = false;
  const element = body();
  coverWipe([{ body: element, style: "background" }]);
  const animation = animations.at(-1);
  context.reduced = true;
  context.listener();
  assert.equal(animation.cancelled, true);
  assert.equal(element.style, "background");
  animation.resolve();
  await Promise.resolve();

  const count = animations.length;
  coverWipe([{ body: element, style: "newest" }]);
  assert.equal(element.style, "newest");
  assert.equal(animations.length, count);
  assert.ok(element.overlays.every((overlay) => overlay.removed));
});

test("startup applies covers without a wipe", () => {
  context.reduced = false;
  document.documentElement.classList = { contains: (name) => name === "is-starting" };
  const element = body();
  const count = animations.length;
  coverWipe([{ body: element, style: "ready" }]);
  assert.equal(element.style, "ready");
  assert.equal(animations.length, count);
  document.documentElement.classList = { contains: () => false };
});

test("a theme transition that becomes ready after focus returns stays skipped", async () => {
  context.reduced = false;
  let ready;
  let ended;
  let skipped = 0;
  let animated = 0;
  document.documentElement = { animate: () => { animated += 1; } };
  document.startViewTransition = (update) => {
    update();
    return {
      ready: new Promise((resolve) => { ready = resolve; }),
      finished: new Promise((resolve) => { ended = resolve; }),
      skipTransition: () => { skipped += 1; },
    };
  };

  const transition = themeWipe(() => {});
  context.reduced = true;
  context.listener();
  assert.equal(skipped, 1);
  context.reduced = false;
  ready();
  ended();
  await transition;
  assert.equal(animated, 0);
});
