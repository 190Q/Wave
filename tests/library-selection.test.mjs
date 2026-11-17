import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const context = {};
globalThis.__librarySelectionTest = context;

const mocks = {
  "../lib/device": `
    export const device = () => globalThis.__librarySelectionTest.touch ? "android" : "desktop";
    export const isTouch = () => globalThis.__librarySelectionTest.touch;
  `,
  "../lib/motion": "export const bounce = () => {}; export const reduceMotionActive = () => true;",
  "../lib/state": `
    const context = globalThis.__librarySelectionTest;
    export const getState = () => context.state;
    export const collectionById = (id) => context.state.collections.find((collection) => collection.id === id);
    export const subscribe = () => {};
    export const setTracksLiked = (ids, liked) => context.liked.push({ ids, liked });
    export const playFromCollection = (collectionId, id) => context.played.push({ collectionId, id });
    export const createPlaylist = () => {}, deletePlaylist = () => {},
      deleteTracks = (ids) => context.deleted.push(ids),
      downloadPending = (id, entries) => context.downloaded.push({ id, entries }),
      generatePlaylist = () => {}, playCollection = () => {},
      playTrackInContext = () => {}, refreshRecommendStatus = () => {}, replaceTrackCover = () => {},
      removeTracksFromPlaylist = (id, ids) => context.removed.push({ id, ids }),
      renamePlaylist = (id, name) => context.renamed.push({ id, name }), reorderPlaylist = () => {},
      setFilter = () => {}, setQuery = () => {}, setSort = () => {}, shuffleCollection = () => {},
      toggleLibrary = () => {}, toggleLikeTrack = () => {};
  `,
  "./add-to-playlist": "export const closeAddToPlaylist = () => {}, openAddToPlaylist = () => {};",
  "./artwork": 'export const collectionCoverHtml = () => "", plainCoverStyle = () => "";',
  "./confirm": "export const confirmDialog = async (options) => { globalThis.__librarySelectionTest.confirmed.push(options); return true; };",
  "./covers": "export const hydrateCovers = () => {};",
  "./icons": "export const fillIcons = () => {};",
  "./import-dialog": "export const openImport = () => {};",
  "./menu": `
    export const openMenu = (anchor, items, at, options) => {
      globalThis.__librarySelectionTest.menu = { anchor, items, at, options };
    };
  `,
  "./track-editor": "export const openTrackEditor = () => {};",
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "library-selection-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/]library\.ts$/.test(importer) && source in mocks) {
        return `\0library-selection-test:${source}`;
      }
    },
    load(id) {
      if (id.startsWith("\0library-selection-test:")) {
        return mocks[id.slice("\0library-selection-test:".length)];
      }
    },
  }],
});
after(() => vite.close());

class FakeElement {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.listeners = {};
    this.classes = new Set();
    this.classList = {
      contains: (name) => this.classes.has(name),
      toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
    };
    this.innerHTML = "";
    this.children = [];
    this.scrollTop = 0;
    this.clientHeight = 500;
  }

  addEventListener(type, listener) { this.listeners[type] = listener; }
  removeEventListener() {}
  getBoundingClientRect() { return { top: 0, right: 100, bottom: 100 }; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  contains() { return false; }
  closest(selector) {
    if (selector === "[data-track]" && this.dataset.track) return this;
    if (selector === "[data-collection]" && this.dataset.collection) return this;
    if (selector === "[data-menu]" && this.dataset.menu) return this;
    if (selector === "[data-download]" && this.dataset.download) return this;
    return null;
  }
  dispatch(type, target, extra = {}) {
    const event = { target, preventDefault() { this.defaultPrevented = true; }, ...extra };
    this.listeners[type](event);
    return event;
  }
}

globalThis.HTMLElement = FakeElement;
globalThis.HTMLInputElement = class extends FakeElement {
  focus() { this.focused = true; }
  select() { this.selected = true; }
};
globalThis.document = {
  addEventListener() {},
  getElementById: (id) => context.elements[id] ?? null,
};

const { mountLibrary } = await vite.ssrLoadModule("/src/ui/library.ts");

function setup({ touch = false, kind = "playlist", pending = false } = {}) {
  const tracks = ["one", "two", "three"].map((id) => ({
    id, title: id, artist: null, durationMs: 1000,
  }));
  const ids = tracks.map(({ id }) => id);
  const entries = pending ? [...ids, "waiting"] : ids;
  const collection = { id: "playlist", kind, name: "Playlist", subtitle: "3 songs", entries, trackIds: ids };
  context.touch = touch;
  context.menu = null;
  context.liked = [];
  context.played = [];
  context.removed = [];
  context.deleted = [];
  context.downloaded = [];
  context.renamed = [];
  context.confirmed = [];
  context.state = {
    libraryOpen: true, filter: "playlists", query: "", sort: "name",
    settings: { searchAlgorithm: "substring" },
    tracks, tracksById: new Map(tracks.map((track) => [track.id, track])),
    pendingById: new Map(pending ? [["waiting", { id: "waiting", title: "Waiting", artists: ["Artist"] }]] : []),
    likes: new Set(), collections: [collection],
    collectionsRevision: 1, playCounts: new Map(), scanErrors: [], scanning: false,
  };
  context.elements = Object.fromEntries([
    "sheet", "library", "library-rows", "library-pane", "sheet-count", "chips",
    "sheet-search", "sheet-sort", "sheet-sort-label", "folders", "sheet-back",
  ].map((id) => [id, new FakeElement()]));
  const list = context.elements.library;
  const pane = context.elements["library-pane"];
  const host = new FakeElement();
  const progress = new FakeElement();
  const renameInput = new HTMLInputElement();
  const rows = entries.map((id) => new FakeElement({ track: id }));
  list.querySelectorAll = (selector) => selector === "[data-track]" ? rows : [];
  pane.querySelector = (selector) => selector === ".tracks" ? host
    : selector === "#detail-progress" && pane.innerHTML.includes('id="detail-progress"') ? progress
    : selector === ".detail-rename" && pane.innerHTML.includes('class="search detail-rename"') ? renameInput
    : null;
  mountLibrary();
  list.dispatch("click", new FakeElement({ collection: collection.id }));
  return { list, pane, rows, renameInput, progress };
}

function rightClick(list, row) {
  return list.dispatch("contextmenu", row, { clientX: 30, clientY: 40 });
}

test("desktop song selection never adds a toolbar and keeps the context menu", () => {
  const { list, pane, rows } = setup();
  assert.doesNotMatch(pane.innerHTML, /selection-bar|data-select=/);
  assert.match(pane.innerHTML, /class="tracks"/);

  const event = rightClick(list, rows[0]);
  assert.equal(event.defaultPrevented, true);
  assert.equal(rows[0].classes.has("is-selected"), true);
  assert.deepEqual(context.menu.at, { x: 30, y: 40 });
  assert.deepEqual(context.menu.options, { fitViewport: true });
  const labels = context.menu.items.map(({ label }) => label);
  for (const label of ["Like", "Add to playlist", "Edit song", "Remove from this playlist", "Delete song"]) {
    assert.ok(labels.includes(label));
  }
  assert.doesNotMatch(pane.innerHTML, /selection-bar|data-select=/);

  list.dispatch("click", rows[1], { ctrlKey: true });
  rightClick(list, rows[0]);
  assert.deepEqual(context.menu.items.map(({ label }) => label), [
    "Like 2 songs", "Add to playlist", "Remove 2 songs from this playlist", "Delete 2 songs from the library",
  ]);
  context.menu.items[0].action();
  assert.deepEqual(context.liked, [{ ids: ["one", "two"], liked: true }]);
  assert.doesNotMatch(pane.innerHTML, /selection-bar|data-select=/);

  rightClick(list, rows[2]);
  assert.equal(rows[0].classes.has("is-selected"), false);
  assert.equal(rows[2].classes.has("is-selected"), true);
  assert.equal(context.menu.items[0].label, "Like");

  list.dispatch("click", rows[0], { shiftKey: true });
  assert.ok(rows.every((row) => row.classes.has("is-selected")));
  rightClick(list, rows[1]);
  assert.equal(context.menu.items[0].label, "Like 3 songs");
  assert.doesNotMatch(pane.innerHTML, /selection-bar|data-select=/);
});

test("Android imported playlists offer bulk and individual pending downloads", () => {
  const { list, pane, rows, progress } = setup({ touch: true, pending: true });
  assert.match(pane.innerHTML, /data-download="playlist"/);
  assert.match(pane.innerHTML, /Download 1 song/);
  assert.match(pane.innerHTML, /id="detail-progress"/);
  list.dispatch("click", new FakeElement({ download: "playlist" }));
  assert.deepEqual(context.downloaded, [{ id: "playlist", entries: [] }]);

  rightClick(list, rows[3]);
  context.menu.items.find(({ label }) => label === "Download").action();
  assert.deepEqual(context.downloaded[1], { id: "playlist", entries: ["waiting"] });
  assert.equal(progress.innerHTML, "");
});

test("touch selection retains Select all and Clear selection in the menu", () => {
  const { list, pane, rows } = setup({ touch: true, kind: "generated" });
  rightClick(list, rows[0]);
  assert.deepEqual(context.menu.options, { fitViewport: true });
  context.menu.items.find(({ label }) => label === "Select all").action();
  assert.ok(rows.every((row) => row.classes.has("is-selected")));
  assert.doesNotMatch(pane.innerHTML, /selection-bar|data-select=/);

  rightClick(list, rows[0]);
  assert.equal(context.menu.items[0].label, "Like 3 songs");
  context.menu.items.find(({ label }) => label === "Clear selection").action();
  assert.ok(rows.every((row) => !row.classes.has("is-selected")));

  list.dispatch("click", rows[0]);
  list.dispatch("click", rows[0]);
  assert.deepEqual(context.played, [{ collectionId: "playlist", id: "one" }]);
});

test("long pressing an unselected song never acts on a previous selection", async () => {
  const { list, rows } = setup({ touch: true });
  list.dispatch("click", rows[0]);
  rightClick(list, rows[1]);

  assert.equal(rows[0].classes.has("is-selected"), false);
  assert.equal(rows[1].classes.has("is-selected"), true);
  assert.equal(context.menu.items.length, 9);
  assert.deepEqual(context.menu.options, { fitViewport: true });
  context.menu.items.find(({ label }) => label === "Like").action();
  context.menu.items.find(({ label }) => label === "Remove from this playlist").action();
  context.menu.items.find(({ label }) => label === "Delete song").action();
  await Promise.resolve();
  assert.deepEqual(context.liked, [{ ids: ["two"], liked: true }]);
  assert.deepEqual(context.removed, [{ id: "playlist", ids: ["two"] }]);
  assert.deepEqual(context.deleted, [["two"]]);
  assert.match(context.confirmed[0].message, /"two"/);
});

test("long pressing a selected song keeps the whole touch selection", () => {
  const { list, rows } = setup({ touch: true });
  list.dispatch("click", rows[0]);
  list.dispatch("click", rows[1]);
  rightClick(list, rows[1]);
  context.menu.items.find(({ label }) => label === "Like 2 songs").action();
  assert.deepEqual(context.liked, [{ ids: ["one", "two"], liked: true }]);
});

test("playlist detail rename focuses its visible editor and saves or cancels", () => {
  const { list, pane, renameInput } = setup({ touch: true });
  const menu = new FakeElement({ menu: "playlist" });
  list.dispatch("click", menu);
  context.menu.items.find(({ label }) => label === "Rename").action();
  assert.match(pane.innerHTML, /class="search detail-rename"/);
  assert.equal(renameInput.focused, true);
  assert.equal(renameInput.selected, true);
  renameInput.value = "  Renamed  ";
  list.dispatch("keydown", renameInput, { key: "Enter" });
  assert.deepEqual(context.renamed, [{ id: "playlist", name: "Renamed" }]);
  assert.doesNotMatch(pane.innerHTML, /class="search detail-rename"/);

  list.dispatch("click", menu);
  context.menu.items.find(({ label }) => label === "Rename").action();
  list.dispatch("keydown", renameInput, { key: "Escape" });
  assert.equal(context.renamed.length, 1);
  assert.doesNotMatch(pane.innerHTML, /class="search detail-rename"/);
});
