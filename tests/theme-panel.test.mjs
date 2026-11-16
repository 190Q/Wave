import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const mocks = {
  "../lib/colour": `
    export const darken = (colour) => colour, mix = (colour) => colour;
    export const readableInk = (colour) => colour, stageGradient = (colour) => colour;
    export const withAlpha = (colour) => colour;
    export const hexToHsv = (hex) => ({ h: 0, s: 0, v: 0, hex });
    export const hsvToHex = (hsv) => hsv.hex ?? "#4f6484";
  `,
  "../lib/device": 'export const device = () => globalThis.__themeTest.device;',
  "../lib/format": "export const escapeHtml = (value) => value;",
  "../lib/state": `
    const context = () => globalThis.__themeTest;
    export const ADAPTIVE_THEME = "adaptive";
    export const adaptiveColour = () => "#abcdef";
    export const getState = () => context().state;
    export const themeColour = () => context().state.settings.theme;
    export const subscribe = (listener) => { context().notify = listener; };
    export const player = { onChange() {} };
    export const setTheme = async (theme) => {
      context().state.settings.theme = theme;
      if (theme !== ADAPTIVE_THEME) {
        context().state.settings.recentColours = [
          theme, ...context().state.settings.recentColours.filter((colour) => colour !== theme),
        ];
      }
      context().notify();
    };
  `,
  "./icons": "export const fillIcons = () => {};",
  "./wipe": "export const themeWipe = (update) => { update(); return Promise.resolve(); };",
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "theme-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/](theme|fit|drop)\.ts$/.test(importer) && source in mocks) {
        return `\0theme-test:${source}`;
      }
    },
    load(id) {
      if (id.startsWith("\0theme-test:")) return mocks[id.slice("\0theme-test:".length)];
    },
  }],
});
after(() => vite.close());

class Events {
  listeners = new Map();
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? new Set();
    handlers.add(handler);
    this.listeners.set(type, handlers);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler({ type, ...event });
  }
}

class Element extends Events {
  constructor() {
    super();
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    };
    this.style = { setProperty() {} };
    this.dataset = {};
    this.value = "";
    this.innerHTML = "";
    this.offsetWidth = 100;
  }
  setAttribute(name, value) { this[name] = value; }
  contains(node) { return node === this; }
  querySelector() { return null; }
  closest(selector) { return selector === "[data-theme]" && this.dataset.theme ? this : null; }
  getBoundingClientRect() {
    return { left: 20, right: 120, top: 20, bottom: 60, width: 100, height: 40 };
  }
}

function setup(device, height) {
  const context = {
    device,
    state: { settings: { theme: "#123456", recentColours: ["#123456"] } },
  };
  globalThis.__themeTest = context;

  const ids = [
    "theme-dialog", "theme-toggle", "theme-toggle-face", "theme-drop-list",
    "picker-area", "picker-knob", "picker-hue", "picker-hex", "picker-preview",
    "picker-apply", "theme-list", "theme-close",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  const dialog = elements["theme-dialog"];
  dialog.open = false;
  dialog.scrollHeight = 400;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };

  globalThis.document = Object.assign(new Events(), {
    documentElement: new Element(),
    getElementById: (id) => elements[id] ?? null,
    activeElement: null,
  });
  globalThis.getComputedStyle = () => ({ fontSize: "16px", paddingLeft: "0px" });
  globalThis.window = Object.assign(new Events(), { innerHeight: height, setTimeout, clearTimeout });
  return { context, elements, dialog };
}

const { mountTheme } = await vite.ssrLoadModule("/src/ui/theme.ts");
const { createPanel } = await vite.ssrLoadModule("/src/ui/drop.ts");

for (const device of ["android", "linuxPhone"]) {
  test(`${device} theme stays open when the full-screen background is clicked`, () => {
    const { elements, dialog } = setup(device, 800);
    mountTheme();
    elements["theme-toggle-face"].dispatch("click");
    dialog.dispatch("click", { target: dialog });
    assert.equal(dialog.open, true);
    assert.equal(dialog.classList.contains("is-closed"), false);
  });

  test(`${device} theme picks close the dialog without opening the compact drop`, async () => {
    const { context, elements, dialog } = setup(device, 800);
    mountTheme();
    elements["theme-toggle-face"].dispatch("click");
    assert.equal(dialog.open, true);

    dialog.scrollHeight = 800;
    const swatch = new Element();
    swatch.dataset.theme = "#abcdef";
    elements["theme-list"].dispatch("click", { target: swatch });

    assert.equal(context.state.settings.theme, "#abcdef");
    assert.equal(dialog.classList.contains("is-closed"), true);
    assert.equal(elements["theme-toggle"].classList.contains("is-open"), false);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(dialog.open, false);
    assert.equal(elements["theme-toggle"].classList.contains("is-open"), false);

    elements["theme-toggle-face"].dispatch("click");
    assert.equal(dialog.open, true);
    assert.equal(dialog.classList.contains("is-closed"), false);
    elements["picker-hex"].value = "#654321";
    elements["picker-hex"].dispatch("input");
    elements["picker-apply"].dispatch("click");
    assert.equal(context.state.settings.theme, "#654321");
    assert.equal(dialog.classList.contains("is-closed"), true);
    assert.equal(elements["theme-toggle"].classList.contains("is-open"), false);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(dialog.open, false);
    assert.equal(elements["theme-toggle"].classList.contains("is-open"), false);

    elements["theme-toggle-face"].dispatch("click");
    window.innerHeight = 350;
    window.dispatch("resize");
    assert.equal(dialog.open, true);
    assert.equal(dialog.classList.contains("is-closed"), false);
    assert.equal(elements["theme-toggle"].classList.contains("is-open"), false);
  });

  test(`${device} opens the modal even below the desktop height minimum`, () => {
    const { elements, dialog } = setup(device, 350);
    mountTheme();
    elements["theme-toggle-face"].dispatch("click");
    assert.equal(dialog.open, true);
    assert.equal(elements["theme-toggle"].classList.contains("is-open"), false);
  });
}

test("desktop theme backdrop clicks still close the dialog", () => {
  const { elements, dialog } = setup("desktop", 800);
  mountTheme();
  elements["theme-toggle-face"].dispatch("click");
  dialog.dispatch("click", { target: dialog });
  assert.equal(dialog.classList.contains("is-closed"), true);
});

test("desktop theme picks keep the dialog open while it fits", () => {
  const { context, elements, dialog } = setup("desktop", 800);
  mountTheme();
  elements["theme-toggle-face"].dispatch("click");
  const swatch = new Element();
  swatch.dataset.theme = "#abcdef";
  elements["theme-list"].dispatch("click", { target: swatch });
  assert.equal(context.state.settings.theme, "#abcdef");
  assert.equal(dialog.open, true);
  assert.equal(dialog.classList.contains("is-closed"), false);

  elements["picker-hex"].value = "#654321";
  elements["picker-hex"].dispatch("input");
  elements["picker-apply"].dispatch("click");
  assert.equal(context.state.settings.theme, "#654321");
  assert.equal(dialog.open, true);
  assert.equal(dialog.classList.contains("is-closed"), false);
  assert.equal(elements["theme-toggle"].classList.contains("is-open"), false);
});

test("desktop panels still use the compact drop when they no longer fit", () => {
  const { elements, dialog } = setup("desktop", 800);
  mountTheme();
  elements["theme-toggle-face"].dispatch("click");
  assert.equal(dialog.open, true);

  dialog.scrollHeight = 800;
  const swatch = new Element();
  swatch.dataset.theme = "#abcdef";
  elements["theme-list"].dispatch("click", { target: swatch });
  assert.equal(dialog.classList.contains("is-closed"), true);
  assert.equal(elements["theme-toggle"].classList.contains("is-open"), true);
});

test("panels without a fit override keep the shared desktop threshold", () => {
  const { elements, dialog } = setup("desktop", 350);
  const face = elements["theme-toggle-face"];
  const toggle = elements["theme-toggle"];
  createPanel({
    dialog,
    body: new Element(),
    toggle,
    face,
    show: () => { dialog.open = true; },
    hide: () => { dialog.open = false; },
    render() {},
  });

  face.dispatch("click");
  assert.equal(dialog.open, false);
  assert.equal(toggle.classList.contains("is-open"), true);

  window.innerHeight = 800;
  window.dispatch("resize");
  assert.equal(dialog.open, true);
  assert.equal(toggle.classList.contains("is-open"), false);

  window.innerHeight = 350;
  window.dispatch("resize");
  assert.equal(dialog.open, false);
  assert.equal(toggle.classList.contains("is-open"), true);
});

test("Linux phone panels stay modal when opened or resized below the desktop threshold", () => {
  const { elements, dialog } = setup("linuxPhone", 350);
  const face = elements["theme-toggle-face"];
  const toggle = elements["theme-toggle"];
  createPanel({
    dialog,
    body: new Element(),
    toggle,
    face,
    show: () => { dialog.open = true; },
    hide: () => { dialog.open = false; },
    render() {},
  });

  face.dispatch("click");
  assert.equal(dialog.open, true);
  assert.equal(toggle.classList.contains("is-open"), false);

  for (const height of [800, 350, 120]) {
    window.innerHeight = height;
    window.dispatch("resize");
    assert.equal(dialog.open, true);
    assert.equal(toggle.classList.contains("is-open"), false);
  }
});

test("Android panels without a fit override retain the compact fallback", () => {
  const { elements, dialog } = setup("android", 350);
  const face = elements["theme-toggle-face"];
  const toggle = elements["theme-toggle"];
  createPanel({
    dialog,
    body: new Element(),
    toggle,
    face,
    show: () => { dialog.open = true; },
    hide: () => { dialog.open = false; },
    render() {},
  });

  face.dispatch("click");
  assert.equal(dialog.open, false);
  assert.equal(toggle.classList.contains("is-open"), true);
});

test("the phone simulator persists theme patches without replacing other settings", async () => {
  const { invokeCommand } = await vite.ssrLoadModule("/src/lib/mock/commands.ts");
  const before = await invokeCommand("get_state");
  const patch = { theme: "#123456", recentColours: ["#123456"] };
  const updated = await invokeCommand("patch_settings", { patch });
  const saved = await invokeCommand("get_state");

  assert.equal(updated.settings.theme, patch.theme);
  assert.deepEqual(updated.settings.recentColours, patch.recentColours);
  assert.equal(updated.settings.volume, before.settings.volume);
  assert.deepEqual(saved.settings, updated.settings);
});
