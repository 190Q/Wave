import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const { parse } = createRequire(import.meta.resolve("vite"))("postcss");
const mocks = {
  "../lib/collections": "export const filterCollections = () => [];",
  "../lib/device": "export const device = () => globalThis.__recentsTest.kind;",
  "../lib/format": "export const escapeHtml = (value) => value; export const plural = (n, word) => word;",
  "../lib/search": "export const searchTracks = () => [];",
  "../lib/state": `
    export const getState = () => globalThis.__recentsTest.state;
    export const subscribe = (callback) => { globalThis.__recentsTest.render = callback; };
    export const openCollection = () => {}, playCollection = () => {}, playTrackInContext = () => {};
    export const setSearch = () => {}, toggleLibrary = () => {};
  `,
  "./artwork": 'export const collectionCoverHtml = () => ""; export const resultCoverHtml = () => "";',
  "./covers": "export const hydrateCovers = () => {};",
  "./highlight": "export const highlightHtml = (value) => value;",
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "recents-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/]topbar\.ts$/.test(importer) && source in mocks) {
        return `\0recents-test:${source}`;
      }
    },
    load(id) {
      if (id.startsWith("\0recents-test:")) return mocks[id.slice("\0recents-test:".length)];
    },
  }],
});
after(() => vite.close());

class Element {
  constructor() {
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, force) => {
        const enabled = force ?? !this.classes.has(name);
        if (enabled) this.classes.add(name);
        else this.classes.delete(name);
        return enabled;
      },
    };
    this.style = { setProperty() {} };
    this.listeners = new Map();
    this.clientWidth = 84;
    this.clientHeight = 0;
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this.value = "";
    this.innerHTML = "";
  }
  addEventListener(type, callback) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(callback);
    this.listeners.set(type, handlers);
  }
  dispatch(type) { for (const handler of this.listeners.get(type) ?? []) handler({}); }
  closest() { return null; }
  contains(node) { return node === this; }
  querySelectorAll() { return []; }
  setAttribute() {}
  removeAttribute() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  get scrollWidth() {
    const count = (this.innerHTML.match(/class="crate"/g) ?? []).length;
    const width = count * (this.classes.has("is-compact") ? 60 : 180) + Math.max(0, count - 1) * 8;
    return Math.max(this.clientWidth, width);
  }
}

function setup(kind, withObserver = true) {
  const collections = ["first", "second", "third"].map((id) => ({ id, name: id, subtitle: "", trackIds: [] }));
  const context = {
    kind,
    state: {
      collections,
      recents: ["first", "second"],
      tracksById: new Map(),
      search: "",
      settings: { searchAlgorithm: "substring" },
    },
  };
  globalThis.__recentsTest = context;
  const ids = ["library-open", "search-open", "search-modal", "search-panel", "search-wrap",
    "search", "results", "results-list", "recents"];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  const windowEvents = new Element();
  globalThis.window = windowEvents;
  globalThis.document = {
    getElementById: (id) => elements[id] ?? null,
    addEventListener() {},
  };
  globalThis.ResizeObserver = withObserver ? class {
    constructor(callback) { context.resize = callback; }
    observe() {}
  } : undefined;
  return { context, elements, windowEvents };
}

const { mountTopbar } = await vite.ssrLoadModule("/src/ui/topbar.ts");

test("Linux phone history hides when the compact row does not fit and returns on resize", () => {
  const { context, elements } = setup("linuxPhone");
  mountTopbar();
  const recents = elements.recents;
  assert.equal(recents.classList.contains("is-no-room"), true);
  assert.equal(recents.classList.contains("is-compact"), true);

  recents.clientWidth = 128;
  context.resize();
  assert.equal(recents.classList.contains("is-no-room"), false);
  assert.equal(recents.classList.contains("is-compact"), true);

  recents.clientWidth = 400;
  context.resize();
  assert.equal(recents.classList.contains("is-no-room"), false);
  assert.equal(recents.classList.contains("is-compact"), false);

  recents.clientWidth = 84;
  context.resize();
  assert.equal(recents.classList.contains("is-no-room"), true);
});

test("Linux phone history follows changes to the number of recent collections", () => {
  const { context, elements } = setup("linuxPhone");
  mountTopbar();
  assert.equal(elements.recents.classList.contains("is-no-room"), true);

  context.state.recents = ["first"];
  context.render();
  assert.equal(elements.recents.classList.contains("is-no-room"), false);

  context.state.recents = ["first", "second", "third"];
  context.render();
  assert.equal(elements.recents.classList.contains("is-no-room"), true);

  context.state.recents = [];
  context.render();
  assert.equal(elements.recents.classList.contains("is-no-room"), false);
});

test("Linux phone history follows window resize without ResizeObserver", () => {
  const { elements, windowEvents } = setup("linuxPhone", false);
  mountTopbar();
  assert.equal(elements.recents.classList.contains("is-no-room"), true);
  elements.recents.clientWidth = 128;
  windowEvents.dispatch("resize");
  assert.equal(elements.recents.classList.contains("is-no-room"), false);
});

test("desktop and Android retain their existing history behavior", () => {
  for (const kind of ["desktop", "android"]) {
    const { context, elements } = setup(kind);
    mountTopbar();
    assert.equal(elements.recents.classList.contains("is-no-room"), false);
    if (kind === "desktop") {
      assert.equal(elements.recents.classList.contains("is-compact"), true);
      assert.ok(context.resize);
    } else {
      assert.equal(elements.recents.innerHTML, "");
    }
  }
});

test("hidden history keeps its layout space but cannot be seen", async () => {
  const css = parse(await readFile(new URL("../src/styles/android.css", import.meta.url), "utf8"));
  const rule = css.nodes.find((node) =>
    node.type === "rule" && node.selector === '[data-device="linuxPhone"] .crates.is-no-room',
  );
  assert.ok(rule);
  const declarations = Object.fromEntries(rule.nodes.map((node) => [node.prop, node.value]));
  assert.equal(declarations.visibility, "hidden");
  assert.equal(declarations.overflow, "hidden");
});
