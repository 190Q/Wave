import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const context = { touch: true, safe: { top: 24, right: 10, bottom: 16, left: 10 } };
globalThis.__menuViewportTest = context;

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "menu-viewport-test-device",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/]menu\.ts$/.test(importer) && source === "../lib/device") {
        return "\0menu-viewport-test:device";
      }
    },
    load(id) {
      if (id === "\0menu-viewport-test:device") {
        return `
          export const isTouch = () => globalThis.__menuViewportTest.touch;
          export const insets = () => globalThis.__menuViewportTest.safe;
          export const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };
        `;
      }
    },
  }],
});
after(() => vite.close());

class Menu {
  style = {};
  naturalWidth = 220;
  naturalHeight = 420;
  get offsetWidth() { return Math.min(this.naturalWidth, parseFloat(this.style.maxWidth) || Infinity); }
  get offsetHeight() { return Math.min(this.naturalHeight, parseFloat(this.style.maxHeight) || 320); }
  setAttribute() {}
  addEventListener() {}
  querySelectorAll() { return []; }
  remove() {}
}

globalThis.document = {
  createElement: () => new Menu(),
  body: { appendChild(menu) { context.menu = menu; } },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = {
  innerWidth: 400,
  innerHeight: 720,
  setTimeout: () => 1,
  clearTimeout() {},
  addEventListener() {},
  removeEventListener() {},
};

const { openMenu, closeMenu } = await vite.ssrLoadModule("/src/ui/menu.ts");
const anchor = { getBoundingClientRect: () => ({ top: 100, right: 120, bottom: 140 }) };
const items = Array.from({ length: 9 }, (_, index) => ({ label: `Action ${index}`, action() {} }));

test("touch song menus show their full content within the safe viewport", () => {
  context.touch = true;
  window.innerWidth = 400;
  window.innerHeight = 720;
  openMenu(anchor, items, { x: 390, y: 700 }, { fitViewport: true });
  assert.equal(context.menu.style.maxHeight, "672px");
  assert.equal(context.menu.offsetHeight, context.menu.naturalHeight);
  assert.equal(context.menu.style.maxWidth, "372px");
  assert.equal(context.menu.style.left, "166px");
  assert.equal(context.menu.style.top, "280px");
  closeMenu();
});

test("the close callback runs once when a menu is dismissed or replaced", () => {
  let closed = 0;
  openMenu(anchor, items, undefined, { onClose: () => { closed += 1; } });
  closeMenu();
  closeMenu();
  assert.equal(closed, 1);
  openMenu(anchor, items, undefined, { onClose: () => { closed += 1; } });
  openMenu(anchor, items);
  assert.equal(closed, 2);
  closeMenu();
  assert.equal(closed, 2);
});

test("touch song menus remain reachable on a short screen", () => {
  context.touch = true;
  window.innerWidth = 720;
  window.innerHeight = 360;
  openMenu(anchor, items, { x: 100, y: 180 }, { fitViewport: true });
  assert.equal(context.menu.style.maxHeight, "312px");
  assert.equal(context.menu.offsetHeight, 312);
  assert.equal(context.menu.style.top, "28px");
  closeMenu();
});

test("other menus and desktop song menus keep the existing height limit", () => {
  context.touch = true;
  window.innerHeight = 720;
  openMenu(anchor, items, { x: 100, y: 100 });
  assert.equal(context.menu.style.maxHeight, undefined);
  assert.equal(context.menu.offsetHeight, 320);
  closeMenu();

  context.touch = false;
  openMenu(anchor, items, { x: 100, y: 100 }, { fitViewport: true });
  assert.equal(context.menu.style.maxHeight, undefined);
  assert.equal(context.menu.offsetHeight, 320);
  closeMenu();
});
