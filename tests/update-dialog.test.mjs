import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const mocks = {
  "@tauri-apps/api/window": `
    export const getCurrentWindow = () => ({
      onFocusChanged: async (listener) => { globalThis.__updateTest.focusListener = listener; },
    });
  `,
  "@tauri-apps/plugin-opener": "export const openUrl = async () => {};",
  "@tauri-apps/plugin-notification": `
    export const isPermissionGranted = async () => globalThis.__updateTest.permissionGranted;
    export const requestPermission = async () => "denied";
    export const sendNotification = (notice) => globalThis.__updateTest.notifications.push(notice);
  `,
  "../lib/device": "export const device = () => globalThis.__updateTest.device;",
  "../lib/format": `export const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");`,
  "../lib/motion": "export const reduceMotionActive = () => globalThis.__updateTest.reducedMotion ?? false;",
  "../lib/state": `
    const context = () => globalThis.__updateTest;
    export const getState = () => context().state;
    export const subscribe = (listener) => { context().notify = listener; };
    export const checkForUpdates = async () => {
      context().checks += 1;
      context().state.updateChecking = true;
      context().notify();
    };
    export const installUpdate = async () => { context().installs += 1; };
    export const setNotice = () => {};
  `,
  "./popups": `export const claimPopup = () => {}; export const releasePopup = () => {};
    export { listenForBackdropPress } from "/src/ui/popups.ts";`,
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  ssr: { noExternal: ["@tauri-apps/api", "@tauri-apps/plugin-opener", "@tauri-apps/plugin-notification"] },
  plugins: [{
    name: "update-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/]update\.ts$/.test(importer) && source in mocks) {
        return `\0update-test:${source}`;
      }
    },
    load(id) {
      if (id.startsWith("\0update-test:")) return mocks[id.slice("\0update-test:".length)];
    },
  }],
});
after(() => vite.close());

class Element {
  listeners = new Map();
  hidden = false;
  disabled = false;
  innerHTML = "";
  textContent = "";
  offsetWidth = 100;
  open = false;
  classes = new Set();
  classList = {
    add: (name) => this.classes.add(name),
    remove: (name) => this.classes.delete(name),
    contains: (name) => this.classes.has(name),
    toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
  };
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  dispatch(type, event = {}) { this.listeners.get(type)?.({ type, target: this, button: 0, detail: 0, ...event }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function setup(device = "android") {
  const elements = Object.fromEntries([
    "update-dialog", "update-close", "update-body", "update-release", "update-install",
    "update-toast", "update-toast-text", "update-toast-open", "update-toast-close",
  ].map((id) => [id, new Element()]));
  globalThis.document = {
    getElementById: (id) => elements[id] ?? null,
    hasFocus: () => globalThis.__updateTest.focused,
  };
  globalThis.window = { setTimeout, clearTimeout };
  const context = {
    device,
    checks: 0,
    installs: 0,
    focused: true,
    permissionGranted: false,
    notifications: [],
    state: {
      appVersion: "0.2.0",
      updateChecking: false,
      updateProgress: null,
      updateError: null,
      updateFoundAt: 0,
      update: {
        version: "0.3.0",
        url: "https://example.com/release",
        publishedAt: "2026-11-15T00:00:00Z",
        features: ["A new feature"],
        assetName: "Wave_0.3.0_arm64.apk",
        assetUrl: "https://example.com/update.apk",
        automatic: true,
      },
    },
  };
  globalThis.__updateTest = context;
  return { context, elements };
}

const { mountUpdate, openUpdate } = await vite.ssrLoadModule("/src/ui/update.ts");

test("the update backdrop ignores releases from inside and closes on a backdrop press", () => {
  for (const device of ["desktop", "android"]) {
    const { elements } = setup(device);
    mountUpdate();
    openUpdate();
    const dialog = elements["update-dialog"];
    dialog.dispatch("pointerdown", { target: elements["update-body"] });
    dialog.dispatch("mousedown", { target: elements["update-body"] });
    dialog.dispatch("pointerup");
    dialog.dispatch("mouseup");
    dialog.dispatch("click", { detail: 1 });
    assert.equal(dialog.classList.contains("is-closed"), false);
    dialog.dispatch("pointerdown");
    assert.equal(dialog.classList.contains("is-closed"), true);
  }
});

test("the Linux phone update backdrop does not dismiss the full-screen dialog", () => {
  const { elements } = setup("linuxPhone");
  mountUpdate();
  openUpdate();
  elements["update-dialog"].dispatch("pointerdown");
  assert.equal(elements["update-dialog"].classList.contains("is-closed"), false);
});

test("Android and desktop show the same release details, actions and progress", () => {
  const views = [];
  for (const device of ["desktop", "android"]) {
    const { context, elements } = setup(device);
    context.state.update.features = ["A new feature <safe>"];
    mountUpdate();
    openUpdate();
    assert.equal(context.checks, 0);
    assert.match(elements["update-body"].innerHTML, /What's new/);
    assert.match(elements["update-body"].innerHTML, /A new feature &lt;safe&gt;/);
    assert.equal(elements["update-release"].hidden, false);
    assert.equal(elements["update-install"].hidden, false);
    elements["update-install"].dispatch("click");
    assert.equal(context.installs, 1);
    const details = elements["update-body"].innerHTML;

    context.state.updateProgress = { received: 50, total: 100 };
    context.notify();
    assert.match(elements["update-body"].innerHTML, /Downloading, 50 B of 100 B/);
    assert.equal(elements["update-install"].hidden, true);
    const downloading = elements["update-body"].innerHTML;

    context.state.updateProgress = { received: 100, total: 100, installing: true };
    context.notify();
    assert.match(elements["update-body"].innerHTML, /Starting the installer/);
    views.push({ details, downloading, installing: elements["update-body"].innerHTML });
  }
  assert.deepEqual(views[0], views[1]);
});

test("a missing installer is explained on either platform", () => {
  for (const device of ["desktop", "android"]) {
    const { context, elements } = setup(device);
    context.state.update.automatic = false;
    context.state.update.assetName = "";
    mountUpdate();
    openUpdate();
    assert.match(elements["update-body"].innerHTML, /No compatible installer/);
    assert.equal(elements["update-install"].hidden, true);
    assert.equal(elements["update-release"].hidden, false);
  }
});

test("returning to a stale update notification does not open an up-to-date popup", () => {
  const { context, elements } = setup();
  mountUpdate();
  context.focusListener({ payload: true });
  context.focused = false;
  context.state.updateFoundAt = 1;
  context.notify();
  context.state.update = null;
  context.notify();
  context.focused = true;
  context.focusListener({ payload: true });
  assert.equal(elements["update-dialog"].open, false);
});

test("an Android update found in the background stays quiet on focus", () => {
  const { context, elements } = setup();
  context.state.update = null;
  mountUpdate();
  context.focusListener({ payload: true });
  context.focused = false;
  context.reducedMotion = true;
  context.state.update = { version: "0.3.0", features: [] };
  context.state.updateFoundAt = 1;
  context.notify();
  assert.equal(elements["update-toast"].classList.contains("is-static"), true);

  context.focused = true;
  context.reducedMotion = false;
  context.focusListener({ payload: true });
  assert.equal(elements["update-dialog"].open, false);
  assert.equal(elements["update-toast"].hidden, false);
});

test("a desktop update found in the background still opens on focus", () => {
  const { context, elements } = setup("desktop");
  mountUpdate();
  context.focusListener({ payload: true });
  context.focused = false;
  context.state.updateFoundAt = 1;
  context.notify();
  context.focused = true;
  context.focusListener({ payload: true });
  assert.equal(elements["update-dialog"].open, true);
});

test("system update notifications explain where to find update options", async () => {
  const { context } = setup("desktop");
  context.permissionGranted = true;
  context.state.update.features = ["A technical release note"];
  context.state.update.automatic = false;
  mountUpdate();
  context.state.updateFoundAt = 1;
  context.notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(context.notifications, [{
    title: "Wave 0.3.0 is available",
    body: "Open Wave to see what's new and your update options.",
  }]);
});
