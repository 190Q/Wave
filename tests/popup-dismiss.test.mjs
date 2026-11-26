import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const mocks = {
  "../lib/collections": "export const filterCollections = () => [];",
  "../lib/device": `
    export const device = () => globalThis.__popupTest.device;
    export const isTouch = () => true;
    export const insets = () => ({ top: 0, right: 0, bottom: 0, left: 0 });
    export const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };
  `,
  "../lib/format": "export const escapeHtml = String; export const plural = (count, name) => `${count} ${name}`; export const songCount = String;",
  "../lib/search": "export const searchTracks = () => []; export const scoreItems = () => [];",
  "../lib/state": `
    export const getState = () => globalThis.__popupTest.state;
    export const setSearch = (value) => {
      globalThis.__popupTest.state.search = value;
      globalThis.__popupTest.subscribers.forEach((listener) => listener());
    };
    export const subscribe = (listener) => {
      globalThis.__popupTest.subscribers.push(listener);
      return () => {};
    };
    export const addTracksToPlaylist = () => Promise.resolve();
    export const createPlaylistWithTracks = () => Promise.resolve();
    export const removeTracksFromPlaylist = () => Promise.resolve();
    export const openCollection = () => {};
    export const playCollection = () => {};
    export const playTrackInContext = () => {};
    export const toggleLibrary = () => {};
  `,
  "./artwork": "export const collectionCoverHtml = () => ''; export const resultCoverHtml = () => ''; export const mosaicHtml = () => '';",
  "./covers": "export const hydrateCovers = () => {}; export const releaseCovers = () => {};",
  "./highlight": "export const highlightHtml = String;",
  "./icons": "export const fillIcons = () => {};",
  "./fit": "export const dialogFits = () => false;",
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "popup-dismiss-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/](topbar|menu|drop|add-to-playlist)\.ts$/.test(importer) && source in mocks) {
        return `\0popup-dismiss:${source}`;
      }
    },
    load(id) {
      if (id.startsWith("\0popup-dismiss:")) return mocks[id.slice("\0popup-dismiss:".length)];
    },
  }],
});
after(() => vite.close());

class Element {
  listeners = new Map();
  children = [];
  classes = new Set();
  className = "";
  hidden = false;
  removed = false;
  value = "";
  innerHTML = "";
  offsetWidth = 100;
  offsetHeight = 40;
  clientWidth = 0;
  clientHeight = 0;
  scrollHeight = 0;
  scrollTop = 0;
  style = { setProperty() {} };
  classList = {
    add: (...names) => names.forEach((name) => this.classes.add(name)),
    remove: (...names) => names.forEach((name) => this.classes.delete(name)),
    contains: (name) => this.classes.has(name),
    toggle: (name, force = !this.classes.has(name)) => {
      if (force) this.classes.add(name);
      else this.classes.delete(name);
      return force;
    },
  };
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, target = this, extra = {}) {
    const event = { type, target, button: 0, detail: 0, defaultPrevented: false, ...extra };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  appendChild(child) { this.children.push(child); child.parent = this; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  closest(selector) {
    if (selector === `.${this.className}`) return this;
    return this.parent?.closest(selector) ?? null;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 }; }
  focus() { this.focused = true; }
  setAttribute() {}
  removeAttribute() {}
  remove() { this.removed = true; }
}

function setup(device = "linuxPhone") {
  const elements = Object.fromEntries([
    "library-open", "search-open", "search-modal", "search-panel", "search-wrap",
    "search", "results", "results-list", "recents",
  ].map((id) => [id, new Element()]));
  elements["search-modal"].hidden = true;
  elements["search-wrap"].className = "search-wrap";
  elements["search-modal"].appendChild(elements["search-panel"]);
  elements["search-panel"].appendChild(elements["search-wrap"]);
  elements["search-wrap"].appendChild(elements.search);
  elements["search-wrap"].appendChild(elements.results);
  elements.results.appendChild(elements["results-list"]);

  const document = new Element();
  document.body = new Element();
  document.getElementById = (id) => elements[id] ?? null;
  document.createElement = () => new Element();
  globalThis.document = document;
  const window = new Element();
  window.innerWidth = 360;
  window.innerHeight = 720;
  let nextTimer = 0;
  const timers = new Map();
  window.setTimeout = (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { callback, delay });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.flush = (delay) => {
    for (const [id, timer] of [...timers]) {
      if (timer.delay === delay) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  globalThis.window = window;
  globalThis.getComputedStyle = () => ({ paddingLeft: "0" });
  const context = {
    device,
    subscribers: [],
    state: {
      search: "", settings: { searchAlgorithm: "fuzzy" }, collections: [],
      collectionsRevision: 0, recents: [], tracks: [], tracksById: new Map(), playlists: [],
    },
  };
  globalThis.__popupTest = context;
  return { context, document, elements, window };
}

const { mountTopbar, focusSearch } = await vite.ssrLoadModule("/src/ui/topbar.ts");
const { openMenu, closeMenu } = await vite.ssrLoadModule("/src/ui/menu.ts");
const { createPanel } = await vite.ssrLoadModule("/src/ui/drop.ts");
const { openAddToPlaylist } = await vite.ssrLoadModule("/src/ui/add-to-playlist.ts");

for (const type of ["pointerdown", "touchstart", "click"]) {
  test(`search dismisses on backdrop ${type} but not inside the panel`, () => {
    const { context, elements, window } = setup();
    mountTopbar();
    elements["search-open"].emit("click");
    assert.equal(elements["search-modal"].hidden, false);
    elements.search.value = "song";
    elements.search.emit("input");
    assert.equal(context.state.search, "song");

    elements["search-modal"].emit(type, elements.search);
    elements["search-modal"].emit(type, elements["results-list"]);
    assert.equal(elements["search-modal"].classList.contains("is-closed"), false);
    elements["search-modal"].emit(type);
    assert.equal(elements["search-modal"].classList.contains("is-closed"), true);
    assert.equal(context.state.search, "");
    assert.equal(elements.search.value, "");
    window.flush(220);
    assert.equal(elements["search-modal"].hidden, true);
  });

  test(`outside ${type} dismisses menus without closing for an inside press`, () => {
    const { document, window } = setup();
    const anchor = new Element();
    openMenu(anchor, [{ label: "Action", action() {} }]);
    const menu = document.body.children[0];
    window.flush(0);
    document.emit(type, menu);
    assert.equal(menu.removed, false);
    document.emit(type, new Element());
    assert.equal(menu.removed, true);
    assert.equal(document.listeners.get(type)?.size, 0);
  });

  test(`outside ${type} dismisses compact drops without closing for an inside press`, () => {
    const { document, window } = setup();
    const toggle = new Element();
    const face = new Element();
    toggle.appendChild(face);
    const panel = createPanel({
      dialog: new Element(), toggle, face, show() {}, hide() {}, render() {}, fits: () => false,
    });
    panel.toggle();
    window.flush(0);
    document.emit(type, face);
    assert.equal(panel.isOpen, true);
    document.emit(type, new Element());
    assert.equal(panel.isOpen, false);
    assert.equal(document.listeners.get(type)?.size, 0);
  });

  test(`outside ${type} dismisses playlist popups but not their panel or anchor`, () => {
    const { document, window } = setup();
    const anchor = new Element();
    const panel = new Element();
    const fields = {
      ".add-to-search .add-to-input": new Element(),
      ".add-to-new": new Element(),
      ".add-to-list": new Element(),
    };
    for (const field of Object.values(fields)) panel.appendChild(field);
    panel.querySelector = (selector) => fields[selector] ?? null;
    document.createElement = () => panel;
    openAddToPlaylist(anchor, ["track"]);
    window.flush(0);
    document.emit(type, fields[".add-to-search .add-to-input"]);
    document.emit(type, anchor);
    assert.equal(panel.removed, false);
    document.emit(type, new Element());
    assert.equal(panel.removed, true);
    assert.equal(document.listeners.get(type)?.size, 0);
  });
}

test("search stays open when a drag starts inside and ends on the backdrop", () => {
  const { elements } = setup();
  mountTopbar();
  focusSearch();
  const backdrop = elements["search-modal"];
  backdrop.emit("pointerdown", elements.search);
  backdrop.emit("mousedown", elements.search);
  backdrop.emit("pointerup");
  backdrop.emit("mouseup");
  backdrop.emit("click", backdrop, { detail: 1 });
  assert.equal(backdrop.classList.contains("is-closed"), false);

  backdrop.emit("mousedown");
  assert.equal(backdrop.classList.contains("is-closed"), true);
});

test("secondary mouse presses do not dismiss the search backdrop", () => {
  const { elements } = setup();
  mountTopbar();
  focusSearch();
  const backdrop = elements["search-modal"];
  backdrop.emit("pointerdown", backdrop, { button: 2 });
  backdrop.emit("mousedown", backdrop, { button: 2 });
  assert.equal(backdrop.classList.contains("is-closed"), false);
});

test("reopening search cancels its pending close", () => {
  const { elements, window } = setup();
  mountTopbar();
  focusSearch();
  elements["search-modal"].emit("touchstart");
  focusSearch();
  window.flush(220);
  assert.equal(elements["search-modal"].hidden, false);
  assert.equal(elements["search-modal"].classList.contains("is-closed"), false);
});

test("a suppressed long-press click does not dismiss its menu", () => {
  const { document, window } = setup();
  openMenu(new Element(), [{ label: "Action", action() {} }]);
  const menu = document.body.children[0];
  window.flush(0);
  document.emit("click", new Element(), { defaultPrevented: true });
  assert.equal(menu.removed, false);
  closeMenu();
});

test("closing a compact drop before its deferred listener runs leaves no listener behind", () => {
  const { document, window } = setup();
  const toggle = new Element();
  const face = new Element();
  toggle.appendChild(face);
  const panel = createPanel({
    dialog: new Element(), toggle, face, show() {}, hide() {}, render() {}, fits: () => false,
  });
  panel.toggle();
  assert.equal(panel.isOpen, true);
  panel.dismiss();
  window.flush(0);
  for (const type of ["pointerdown", "touchstart", "click"]) {
    assert.equal(document.listeners.get(type)?.size ?? 0, 0);
  }
});
