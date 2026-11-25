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
    export const importFolder = (choose) => { context().actions.push("folder"); context().chooseFolder = choose; };
    export const importWaveList = (choose) => { context().actions.push("wavelist"); context().chooseWave = choose; };
    export const collectionById = () => undefined;
    export const fetchCovers = () => {}, fetchGenres = () => {}, fetchLyrics = () => {};
    export const fixTagsAndCovers = () => {};
    export const importPhoneFolder = () => { context().actions.push("phone-folder"); };
    export const importPhoneMusic = () => { context().actions.push("phone"); };
    export const importPickedFiles = () => { context().actions.push("files"); };
    export const importLink = async (url, duplicates) => { context().actions.push(["importLink", url, duplicates]); };
    export const openImportLog = () => { context().actions.push("log"); }, openSpotifyConfig = () => {};
    export const planLink = async (url) => { context().actions.push(["planLink", url]); return context().plan ?? { duplicates: 0 }; };
    export const refreshDeezerStatus = () => {};
    export const refreshSpotifyStatus = () => {}, refreshYoutubeStatus = () => {};
    export const jobRunning = (progress) => !!progress && progress.phase !== "done" && progress.phase !== "failed";
    export const serviceOf = () => "youtube";
    export const setNotice = () => {}, subscribe = (handler) => { context().subscribers.push(handler); };
  `,
  "./highlight": "export const highlightHtml = (value) => value;",
  "./icons": "export const fillIcons = () => {};",
  "./picker": "export const placePicker = () => {}; export const windowFrame = () => {};",
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
      if (source === "./popups" && importer && /[\\/]src[\\/]ui[\\/]drop\.ts$/.test(importer)) {
        return;
      }
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
      toggle: (name, force = !classes.has(name)) => {
        if (force) classes.add(name);
        else classes.delete(name);
        return force;
      },
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
    subscribers: [],
    state: { collections, recentImports: [], settings: { searchAlgorithm: "substring" } },
  };
  globalThis.__importTest = context;
  const ids = [
    "import-dialog", "import-open", "import-close", "import-body", "import-toggle", "import-drop-list",
    "confirm-dialog", "confirm-title", "confirm-message", "confirm-cancel", "confirm-accept",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  const dialog = elements["import-dialog"];
  for (const modal of [dialog, elements["confirm-dialog"]]) {
    modal.open = false;
    modal.showModal = () => { modal.open = true; };
    modal.close = () => { modal.open = false; };
  }
  globalThis.document = Object.assign(new Events(), {
    documentElement: new Element(),
    getElementById: (id) => elements[id] ?? null,
  });
  globalThis.window = Object.assign(new Events(), { innerHeight: height, setTimeout, clearTimeout });
  globalThis.getComputedStyle = () => ({ fontSize: "16px", paddingLeft: "0px" });
  mountConfirm();
  return { context, elements, dialog };
}

function actions(html) {
  return [...html.matchAll(/data-import="([^"]+)"/g)].map((match) => match[1]);
}

function clickImport(elements, action) {
  elements["import-body"].dispatch("click", {
    target: { closest: (selector) => selector === "[data-import]" ? { dataset: { import: action } } : null },
  });
}

const { mountImportDialog } = await vite.ssrLoadModule("/src/ui/import-dialog.ts");
const { mountConfirm } = await vite.ssrLoadModule("/src/ui/confirm.ts");
const { claimPopup } = await vite.ssrLoadModule("/src/ui/popups.ts");

test("Wave playlist import offers a playlist or songs only", async () => {
  const { context, elements } = setup("desktop", 350);
  mountImportDialog();
  elements["import-open"].dispatch("click");
  elements["import-drop-list"].dispatch("click", {
    target: { closest: () => ({ dataset: { import: "wavelist" } }) },
  });
  const answer = context.chooseWave();
  assert.equal(elements["confirm-accept"].textContent, "As a playlist");
  assert.equal(elements["confirm-cancel"].textContent, "Songs only");
  elements["confirm-cancel"].dispatch("click");
  assert.equal(await answer, false);
});

test("desktop compact import shows and runs only the local import actions", () => {
  for (const action of ["folder", "files", "wavelist"]) {
    const { context, elements, dialog } = setup("desktop", 350);
    mountImportDialog();
    elements["import-open"].dispatch("click");
    assert.equal(dialog.open, false);
    assert.equal(elements["import-toggle"].classList.contains("is-open"), true);
    assert.deepEqual(actions(elements["import-drop-list"].innerHTML), ["folder", "files", "wavelist"]);
    elements["import-drop-list"].dispatch("click", {
      target: { closest: () => ({ dataset: { import: action } }) },
    });
    assert.equal(elements["import-toggle"].classList.contains("is-open"), false);
    assert.equal(dialog.open, true);
    assert.equal(dialog.classList.contains("is-closed"), false);
    assert.deepEqual(context.actions, [action]);
  }
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
  assert.doesNotMatch(elements["import-body"].innerHTML, /playlists import up to 500 videos/i);
  assert.match(elements["import-body"].innerHTML, /YouTube mixes import up to 50 videos/);
});

test("Linux phone import dialog follows folder progress", () => {
  const { context, elements, dialog } = setup("linuxPhone", 800);
  const status = { textContent: "" };
  elements["import-body"].querySelector = (selector) => selector === "#import-folder-state" ? status : null;
  context.state.folderImport = "Importing 1 of 50: Book.m4b";
  mountImportDialog();
  elements["import-open"].dispatch("click");

  assert.equal(dialog.open, true);
  assert.match(elements["import-body"].innerHTML, /id="import-folder-state"/);
  assert.equal(status.textContent, "Importing 1 of 50: Book.m4b");
  context.state.folderImport = "Importing 2 of 50: Book 2.m4b (50%)";
  context.subscribers.forEach((handler) => handler());
  assert.equal(status.textContent, "Importing 2 of 50: Book 2.m4b (50%)");
});

test("local imports keep the panel open and display progress, completion, and loudness", () => {
  const { context, elements, dialog } = setup("android", 800);
  const folder = { textContent: "" };
  const loudness = { textContent: "" };
  const transfer = { innerHTML: "" };
  elements["import-body"].querySelector = (selector) => ({
    "#import-folder-state": folder,
    "#import-loudness-state": loudness,
    "#import-transfer-state": transfer,
  })[selector] ?? null;
  mountImportDialog();
  elements["import-open"].dispatch("click");

  for (const action of ["files", "phone-folder", "phone", "wavelist"]) {
    clickImport(elements, action);
    assert.equal(dialog.classList.contains("is-closed"), false);
  }
  context.state.folderImport = "Importing song 2 of 5: Track.mp3";
  context.state.analysing = { done: 3, total: 5 };
  context.state.transferProgress = {
    phase: "downloading", done: 2, total: 5, label: "Track",
    message: "Downloading missing songs.", failures: [], reused: 0, startedAt: Date.now(),
  };
  context.state.downloadProgress = {
    phase: "downloading", done: 3, total: 5, label: "Next track",
    message: "Downloading playlist.", failures: [], reused: 0, startedAt: Date.now(),
  };
  context.subscribers.forEach((handler) => handler());
  assert.equal(folder.textContent, "Importing song 2 of 5: Track.mp3");
  assert.equal(loudness.textContent, "Analysing song loudness: 3 of 5.");
  assert.match(transfer.innerHTML, /2 of 5 - Track/);
  assert.match(transfer.innerHTML, /Downloading missing songs/);
  assert.match(transfer.innerHTML, /3 of 5 - Next track/);
  assert.match(transfer.innerHTML, /Downloading playlist/);

  context.state.folderImport = null;
  context.state.localImportResult = "5 songs imported";
  context.state.analysing = null;
  context.subscribers.forEach((handler) => handler());
  assert.equal(folder.textContent, "5 songs imported");
  assert.equal(loudness.textContent, "");
});

test("folder and Wave playlist choices leave the import panel open", async () => {
  const { context, elements, dialog } = setup("desktop", 800);
  mountImportDialog();
  elements["import-open"].dispatch("click");
  for (const [action, choose] of [["folder", "chooseFolder"], ["wavelist", "chooseWave"]]) {
    clickImport(elements, action);
    const answer = context[choose]();
    assert.equal(elements["confirm-dialog"].open, true);
    assert.equal(dialog.classList.contains("is-closed"), false);
    elements["confirm-cancel"].dispatch("click");
    assert.equal(await answer, false);
    assert.equal(dialog.open, true);
    assert.equal(dialog.classList.contains("is-closed"), false);
  }
});

test("dismissing an import choice leaves the import panel open", async () => {
  const { context, elements, dialog } = setup("desktop", 800);
  mountImportDialog();
  elements["import-open"].dispatch("click");
  clickImport(elements, "folder");
  const answer = context.chooseFolder();
  elements["confirm-dialog"].dispatch("cancel", { preventDefault() {} });
  assert.equal(await answer, null);
  assert.equal(dialog.open, true);
  assert.equal(dialog.classList.contains("is-closed"), false);
});

test("link imports keep the panel and duplicate confirmation open while progress updates", async () => {
  const { context, elements, dialog } = setup("android", 800);
  const field = { value: "https://youtu.be/example" };
  const status = { innerHTML: "" };
  elements["import-body"].querySelector = (selector) =>
    selector === "#import-link-url" ? field : selector === "#import-link-state" ? status : null;
  context.plan = { name: "Example", total: 2, duplicates: 1, examples: ["Song"] };
  mountImportDialog();
  elements["import-open"].dispatch("click");
  clickImport(elements, "link");
  await Promise.resolve();
  assert.equal(elements["confirm-dialog"].open, true);
  assert.equal(dialog.classList.contains("is-closed"), false);
  elements["confirm-accept"].dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 230));
  assert.deepEqual(context.actions, [
    ["planLink", field.value],
    ["importLink", field.value, true],
  ]);
  context.state.importing = {
    phase: "downloading", done: 1, total: 2, label: "Song",
    message: "Downloading songs.", failures: [], reused: 0, startedAt: Date.now(),
  };
  context.subscribers.forEach((handler) => handler());
  assert.match(status.innerHTML, /1 of 2 - Song/);
  assert.match(status.innerHTML, /Downloading songs/);
  assert.equal(dialog.classList.contains("is-closed"), false);
  elements["import-close"].dispatch("click");
  assert.equal(dialog.classList.contains("is-closed"), true);
  context.subscribers.forEach((handler) => handler());
  assert.equal(dialog.classList.contains("is-closed"), true);
});

test("a different popup dismisses both the confirmation and the import panel", async () => {
  const { context, elements, dialog } = setup("desktop", 800);
  mountImportDialog();
  elements["import-open"].dispatch("click");
  clickImport(elements, "folder");
  const answer = context.chooseFolder();
  claimPopup(() => {});
  assert.equal(await answer, null);
  assert.equal(dialog.classList.contains("is-closed"), true);
});

test("Android full import offers YouTube without Spotify or desktop tools", () => {
  const { elements, dialog } = setup("android", 800);
  mountImportDialog();
  elements["import-open"].dispatch("click");

  assert.equal(dialog.open, true);
  const html = elements["import-body"].innerHTML;
  assert.match(html, /aria-label="YouTube link"/);
  assert.match(html, /playlist or mix link/);
  assert.doesNotMatch(html, /playlists import up to 500 videos/i);
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
  assert.equal(dialog.classList.contains("is-closed"), false);
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

test("Android compact local imports open a panel that follows progress", () => {
  for (const action of ["files", "phone-folder", "phone", "wavelist"]) {
    const { context, elements, dialog } = setup("android", 350);
    const status = { textContent: "" };
    elements["import-body"].querySelector = (selector) =>
      selector === "#import-folder-state" ? status : null;
    mountImportDialog();
    elements["import-open"].dispatch("click");
    elements["import-drop-list"].dispatch("click", {
      target: { closest: () => ({ dataset: { import: action } }) },
    });
    assert.equal(dialog.open, true);
    assert.equal(dialog.classList.contains("is-closed"), false);
    context.state.folderImport = "Importing song 1 of 3: Track.mp3";
    context.subscribers.forEach((handler) => handler());
    assert.equal(status.textContent, "Importing song 1 of 3: Track.mp3");
  }
});
