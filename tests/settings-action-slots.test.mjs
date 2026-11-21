import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const mocks = {
  "../lib/analytics": "export const forgetCaptured = () => {}; export const prepareAnalyticsTransfer = async () => globalThis.__settingsTest.transfer.push('prepare');",
  "../lib/device": `
    export const device = () => globalThis.__settingsTest.device;
    export let isAndroidPlatform = false;
    export const setAndroidPlatform = (value) => { isAndroidPlatform = value; };
    export const titlebarVisible = (value) => value ?? true;
  `,
  "./confirm": "export const confirmDialog = async () => globalThis.__settingsTest.confirm;",
  "../lib/format": `
    export const escapeHtml = (value) => String(value);
    export const formatTotalDuration = (value) => String(value);
    export const plural = (count, name) => count + " " + name;
  `,
  "../lib/ipc": `
    export const analyticsStats = () => globalThis.__settingsTest.analytics;
    export const analyticsSwell = () => globalThis.__settingsTest.analytics;
    export const clearAnalytics = async () => {};
    export const pickAnalyticsImport = async () => globalThis.__settingsTest.importPath;
    export const pickAnalyticsExport = async () => globalThis.__settingsTest.exportPath;
    export const importAnalytics = async (path) => globalThis.__settingsTest.transfer.push(['import', path]);
    export const exportAnalytics = async (path) => globalThis.__settingsTest.transfer.push(['export', path]);
    export const openLibraryFolder = async () => {};
    export const resetWindowGeometry = async () => {};
  `,
  "../lib/swell": 'export const swellWindow = () => ({ from: 0, to: 1, bucket: "year" });',
  "../lib/search": 'export const SEARCH_ALGORITHMS = [{ id: "substring", label: "Substring", description: "" }];',
  "../lib/state": `
    const context = () => globalThis.__settingsTest;
    export const getState = () => context().state;
    export const subscribe = (listener) => { context().notify = listener; };
    export const updateSettings = async (patch) => {
      context().saved.push(patch);
      context().state.settings = { ...context().state.settings, ...patch };
      return true;
    };
    export const captureWindowSlot = async (index) => { context().captured.push(index); };
    export const checkForUpdates = async () => {
      context().updateChecks += 1;
      context().state.update = context().checkResult;
      context().notify();
    };
    export const exportCollection = async () => {};
    export const fixTagsAndCovers = async () => {};
    export const jobRunning = () => false;
    export const refreshAnalytics = async () => context().transfer.push('refresh');
    export const rescanLibrary = async () => {};
    export const setNotice = (value) => { context().notice = value; };
  `,
  "./drop": `
    export const createPanel = ({ show }) => ({
      toggle: () => show(), dismiss() {}, refresh() {}, fit() {}, isOpen: false,
    });
  `,
  "./collection-picker": `
    export const mountCollectionPicker = () => ({ close() {}, isOpen: false });
  `,
  "./eq": "export const openEq = () => {};",
  "./icons": "export const fillIcons = () => {};",
  "./picker": `
    export const placePicker = (picker, anchor) => {
      globalThis.__settingsTest.placements.push({ picker, anchor });
    };
  `,
  "./popups": "export const claimPopup = () => {}; export const releasePopup = () => {};",
  "./update": "export const openUpdate = () => { globalThis.__settingsTest.updateOpens += 1; };",
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "settings-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/]settings\.ts$/.test(importer) && source in mocks) {
        return `\0settings-test:${source}`;
      }
    },
    load(id) {
      if (id.startsWith("\0settings-test:")) return mocks[id.slice("\0settings-test:".length)];
    },
  }],
});
after(() => vite.close());

class Events {
  listeners = new Map();
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
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
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
    };
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.hidden = false;
    this.offsetWidth = 100;
    this.offsetHeight = 30;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  getBoundingClientRect() { return { left: 50, top: 50, right: 350, bottom: 400, width: 300, height: 350 }; }
  closest(selector) {
    if (selector === "[data-toggle]" && this.dataset.toggle !== undefined) return this;
    if (selector === "[data-slot-open]" && this.dataset.slotOpen !== undefined) return this;
    if (selector === "[data-slot-set]" && this.dataset.slotSet !== undefined) return this;
    if (selector === "[data-command]" && this.dataset.command !== undefined) return this;
    if (selector === ".slot-row") return this.row ?? null;
    return null;
  }
  focus() { document.activeElement = this; }
}

class Body extends Element {
  scrollTop = 0;
  renders = 0;
  slots = [];
  picker = null;
  set innerHTML(html) {
    this.html = html;
    this.renders += 1;
    this.scrollTop = 0;
    this.picker = null;
    this.slots = [...html.matchAll(/data-slot-open="(\d+)" aria-expanded="(true|false)"/g)]
      .map((match) => {
        const trigger = new Element();
        trigger.dataset.slotOpen = match[1];
        trigger.setAttribute("aria-expanded", match[2]);
        trigger.row = {
          insertAdjacentHTML: (_position, markup) => {
            const picker = new Element();
            picker.markup = markup;
            picker.remove = () => { if (this.picker === picker) this.picker = null; };
            this.picker = picker;
          },
        };
        return trigger;
      });
  }
  get innerHTML() { return this.html; }
  querySelector(selector) {
    if (selector === ".slot-row .slot-picker") return this.picker;
    const slot = /^\[data-slot-open="(\d+)"\]$/.exec(selector);
    return slot ? this.slots[Number(slot[1])] ?? null : null;
  }
}

function setup(device = "desktop", androidPlatform = false) {
  setAndroidPlatform(androidPlatform);
  const body = new Body();
  const dialog = new Element();
  dialog.open = false;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  const elements = {
    "settings-dialog": dialog,
    "settings-open": new Element(),
    "settings-close": new Element(),
    "settings-save": new Element(),
    "settings-body": body,
    "settings-toggle": new Element(),
    "settings-drop-list": new Element(),
  };
  globalThis.document = {
    activeElement: null,
    getElementById: (id) => elements[id] ?? null,
  };
  globalThis.window = Object.assign(new Events(), { setTimeout, clearTimeout });
  const context = {
    device,
    analytics: new Promise(() => {}),
    placements: [],
    captured: [],
    saved: [],
    updateChecks: 0,
    updateOpens: 0,
    transfer: [],
    importPath: null,
    exportPath: null,
    confirm: false,
    checkResult: null,
    state: {
      settings: {
        shortcutSlots: [], reduceMotion: "system", searchAlgorithm: "substring",
        showTitlebar: null, analyticsEnabled: true, localApiEnabled: false,
      },
      collections: [], tracks: [], windowSlots: [], scanErrors: [],
      root: "", skipped: 0, scanning: false, analysing: null,
      genresProgress: null, libraryInfo: null, update: null,
      updateChecking: false, updateProgress: null, updateError: null, appVersion: "",
    },
  };
  globalThis.__settingsTest = context;
  return { body, dialog, context, save: elements["settings-save"] };
}

const { mountSettings, openSettings } = await vite.ssrLoadModule("/src/ui/settings.ts");
const { setAndroidPlatform } = await vite.ssrLoadModule("\0settings-test:../lib/device");

test("listening-record transfers honor cancellation and confirm replacement", async () => {
  const { body, context } = setup();
  context.analytics = Promise.resolve({ path: "analytics.db", plays: 0 });
  mountSettings();
  openSettings();
  assert.match(body.innerHTML, /data-command="import-analytics"/);
  assert.match(body.innerHTML, /data-command="export-analytics"/);
  const command = (name) => {
    const button = new Element();
    button.dataset.command = name;
    body.dispatch("click", { target: button });
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  command("export-analytics");
  await tick();
  assert.deepEqual(context.transfer, []);
  context.exportPath = "backup.waveanalytics";
  command("export-analytics");
  await tick();
  assert.deepEqual(context.transfer, ["prepare", ["export", "backup.waveanalytics"]]);
  context.importPath = "backup.waveanalytics";
  command("import-analytics");
  await tick();
  assert.equal(context.transfer.length, 2);
  context.confirm = true;
  command("import-analytics");
  await tick();
  assert.deepEqual(context.transfer.slice(2), ["prepare", ["import", "backup.waveanalytics"], "refresh"]);
  assert.equal(context.notice, "Listening record imported.");
});

test("Discord presence appears on desktop and Linux phones, not Android", () => {
  for (const [device, androidPlatform, visible] of [
    ["desktop", false, true],
    ["linuxPhone", false, true],
    ["android", false, false],
    ["android", true, false],
    ["desktop", true, false],
    ["linuxPhone", true, false],
  ]) {
    const { body } = setup(device, androidPlatform);
    mountSettings();
    openSettings();
    assert.equal(body.innerHTML.includes('data-toggle="discordPresence"'), visible);
    assert.match(body.innerHTML, /data-toggle="systemMediaControls"/);
    assert.match(body.innerHTML, /data-toggle="normalizeVolume"/);
  }
});

test("the local API developer setting is hidden on Android and off by default", () => {
  for (const [device, androidPlatform, visible] of [
    ["desktop", false, true],
    ["linuxPhone", false, true],
    ["android", false, false],
    ["android", true, false],
    ["desktop", true, false],
  ]) {
    const { body } = setup(device, androidPlatform);
    mountSettings();
    openSettings();
    assert.equal(body.innerHTML.includes('data-toggle="localApiEnabled"'), visible);
    if (visible) {
      assert.match(body.innerHTML, /<h3 class="settings-title">Developer<\/h3>/);
      assert.match(body.innerHTML, /aria-checked="false" data-toggle="localApiEnabled"/);
      assert.ok(body.innerHTML.indexOf(">Developer</h3>") < body.innerHTML.indexOf(">Updates</h3>"));
    }
  }
});

test("saving the local API toggle persists only the changed setting", async () => {
  const { body, context, save } = setup();
  mountSettings();
  openSettings();
  const toggle = new Element();
  toggle.dataset.toggle = "localApiEnabled";
  body.dispatch("click", { target: toggle });
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  assert.equal(save.hidden, false);
  assert.deepEqual(context.saved, []);
  save.dispatch("click");
  await Promise.resolve();
  assert.deepEqual(context.saved, [{ localApiEnabled: true }]);
  assert.equal(save.hidden, true);

  body.dispatch("click", { target: toggle });
  save.dispatch("click");
  await Promise.resolve();
  assert.deepEqual(context.saved[1], { localApiEnabled: false });
});

test("checking updates stays in settings until an available update is selected", async () => {
  for (const device of ["desktop", "android"]) {
    const { body, dialog, context } = setup(device, device === "android");
    context.state.settings.autoUpdate = true;
    mountSettings();
    openSettings();
    const button = new Element();
    button.dataset.command = "check-update";

    body.dispatch("click", { target: button });
    await Promise.resolve();
    assert.equal(context.updateChecks, 1);
    assert.equal(context.updateOpens, 0);
    assert.equal(dialog.open, true);
    assert.match(body.innerHTML, /up to date/);

    context.checkResult = { version: "0.4.0" };
    body.dispatch("click", { target: button });
    await Promise.resolve();
    assert.equal(context.updateChecks, 2);
    assert.equal(context.updateOpens, 0);
    assert.match(body.innerHTML, /Update to 0.4.0/);

    body.dispatch("click", { target: button });
    assert.equal(context.updateChecks, 2);
    assert.equal(context.updateOpens, 1);
  }
});

test("slot menus stay open without rebuilding or scrolling the settings body", () => {
  const { body, dialog, context } = setup();
  mountSettings();
  openSettings();
  body.scrollTop = 1200;
  body.dispatch("scroll");
  const trigger = body.slots[0];
  trigger.focus();
  const renders = body.renders;

  body.dispatch("click", { target: trigger });
  assert.equal(body.renders, renders);
  assert.equal(body.scrollTop, 1200);
  assert.equal(document.activeElement, trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.match(body.picker.markup, /data-action="play-pause"/);
  assert.equal(context.placements[0].anchor, trigger);

  context.state.skipped = 3;
  context.notify();
  assert.equal(body.renders, renders);
  assert.ok(body.picker);
  body.dispatch("scroll");
  assert.ok(body.picker);

  dialog.dispatch("cancel", { preventDefault() {} });
  assert.equal(body.picker, null);
  assert.equal(body.scrollTop, 1200);
  assert.equal(body.renders, renders + 1);
  assert.equal(document.activeElement, body.slots[0]);
  assert.match(body.innerHTML, /3 non-audio files skipped/);
});

test("selecting and saving a slot keeps the scroll position and captures snap slots", async () => {
  const { body, context, save } = setup();
  mountSettings();
  openSettings();
  body.scrollTop = 1100;
  body.dispatch("scroll");

  body.dispatch("click", { target: body.slots[8] });
  const option = new Element();
  option.dataset = { slotSet: "8", action: "snap-window-size" };
  body.dispatch("click", { target: option });
  assert.deepEqual(context.captured, [8]);
  assert.equal(body.scrollTop, 1100);
  assert.equal(body.picker, null);
  assert.equal(document.activeElement, body.slots[8]);
  assert.match(body.innerHTML, /Snap to saved window size/);
  assert.equal(save.hidden, false);

  save.dispatch("click");
  await Promise.resolve();
  assert.equal(context.saved[0].shortcutSlots[8], "snap-window-size");
  assert.equal(body.scrollTop, 1100);
  assert.equal(save.hidden, true);
});

test("switching slots and scrolling dismiss the current picker", () => {
  const { body, context } = setup();
  mountSettings();
  openSettings();
  body.scrollTop = 1000;
  body.dispatch("scroll");

  const first = body.slots[0];
  const second = body.slots[1];
  body.dispatch("click", { target: first });
  body.dispatch("click", { target: second });
  assert.equal(first.getAttribute("aria-expanded"), "false");
  assert.equal(second.getAttribute("aria-expanded"), "true");
  assert.match(body.picker.markup, /data-slot-set="1"/);

  context.notify();
  body.scrollTop = 1050;
  body.dispatch("scroll");
  assert.equal(body.picker, null);
  assert.equal(body.scrollTop, 1050);
  assert.equal(body.slots[1].getAttribute("aria-expanded"), "false");
});
