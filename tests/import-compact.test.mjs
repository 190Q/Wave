import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const mocks = {
  "../lib/device": "export const device = () => globalThis.__importTest.device;",
  "../lib/format": "export const escapeHtml = (value) => value; export const formatTotalDuration = () => '';",
  "../lib/search": "export const scoreItems = () => [];",
  "../lib/state": `
    const context = () => globalThis.__importTest;
    export const getState = () => context().state;
    export const importLogPath = async () => context().logPath ?? "";
    export const importFolder = () => { context().actions.push("folder"); };
    export const importWaveList = (choose) => { context().actions.push("wavelist"); context().chooseWave = choose; };
    export const collectionById = () => undefined;
    export const fetchCovers = () => {}, fetchGenres = () => {}, fetchLyrics = () => {};
    export const fixTagsAndCovers = () => {}, importPhoneFolder = () => {};
    export const importPhoneMusic = () => {}, importPickedFiles = () => { context().actions.push("files"); };
    export const importLink = async (url, duplicates) => { context().actions.push(["importLink", url, duplicates]); };
    export const openImportLog = () => { context().actions.push("log"); }, openSpotifyConfig = () => {};
    export const planLink = async (url) => { context().actions.push(["planLink", url]); return { duplicates: 0 }; };
    export const refreshDeezerStatus = () => {};
    export const refreshSpotifyStatus = () => {}, refreshYoutubeStatus = () => {};
    export const jobRunning = () => false, serviceOf = () => "youtube";
    export const setNotice = () => {}, subscribe = () => {};
  `,
  "./confirm": "export const choiceDialog = async (options) => { globalThis.__importTest.choice = options; return false; }; export const confirmDialog = () => {};",
  "./highlight": "export const highlightHtml = (value) => value;",
  "./icons": "export const fillIcons = () => {};",
  "./picker": "export const placePicker = () => {}; export const windowFrame = () => {};",
  "./popups": "export const claimPopup = () => {}; export const releasePopup = () => {};",
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "import-compact-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/](import-dialog|drop)\.ts$/.test(importer) && source in mocks) {
        return `\0import-compact-test:${source}`;
      }
    },
    load(id) {
      if (id.startsWith("\0import-compact-test:")) return mocks[id.slice("\0import-compact-test:".length)];
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
    this.innerHTML = "";
    this.offsetWidth = 100;
  }
  setAttribute(name, value) { this[name] = value; }
  contains(node) { return node === this; }
  querySelector() { return null; }
  getBoundingClientRect() {
    return { left: 20, right: 120, top: 20, bottom: 60, width: 100, height: 40 };
  }
}

function setup(device, height, collections = [{ id: "library", name: "Library" }]) {
  const context = {
    device,
    actions: [],
    state: { collections, recentImports: [], settings: { searchAlgorithm: "substring" } },
  };
  globalThis.__importTest = context;
  const ids = ["import-dialog", "import-open", "import-close", "import-body", "import-toggle", "import-drop-list"];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  const dialog = elements["import-dialog"];
  dialog.open = false;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  globalThis.document = Object.assign(new Events(), {
    documentElement: new Element(),
    getElementById: (id) => elements[id] ?? null,
  });
  globalThis.window = Object.assign(new Events(), { innerHeight: height, setTimeout, clearTimeout });
  globalThis.getComputedStyle = () => ({ fontSize: "16px", paddingLeft: "0px" });
  return { context, elements, dialog };
}

function actions(html) {
  return [...html.matchAll(/data-import="([^"]+)"/g)].map((match) => match[1]);
}

const { mountImportDialog } = await vite.ssrLoadModule("/src/ui/import-dialog.ts");

test("Wave playlist import offers a playlist or songs only", async () => {
  const { context, elements } = setup("desktop", 350);
  mountImportDialog();
  elements["import-open"].dispatch("click");
  elements["import-drop-list"].dispatch("click", {
    target: { closest: () => ({ dataset: { import: "wavelist" } }) },
  });
  assert.equal(await context.chooseWave(), false);
  assert.equal(context.choice.confirmLabel, "As a playlist");
  assert.equal(context.choice.cancelLabel, "Songs only");
});

test("desktop compact import shows and runs only the local import actions", () => {
  const { context, elements, dialog } = setup("desktop", 350);
  mountImportDialog();
  elements["import-open"].dispatch("click");

  assert.equal(dialog.open, false);
  assert.equal(elements["import-toggle"].classList.contains("is-open"), true);
  assert.deepEqual(actions(elements["import-drop-list"].innerHTML), ["folder", "files", "wavelist"]);

  for (const action of ["folder", "files", "wavelist"]) {
    elements["import-drop-list"].dispatch("click", {
      target: { closest: () => ({ dataset: { import: action } }) },
    });
    assert.equal(elements["import-toggle"].classList.contains("is-open"), false);
    elements["import-open"].dispatch("click");
  }
  assert.deepEqual(context.actions, ["folder", "files", "wavelist"]);
});

test("desktop import places file selection beside folders and the log in recent imports", async () => {
  const { context, elements } = setup("desktop", 800);
  context.logPath = "D:\\Wave\\import.log";
  context.state.recentImports = [{ source: "files", name: "Picked files", detail: "2 songs" }];
  const history = { innerHTML: "" };
  const hint = { textContent: "" };
  elements["import-body"].querySelector = (selector) =>
    selector === "#import-history" ? history : selector === "#import-log-hint" ? hint : null;
  mountImportDialog();
  elements["import-open"].dispatch("click");
  await Promise.resolve();

  const sections = elements["import-body"].innerHTML.match(/<section class="import-section">[\s\S]*?<\/section>/g);
  const local = sections.find((section) => section.includes("Local import"));
  const recent = sections.find((section) => section.includes("Recent imports"));
  assert.deepEqual(actions(local), ["folder", "files", "wavelist"]);
  assert.deepEqual(actions(recent), ["log"]);
  assert.match(hint.textContent, /D:\\Wave\\import\.log/);
  assert.match(history.innerHTML, /import-history-source">Files<\/span>/);

  for (const action of ["log", "files"]) {
    elements["import-body"].dispatch("click", {
      target: { closest: (selector) => selector === "[data-import]" ? { dataset: { import: action } } : null },
    });
  }
  assert.deepEqual(context.actions, ["log", "files"]);
});

test("the full desktop import panel still offers all fetch sections", () => {
  const { elements, dialog } = setup("desktop", 800);
  mountImportDialog();
  elements["import-open"].dispatch("click");

  assert.equal(dialog.open, true);
  for (const action of ["lyrics", "covers", "genres"]) {
    assert.ok(actions(elements["import-body"].innerHTML).includes(action));
  }
  assert.match(elements["import-body"].innerHTML, /YouTube playlists import up to 500 videos/);
  assert.match(elements["import-body"].innerHTML, /YouTube mixes import up to 50 videos/);
});

test("Android full import offers YouTube without Spotify or desktop tools", () => {
  const { elements, dialog } = setup("android", 800);
  mountImportDialog();
  elements["import-open"].dispatch("click");

  assert.equal(dialog.open, true);
  const html = elements["import-body"].innerHTML;
  assert.match(html, /aria-label="YouTube link"/);
  assert.match(html, /playlist or mix link/);
  assert.match(html, /Playlists import up to 500 videos/);
  assert.match(html, /Mixes import up to 50 videos/);
  assert.doesNotMatch(html, /Spotify|Deezer|yt-dlp|data-import="config"/);
  assert.doesNotMatch(html, /data-import="log"/);
});

test("Android compact import opens the link field and keeps it open when the keyboard resizes", async () => {
  const { context, elements, dialog } = setup("android", 350);
  mountImportDialog();
  elements["import-open"].dispatch("click");
  elements["import-drop-list"].dispatch("click", {
    target: { closest: () => ({ dataset: { import: "link-panel" } }) },
  });

  assert.equal(dialog.open, true);
  assert.match(elements["import-body"].innerHTML, /aria-label="YouTube link"/);
  window.innerHeight = 250;
  window.dispatch("resize");
  assert.equal(dialog.classList.contains("is-closed"), false);

  elements["import-body"].querySelector = (selector) =>
    selector === "#import-link-url" ? { value: "https://youtu.be/dQw4w9WgXcQ" } : null;
  elements["import-body"].dispatch("click", {
    target: { closest: (selector) => selector === "[data-import]" ? { dataset: { import: "link" } } : null },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(context.actions, [
    ["planLink", "https://youtu.be/dQw4w9WgXcQ"],
    ["importLink", "https://youtu.be/dQw4w9WgXcQ", false],
  ]);
});

test("Android compact import keeps the fetch actions and disables them without collections", () => {
  const { elements } = setup("android", 350, []);
  mountImportDialog();
  elements["import-open"].dispatch("click");

  const html = elements["import-drop-list"].innerHTML;
  assert.deepEqual(actions(html), ["files", "phone-folder", "wavelist", "link-panel", "phone", "fix", "lyrics", "covers", "genres"]);
  for (const action of ["lyrics", "covers", "genres"]) {
    assert.match(html, new RegExp(`data-import="${action}"[^>]* disabled`));
  }
});
