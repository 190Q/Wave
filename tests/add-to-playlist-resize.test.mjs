import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const context = { touch: true, created: [], state: {
  playlists: [], tracksById: new Map(), libraryOpen: true,
  settings: { searchAlgorithm: "substring" },
} };
globalThis.__addToTest = context;

const mocks = {
  "../lib/device": `
    export const isTouch = () => globalThis.__addToTest.touch;
    export const insets = () => ({ top: 0, right: 0, bottom: 0, left: 0 });
  `,
  "../lib/format": 'export const escapeHtml = (text) => text; export const songCount = (n) => String(n);',
  "../lib/search": "export const scoreItems = (items) => items.map((item) => ({ item }));",
  "../lib/state": `
    const context = globalThis.__addToTest;
    export const getState = () => context.state;
    export const subscribe = () => () => {};
    export const createPlaylistWithTracks = (name, ids) => context.created.push({ name, ids });
    export const addTracksToPlaylist = () => {}, removeTracksFromPlaylist = () => {};
  `,
  "./artwork": 'export const mosaicHtml = () => "";',
  "./covers": "export const hydrateCovers = () => {};",
  "./icons": "export const fillIcons = () => {};",
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "add-to-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/]add-to-playlist\.ts$/.test(importer) && source in mocks) {
        return `\0add-to-test:${source}`;
      }
    },
    load(id) {
      if (id.startsWith("\0add-to-test:")) return mocks[id.slice("\0add-to-test:".length)];
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
    this.style = {};
    this.classList = { add() {}, remove() {} };
    this.children = [];
    this.scrollTop = 0;
    this.value = "";
    this.innerHTML = "";
  }
  get offsetWidth() { return Math.min(288, parseFloat(this.style.maxWidth) || Infinity); }
  get offsetHeight() { return Math.min(384, parseFloat(this.style.maxHeight) || Infinity); }
  setAttribute() {}
  closest(selector) { return selector === ".sheet" ? this.sheet ?? null : this.closestMatch ? this : null; }
  contains(node) { return node === this || this.children.includes(node); }
  remove() { this.removed = true; }
  focus() { document.activeElement = this; }
  querySelector(selector) {
    if (selector === ".add-to-search .add-to-input") return this.search;
    if (selector === ".add-to-new") return this.create;
    if (selector === ".add-to-list") return this.list;
    if (selector === "input") return this.input;
    return null;
  }
  getBoundingClientRect() { return { left: 300, right: 360, top: 550 }; }
}

globalThis.Node = Element;
globalThis.HTMLInputElement = class extends Element {};

function setup(touch) {
  context.touch = touch;
  context.created = [];
  const documentEvents = new Events();
  const windowEvents = new Events();
  const viewport = new Events();
  Object.assign(viewport, { offsetLeft: 0, offsetTop: 0, width: 400, height: 800 });
  const panel = new Element();
  panel.search = new HTMLInputElement();
  panel.create = new Element();
  panel.create.input = new HTMLInputElement();
  panel.list = new Element();
  panel.children = [panel.search, panel.create, panel.create.input, panel.list];
  const anchor = new Element();
  anchor.sheet = new Element();
  globalThis.document = Object.assign(documentEvents, {
    createElement: () => panel,
    body: { appendChild() {} },
    activeElement: null,
  });
  globalThis.window = Object.assign(windowEvents, {
    innerWidth: 400, innerHeight: 800, visualViewport: viewport,
    setTimeout, clearTimeout,
  });
  return { panel, anchor, viewport, windowEvents, documentEvents };
}

const { openAddToPlaylist, closeAddToPlaylist } = await vite.ssrLoadModule("/src/ui/add-to-playlist.ts");

test("touch keyboard resize keeps search and new playlist editors within the visual viewport", () => {
  const { panel, anchor, viewport, windowEvents } = setup(true);
  openAddToPlaylist(anchor, ["song"]);
  panel.search.value = "draft";
  panel.search.focus();
  viewport.offsetTop = 40;
  viewport.height = 300;
  viewport.dispatch("resize");
  windowEvents.dispatch("resize");
  windowEvents.dispatch("scroll", { target: document });
  assert.equal(panel.removed, undefined);
  assert.equal(panel.search.value, "draft");
  assert.equal(panel.style.maxHeight, "284px");
  assert.equal(panel.style.top, "48px");

  const button = new Element();
  button.closestMatch = true;
  panel.create.dispatch("click", { target: button });
  panel.create.input.value = "New playlist";
  viewport.height = 270;
  viewport.dispatch("resize");
  assert.equal(document.activeElement, panel.create.input);
  assert.equal(panel.create.input.value, "New playlist");
  assert.equal(panel.style.maxHeight, "254px");
  panel.create.dispatch("keydown", { target: panel.create.input, key: "Enter" });
  assert.deepEqual(context.created, [{ name: "New playlist", ids: ["song"] }]);
  assert.equal(panel.removed, true);
  assert.equal(viewport.listeners.get("resize").size, 0);
  assert.equal(viewport.listeners.get("scroll").size, 0);
});

test("desktop popup still closes on window resize", () => {
  const { panel, anchor, windowEvents } = setup(false);
  openAddToPlaylist(anchor, ["song"]);
  assert.equal(document.activeElement, panel.search);
  windowEvents.dispatch("resize");
  assert.equal(panel.removed, true);
  closeAddToPlaylist();
});
