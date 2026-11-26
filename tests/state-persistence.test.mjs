import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: "Android" },
});
globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
globalThis.Audio = class {
  paused = true;
  readyState = 0;
  addEventListener() {}
  removeEventListener() {}
  removeAttribute() {}
  load() {}
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
};
globalThis.document = { addEventListener() {}, hidden: false };
const timers = new Map();
let nextTimer = 0;
globalThis.window = {
  setTimeout(callback, delay) {
    const id = ++nextTimer;
    timers.set(id, { callback, delay });
    return id;
  },
  clearTimeout(id) { timers.delete(id); },
  setInterval() { return ++nextTimer; },
  clearInterval() {},
  addEventListener() {},
  cancelAnimationFrame() {},
};

function runTimer(delay) {
  const found = [...timers].find(([, timer]) => timer.delay === delay);
  assert.ok(found, `No timer for ${delay}ms`);
  timers.delete(found[0]);
  found[1].callback();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const clone = (value) => structuredClone(value);
const listeners = new Map();
const remembered = [];
globalThis.__testRemembered = remembered;
globalThis.__testListen = (name, callback) => {
  listeners.set(name, callback);
  return Promise.resolve(() => listeners.delete(name));
};
const ipcFile = await readFile(new URL("../src/lib/ipc.ts", import.meta.url), "utf8");
const ipcNames = [...ipcFile.matchAll(/export (?:async )?function (\w+)\(/g)].map((match) => match[1]);
const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  cacheDir: fileURLToPath(new URL("../node_modules/.vite-state-persistence", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  ssr: { noExternal: ["@tauri-apps/api"] },
  plugins: [{
    name: "state-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "@tauri-apps/api/event") return "\0test-events";
      if (source === "@tauri-apps/api/app") return "\0test-app";
      if (source === "./ipc" && /[\\/]src[\\/]lib[\\/]/.test(importer ?? "")) return "\0test-ipc";
      if (source === "./analytics" && /[\\/]state\.ts$/.test(importer ?? "")) return "\0test-analytics";
      if (source === "./audio-watchdog" && /[\\/]state\.ts$/.test(importer ?? "")) return "\0test-watchdog";
    },
    load(id) {
      if (id === "\0test-events") return "export const listen = (...args) => globalThis.__testListen(...args);";
      if (id === "\0test-app") return "export const getVersion = async () => 'test';";
      if (id === "\0test-ipc") {
        return ipcNames.map((name) => `export const ${name} = (...args) => globalThis.__testIpc.${name}(...args);`).join("\n");
      }
      if (id === "\0test-analytics") {
        return "export const flushAnalytics = async () => {}; export const mountAnalytics = () => {}; export const notePlaybackError = () => {}; export const noteTrackEnded = () => {}; export const recordEvent = () => {}; export const rememberTracks = (tracks) => globalThis.__testRemembered.push(tracks.map((track) => track.id));";
      }
      if (id === "\0test-watchdog") return "export const mountAudioWatchdog = () => {};";
    },
  }],
});
after(() => vite.close());

let backend;
let scanTracks = [];
let scanErrors = [];
const scans = [];
const writes = [];
const likes = [];
const playlists = [];
const sessions = [];
const linkCalls = [];
const audioPickerCalls = [];
const playlistDownloads = [];
const waveImports = [];
let holdReads = null;
let deleteError = null;
let importErrors = ["Cannot copy this file"];
let waveWaiting = 0;
const outcome = () => ({
  songs: 0, duplicates: 0, similar: 0, images: 0, lyrics: 0,
  playlist: null, skipped: 0, trackIds: [], errors: [...importErrors], state: clone(backend),
});
globalThis.__testIpc = new Proxy({
  loadState() {
    if (holdReads) {
      const held = holdReads;
      holdReads = null;
      return held.promise;
    }
    return Promise.resolve(clone(backend));
  },
  patchSettings(patch) {
    const request = deferred();
    writes.push({ patch: clone(patch), ...request });
    return request.promise;
  },
  toggleLike(id) {
    const request = deferred();
    likes.push({ id, ...request });
    return request.promise;
  },
  renamePlaylist(id, name) {
    const request = deferred();
    playlists.push({ id, name, ...request });
    return request.promise;
  },
  saveSession(session) {
    const request = deferred();
    sessions.push({ session: clone(session), ...request });
    return request.promise;
  },
  scanLibrary(full) {
    scans.push(full);
    return Promise.resolve({ changed: clone(scanTracks), removed: [], root: "", skipped: 0, errors: [...scanErrors] });
  },
  libraryInfo: async () => ({ tracks: scanTracks.length }),
  audioStreamBase: async () => "http://127.0.0.1:1234",
  pickFolder: async () => "folder",
  pickAudioFiles: async () => { audioPickerCalls.push("desktop"); return ["song"]; },
  pickPhoneAudioFiles: async () => { audioPickerCalls.push("android"); return ["song"]; },
  importFolder: async () => outcome(),
  importPickedFiles: async () => outcome(),
  importPhoneFolder: async () => outcome(),
  scanPhoneMusic: async () => outcome(),
  pickWaveList: async () => "playlist.wavelist",
  importWaveList: async (path, createPlaylist) => {
    waveImports.push([path, createPlaylist]);
    return { ...outcome(), playlist: createPlaylist ? "Test" : null, playlistId: createPlaylist ? "wave-list" : null, skipped: waveWaiting, errors: [] };
  },
  downloadPlaylist: async (id, entries) => { playlistDownloads.push([id, entries]); return { ...outcome(), errors: [] }; },
  youtubePlan: async (url) => { linkCalls.push(["youtubePlan", url]); return { name: "video", total: 1, duplicates: 0, examples: [] }; },
  spotifyPlan: async (url) => { linkCalls.push(["spotifyPlan", url]); return null; },
  deezerPlan: async (url) => { linkCalls.push(["deezerPlan", url]); return null; },
  importYoutube: async (url, duplicates) => { linkCalls.push(["importYoutube", url, duplicates]); return outcome(); },
  importSpotify: async (url) => { linkCalls.push(["importSpotify", url]); return outcome(); },
  importDeezer: async (url) => { linkCalls.push(["importDeezer", url]); return outcome(); },
  deleteTracks: async () => { throw new Error(deleteError); },
  analyticsPlayCounts: async () => ({}),
}, {
  get(target, name) {
    return target[name] ?? (async () => null);
  },
});

const app = await vite.ssrLoadModule("/src/lib/state.ts");
backend = {
  settings: { ...clone(app.getState().settings), autoUpdate: false },
  likes: [], playlists: [], windowSlots: [], recentImports: [], artworkColours: {},
};
await app.init();
await tick();

test("Android settings do not include Discord presence or the local API", () => {
  assert.equal("discordPresence" in app.getState().settings, false);
  assert.equal("localApiEnabled" in app.getState().settings, false);
});

test("Android update installation clears progress after handoff and remains retryable", async () => {
  const first = deferred();
  globalThis.__testIpc.installUpdate = () => first.promise;
  const install = app.installUpdate();
  assert.deepEqual(app.getState().updateProgress, { received: 0, total: 0 });
  listeners.get("update-progress")({ payload: { received: 50, total: 100, installing: false } });
  assert.equal(app.getState().updateProgress.received, 50);
  first.resolve(true);
  await install;
  assert.equal(app.getState().updateProgress, null);
  listeners.get("update-progress")({ payload: { received: 100, total: 100, installing: true } });
  assert.equal(app.getState().updateProgress, null);

  const denied = deferred();
  globalThis.__testIpc.installUpdate = () => denied.promise;
  const retry = app.installUpdate();
  denied.reject(new Error("Allow Wave to install updates, then try again."));
  await retry;
  assert.equal(app.getState().updateProgress, null);
  assert.match(app.getState().updateError, /Allow Wave/);

  globalThis.__testIpc.installUpdate = async () => true;
  await app.installUpdate();
  assert.equal(app.getState().updateProgress, null);
  assert.equal(app.getState().updateError, null);
});

test("an installer that restarts Wave keeps its progress visible", async () => {
  globalThis.__testIpc.installUpdate = async () => false;
  await app.installUpdate();
  assert.notEqual(app.getState().updateProgress, null);
  app.getState().updateProgress = null;
});

test("Android sends both link preview and import only to YouTube", async () => {
  linkCalls.length = 0;
  const url = "https://open.spotify.com/track/example";
  await app.planLink(url);
  await app.importLink(url, false);
  assert.deepEqual(linkCalls, [["youtubePlan", url], ["importYoutube", url, false]]);
});

function completeWrite(index) {
  const request = writes[index];
  assert.ok(request, `No settings request ${index}`);
  Object.assign(backend.settings, request.patch);
  request.resolve(clone(backend));
}

test("serializes partial settings writes and preserves independently changed fields", async () => {
  const start = writes.length;
  const first = app.updateSettings({ normalizeVolume: false });
  const second = app.setTheme("#123456");
  await tick();
  assert.deepEqual(writes.slice(start).map((entry) => entry.patch), [{ normalizeVolume: false }]);
  backend.settings.analyticsEnabled = false;
  completeWrite(start);
  await first;
  await tick();
  assert.deepEqual(writes[start + 1].patch, { theme: "#123456", recentColours: ["#123456"] });
  completeWrite(start + 1);
  await second;
  assert.equal(backend.settings.analyticsEnabled, false);
  assert.equal(backend.settings.normalizeVolume, false);
  assert.equal(app.getState().settings.theme, "#123456");
});

test("new volume and EQ edits survive older acknowledgements and are flushed", async () => {
  let start = writes.length;
  app.setVolume(20);
  runTimer(400);
  await tick();
  app.setVolume(35);
  completeWrite(start);
  await tick();
  assert.equal(app.player.snapshot().volume, 35);
  const flush = app.flushSession();
  await tick();
  assert.deepEqual(writes[start + 1].patch, { volume: 35 });
  completeWrite(start + 1);
  await tick();
  sessions.at(-1).resolve(clone(backend));
  await flush;
  assert.equal(backend.settings.volume, 35);

  start = writes.length;
  app.setEqPreampDb(2);
  runTimer(400);
  await tick();
  app.setEqPreampDb(5);
  completeWrite(start);
  await tick();
  assert.equal(app.getState().settings.eqPreampDb, 5);
  const eqFlush = app.flushSession();
  await tick();
  assert.deepEqual(writes[start + 1].patch, { eqPreampDb: 5 });
  completeWrite(start + 1);
  await eqFlush;
  assert.equal(backend.settings.eqPreampDb, 5);
});

test("a failed settings write reports the error and does not block the next write", async () => {
  const start = writes.length;
  const first = app.updateSettings({ miniPlayer: true });
  const second = app.updateSettings({ rememberWindow: false });
  await tick();
  writes[start].reject(new Error("Settings unavailable"));
  assert.equal(await first, false);
  assert.match(app.getState().notice, /Settings unavailable/);
  await tick();
  completeWrite(start + 1);
  assert.equal(await second, true);
  assert.equal(app.getState().settings.rememberWindow, false);
});

test("a failed newer setting restores the last successful value", async () => {
  const start = writes.length;
  const first = app.updateSettings({ miniPlayer: true });
  const second = app.updateSettings({ miniPlayer: false });
  await tick();
  completeWrite(start);
  assert.equal(await first, true);
  await tick();
  writes[start + 1].reject(new Error("Second update failed"));
  assert.equal(await second, false);
  assert.equal(app.getState().settings.miniPlayer, true);
  assert.equal(backend.settings.miniPlayer, true);
});

test("a failed old EQ save cannot overwrite a newer in-flight edit", async () => {
  const start = writes.length;
  app.setEqPreampDb(7);
  runTimer(400);
  await tick();
  app.setEqPreampDb(9);
  runTimer(400);
  await tick();
  writes[start].reject(new Error("Old EQ save failed"));
  await tick();
  assert.deepEqual(writes[start + 1].patch, { eqPreampDb: 9 });
  completeWrite(start + 1);
  await tick();
  await app.flushSession();
  assert.equal(writes.length, start + 2);
  assert.equal(app.getState().settings.eqPreampDb, 9);
  assert.equal(backend.settings.eqPreampDb, 9);
});

test("a failed EQ edit stays retryable while other settings refresh", async () => {
  const start = writes.length;
  app.setEqPreampDb(11);
  runTimer(400);
  await tick();
  backend.settings.analyticsEnabled = true;
  holdReads = deferred();
  const read = holdReads;
  listeners.get("settings-changed")({ payload: backend.settings });
  writes[start].reject(new Error("EQ save failed"));
  await tick();
  read.resolve(clone(backend));
  await tick();
  await tick();
  assert.equal(app.getState().settings.eqPreampDb, 11);
  assert.equal(app.getState().settings.analyticsEnabled, true);
  const flush = app.flushSession();
  await tick();
  assert.deepEqual(writes[start + 1].patch, { eqPreampDb: 11 });
  completeWrite(start + 1);
  await flush;
});

test("stale reads and unrelated replies cannot revert ordered likes or playlists", async () => {
  const stale = clone(backend);
  holdReads = deferred();
  const read = holdReads;
  listeners.get("state-changed")({ payload: stale });
  const startLikes = likes.length;
  const first = app.toggleLikeTrack("a");
  const second = app.toggleLikeTrack("b");
  await tick();
  assert.equal(likes.length, startLikes + 1);
  backend.likes = ["a"];
  likes[startLikes].resolve(clone(backend));
  await first;
  await tick();
  backend.likes = ["a", "b"];
  likes[startLikes + 1].resolve(clone(backend));
  await second;
  read.resolve(stale);
  await tick();
  await tick();
  assert.deepEqual([...app.getState().likes], ["a", "b"]);

  backend.playlists = [{ id: "p", name: "old", kind: "custom", entries: [], trackIds: [], pending: [], createdAt: 0 }];
  listeners.get("state-changed")({ payload: stale });
  await tick();
  const start = playlists.length;
  const rename1 = app.renamePlaylist("p", "one");
  const rename2 = app.renamePlaylist("p", "two");
  await tick();
  assert.equal(playlists.length, start + 1);
  backend.playlists[0].name = "one";
  playlists[start].resolve(clone(backend));
  await rename1;
  await tick();
  backend.playlists[0].name = "two";
  playlists[start + 1].resolve(clone(backend));
  await rename2;
  assert.equal(app.getState().playlists[0].name, "two");
  assert.deepEqual([...app.getState().likes], ["a", "b"]);
});

test("a stale settings read cannot undo a newer save", async () => {
  const stale = clone(backend);
  holdReads = deferred();
  const read = holdReads;
  listeners.get("settings-changed")({ payload: stale.settings });
  const start = writes.length;
  const change = app.updateSettings({ alwaysOnTop: true });
  await tick();
  completeWrite(start);
  await change;
  read.resolve(stale);
  await tick();
  await tick();
  assert.equal(app.getState().settings.alwaysOnTop, true);
});

test("overlapping session saves remain ordered and flush the latest snapshot", async () => {
  const start = sessions.length;
  app.setSort("size");
  runTimer(350);
  await tick();
  app.setSort("recent");
  const flush = app.flushSession();
  await tick();
  assert.equal(sessions.length, start + 1);
  assert.equal(sessions[start].session.sort, "size");
  sessions[start].resolve(clone(backend));
  await tick();
  assert.equal(sessions[start + 1].session.sort, "recent");
  sessions[start + 1].resolve(clone(backend));
  await flush;
});

test("folder, file, and phone music imports show the first detailed error", async () => {
  audioPickerCalls.length = 0;
  const actions = [
    () => app.importFolder(async () => false),
    () => app.importPickedFiles(),
    () => app.importPhoneFolder(),
    () => app.importPhoneMusic(),
  ];
  for (const action of actions) {
    await action();
    assert.match(app.getState().notice, /1 problem encountered.*Cannot copy this file/);
  }
  assert.deepEqual(audioPickerCalls, ["android"]);
  importErrors = ["Cannot copy this file", "Import finished, but the playlists could not be refreshed: unavailable"];
  for (const action of actions) {
    await action();
    assert.match(app.getState().notice, /2 problems encountered.*playlists could not be refreshed: unavailable/);
  }
  importErrors = ["Cannot copy this file"];
});

test("folder import refreshes all imported tracks without a landed event", async () => {
  const track = (id) => ({ id, title: id, path: id, durationMs: 1000, artist: null, album: null, genre: null });
  scanTracks = [track("existing")];
  scanErrors = [];
  await app.rescan(true);
  scanTracks = [track("existing"), track("imported")];
  const originalScan = globalThis.__testIpc.scanLibrary;
  globalThis.__testIpc.scanLibrary = async (full) => {
    scans.push(full);
    return { changed: full ? clone(scanTracks) : [], removed: [], root: "", skipped: 0, errors: [] };
  };
  try {
    await app.importFolder(async () => false);
    assert.equal(scans.at(-1), true);
    assert.deepEqual(app.getState().tracks.map((item) => item.id), ["existing", "imported"]);
  } finally {
    globalThis.__testIpc.scanLibrary = originalScan;
    scanTracks = [];
  }
});

test("playlist errors identify the action while keeping the underlying detail", async () => {
  const originalCreate = globalThis.__testIpc.createPlaylist;
  globalThis.__testIpc.createPlaylist = async () => { throw new Error("Disk full"); };
  try {
    await app.createPlaylist("Mix");
    assert.equal(app.getState().notice, "Could not finish creating the playlist: Disk full");
  } finally {
    globalThis.__testIpc.createPlaylist = originalCreate;
  }
});

test("folder import keeps progress and landed songs visible until it finishes", async () => {
  const pending = deferred();
  const originalImport = globalThis.__testIpc.importFolder;
  let calls = 0;
  globalThis.__testIpc.importFolder = () => { calls += 1; return pending.promise; };
  const track = { id: "book", title: "Book", path: "book", durationMs: 1000, artist: null, album: null, genre: null };
  try {
    const importing = app.importFolder(async () => false);
    await tick();
    assert.equal(calls, 1);
    assert.equal(app.getState().folderImport, "Reading the selected folder...");
    await app.importFolder(async () => { throw new Error("another picker opened"); });
    assert.equal(calls, 1);

    listeners.get("folder-import-progress")({ payload: "Importing 1 of 50: Book.m4b (50%)" });
    listeners.get("library-landed")({ payload: [track] });
    assert.equal(app.getState().folderImport, "Importing 1 of 50: Book.m4b (50%)");
    assert.ok(app.getState().tracksById.has("book"));

    scanTracks = [track];
    pending.resolve(outcome());
    await importing;
    assert.equal(app.getState().folderImport, null);
    assert.ok(app.getState().tracksById.has("book"));
    listeners.get("folder-import-progress")({ payload: "stale update" });
    assert.equal(app.getState().folderImport, null);
  } finally {
    globalThis.__testIpc.importFolder = originalImport;
    scanTracks = [];
  }
});

test("a full scan preserves tracks that land while its snapshot is in flight", async () => {
  const pending = deferred();
  const originalScan = globalThis.__testIpc.scanLibrary;
  const old = { id: "book", title: "Old", path: "book", durationMs: 1000, artist: null, album: null, genre: null };
  const arrived = { ...old, title: "Updated" };
  globalThis.__testIpc.scanLibrary = () => pending.promise;
  try {
    const scan = app.rescan(true);
    listeners.get("library-landed")({ payload: [arrived] });
    pending.resolve({ changed: [old], removed: ["book"], root: "", skipped: 0, errors: [] });
    await scan;
    assert.equal(app.getState().tracksById.get("book")?.title, "Updated");
  } finally {
    globalThis.__testIpc.scanLibrary = originalScan;
    scanTracks = [];
  }
});

test("folder import clears its status when cancelled or rejected", async () => {
  await app.importFolder(async () => null);
  assert.equal(app.getState().folderImport, null);
  assert.equal(app.getState().localImportResult, null);
  const originalImport = globalThis.__testIpc.importFolder;
  globalThis.__testIpc.importFolder = async () => { throw new Error("Disk full"); };
  try {
    await app.importFolder(async () => false);
    assert.equal(app.getState().folderImport, null);
    assert.match(app.getState().notice, /Disk full/);
    assert.match(app.getState().localImportResult, /Disk full/);
  } finally {
    globalThis.__testIpc.importFolder = originalImport;
  }
});

test("selected files and phone music follow progress and retain the outcome", async () => {
  for (const [method, command] of [["importPickedFiles", "importPickedFiles"], ["importPhoneMusic", "scanPhoneMusic"]]) {
    const pending = deferred();
    const originalImport = globalThis.__testIpc[command];
    globalThis.__testIpc[command] = () => pending.promise;
    try {
      const importing = app[method]();
      await tick();
      assert.notEqual(app.getState().folderImport, null);
      listeners.get("folder-import-progress")({ payload: "Importing song 2 of 5: Track.mp3" });
      assert.equal(app.getState().folderImport, "Importing song 2 of 5: Track.mp3");
      await app.importFolder(async () => { throw new Error("another picker opened"); });
      pending.resolve({ ...outcome(), songs: 5, errors: [] });
      await importing;
      assert.equal(app.getState().folderImport, null);
      assert.match(app.getState().localImportResult, /5 songs imported/);
      listeners.get("folder-import-progress")({ payload: "stale update" });
      assert.equal(app.getState().localImportResult, "5 songs imported.");
    } finally {
      globalThis.__testIpc[command] = originalImport;
    }
  }
});

test("phone folder and file picker cancellation or failure clear progress", async () => {
  const originalFolder = globalThis.__testIpc.importPhoneFolder;
  const originalPicker = globalThis.__testIpc.pickPhoneAudioFiles;
  const originalScan = globalThis.__testIpc.scanPhoneMusic;
  try {
    globalThis.__testIpc.importPhoneFolder = async () => null;
    await app.importPhoneFolder();
    assert.equal(app.getState().folderImport, null);
    assert.equal(app.getState().localImportResult, null);

    globalThis.__testIpc.pickPhoneAudioFiles = async () => null;
    await app.importPickedFiles();
    assert.equal(app.getState().folderImport, null);
    assert.equal(app.getState().localImportResult, null);

    globalThis.__testIpc.scanPhoneMusic = async () => { throw new Error("Permission denied"); };
    await app.importPhoneMusic();
    assert.equal(app.getState().folderImport, null);
    assert.match(app.getState().localImportResult, /Could not finish importing music from your phone: Permission denied/);
  } finally {
    globalThis.__testIpc.importPhoneFolder = originalFolder;
    globalThis.__testIpc.pickPhoneAudioFiles = originalPicker;
    globalThis.__testIpc.scanPhoneMusic = originalScan;
  }
});

test("successful link imports retain their completion message", async () => {
  const originalImport = globalThis.__testIpc.importYoutube;
  globalThis.__testIpc.importYoutube = async () => ({ ...outcome(), songs: 2, errors: [] });
  try {
    await app.importLink("https://youtu.be/example", false);
    assert.equal(app.getState().importing.phase, "done");
    assert.match(app.getState().importing.message, /2 songs imported/);
  } finally {
    globalThis.__testIpc.importYoutube = originalImport;
  }
});

test("Android playlist import starts downloads only for waiting songs", async () => {
  playlistDownloads.length = 0;
  waveWaiting = 5;
  await app.importWaveList(async () => true);
  await tick();
  assert.deepEqual(playlistDownloads, [["wave-list", []]]);
  waveWaiting = 0;
  await app.importWaveList(async () => true);
  await tick();
  assert.equal(playlistDownloads.length, 1);
});

test("Wave playlist import forwards songs-only choice and ignores dismissal", async () => {
  waveImports.length = 0;
  playlistDownloads.length = 0;
  waveWaiting = 0;
  await app.importWaveList(async () => null);
  assert.deepEqual(waveImports, []);
  await app.importWaveList(async () => false);
  assert.deepEqual(waveImports, [["playlist.wavelist", false]]);
  assert.deepEqual(playlistDownloads, []);
});

test("delete failures force a full rescan and reconcile confirmed deletions with scan warnings", async () => {
  const track = (id) => ({ id, title: id, path: id, durationMs: 1000, artist: null, album: null, genre: null });
  scanTracks = [track("a"), track("b"), track("c")];
  scanErrors = [];
  await app.rescan(true);
  assert.deepEqual(app.player.snapshot().order, ["a", "b", "c"]);

  scanTracks = [track("b"), track("c")];
  deleteError = "The changes were saved, but the playlists could not be refreshed: unavailable";
  scanErrors = ["Playlist refresh failed"];
  await app.deleteTracks(["a"]);
  assert.equal(scans.at(-1), true);
  assert.deepEqual(app.getState().tracks.map((item) => item.id), ["b", "c"]);
  assert.deepEqual(app.player.snapshot().order, ["b", "c"]);
  assert.match(app.getState().notice, /changes were saved.*Playlist refresh failed/);

  scanErrors = [];
  deleteError = "Deletion interrupted";
  scanTracks = [track("b")];
  await app.deleteTracks(["c"]);
  assert.equal(scans.at(-1), true);
  assert.deepEqual(app.getState().tracks.map((item) => item.id), ["b"]);
  assert.deepEqual(app.player.snapshot().order, ["b"]);
  assert.match(app.getState().notice, /Deletion interrupted/);

  scanTracks = [];
  await app.deleteTracks(["b"]);
  assert.equal(scans.at(-1), true);
  assert.deepEqual(app.getState().tracks, []);
  assert.match(app.getState().notice, /Deletion interrupted/);
});

test("Android requests playback latency when starting the equalizer", () => {
  let options;
  globalThis.AudioContext = class {
    constructor(value) {
      options = value;
      throw new Error("AudioContext unavailable");
    }
  };
  try {
    app.eqChain.apply({ ...app.getState().settings, eqEnabled: true });
    assert.deepEqual(options, { latencyHint: "playback" });
    assert.equal(app.eqChain.blockedReason, "unsupported");
  } finally {
    delete globalThis.AudioContext;
  }
});

test("refreshing restored analytics snapshots the destination library", async () => {
  scanTracks = [{ id: "destination-song", title: "Song", path: "song", durationMs: 1000, artist: null, album: null, genre: null }];
  await app.rescan(true);
  remembered.length = 0;
  await app.refreshAnalytics();
  assert.deepEqual(remembered, [["destination-song"]]);
});

test("library lookup notices explain results, missing information and unfinished work", async () => {
  const originalCovers = globalThis.__testIpc.fetchCovers;
  const originalGenres = globalThis.__testIpc.fetchGenres;
  const originalLyrics = globalThis.__testIpc.fetchLyrics;
  scanTracks = Array.from({ length: 6 }, (_, index) => ({
    id: `lookup-${index}`, title: `Song ${index}`, path: `song-${index}`,
    durationMs: 1000, artist: null, album: null, genre: null,
  }));
  scanErrors = [];
  await app.rescan(true);
  globalThis.__testIpc.fetchCovers = async () => ({
    restored: 1, tagged: 1, embedded: 1, online: 0, skipped: 1, untagged: 1, missing: 1, errors: ["cover failed"],
  });
  globalThis.__testIpc.fetchGenres = async () => ({
    tagged: 1, skipped: 1, untagged: 1, missing: 1, paused: 1, gaveUp: true, remaining: 1, errors: ["genre failed"],
  });
  globalThis.__testIpc.fetchLyrics = async () => ({
    fetched: 1, synced: 1, skipped: 1, untagged: 1, missing: 1, errors: ["lyrics failed"],
  });
  try {
    await app.fetchCovers("all");
    const covers = app.getState().coversProgress;
    assert.match(covers.message, /Cover art added for 1 song\./);
    assert.match(covers.message, /1 song had no artist\. Add an artist and try again\./);
    assert.match(covers.message, /No cover art found for 1 song\./);
    assert.match(covers.message, /1 problem while looking for cover art\./);
    assert.deepEqual(covers.failures, ["cover failed"]);

    await app.fetchGenres("all");
    const genres = app.getState().genresProgress;
    assert.match(genres.message, /Genres added for 1 song\./);
    assert.match(genres.message, /No genre found for 1 song\./);
    assert.match(genres.message, /1 song left to check\. Try again to continue\./);
    assert.deepEqual(genres.failures, ["genre failed"]);

    await app.fetchLyrics("all");
    const lyrics = app.getState().lyricsProgress;
    assert.match(lyrics.message, /Lyrics added for 1 song\./);
    assert.match(lyrics.message, /1 song has lyrics that follow the music\./);
    assert.match(lyrics.message, /No lyrics found for 1 song\./);
    assert.match(lyrics.message, /1 problem while looking for lyrics\./);
    assert.deepEqual(lyrics.failures, ["lyrics failed"]);
  } finally {
    globalThis.__testIpc.fetchCovers = originalCovers;
    globalThis.__testIpc.fetchGenres = originalGenres;
    globalThis.__testIpc.fetchLyrics = originalLyrics;
    scanTracks = [];
  }
});

test("import results retain metadata lookup failures and explain reused songs", async () => {
  const originalImport = globalThis.__testIpc.importPickedFiles;
  const originalCovers = globalThis.__testIpc.fetchCovers;
  const originalGenres = globalThis.__testIpc.fetchGenres;
  globalThis.__testIpc.importPickedFiles = async () => ({
    ...outcome(), songs: 1, duplicates: 2, images: 1, lyrics: 1, trackIds: ["new"], errors: [],
  });
  globalThis.__testIpc.fetchCovers = async () => { throw new Error("Connection unavailable"); };
  globalThis.__testIpc.fetchGenres = async () => ({
    tagged: 0, skipped: 1, untagged: 0, missing: 0, paused: 0, gaveUp: false, remaining: 0, errors: [],
  });
  try {
    await app.importPickedFiles();
    const message = app.getState().localImportResult;
    assert.match(message, /1 song imported\. 2 songs already in your library\./);
    assert.match(message, /Cover art added for 1 song\. Lyrics added for 1 song\./);
    assert.match(message, /Could not finish looking for cover art: Connection unavailable/);
    assert.match(message, /No genres were added\./);
    assert.match(message, /1 song already had a genre\./);
    assert.equal(app.getState().coversProgress.phase, "failed");
  } finally {
    globalThis.__testIpc.importPickedFiles = originalImport;
    globalThis.__testIpc.fetchCovers = originalCovers;
    globalThis.__testIpc.fetchGenres = originalGenres;
  }
});

test("partial playlist downloads retain the results and error details", async () => {
  const originalDownload = globalThis.__testIpc.downloadPlaylist;
  globalThis.__testIpc.downloadPlaylist = async () => ({
    ...outcome(), songs: 1, duplicates: 2, errors: ["Song could not be downloaded"],
  });
  try {
    await app.downloadPending("playlist", []);
    const progress = app.getState().downloadProgress;
    assert.equal(progress.phase, "failed");
    assert.equal(progress.message, "1 song downloaded. 2 songs already in your library. 1 problem encountered. Check the download details.");
    assert.deepEqual(progress.failures, ["Song could not be downloaded"]);
  } finally {
    globalThis.__testIpc.downloadPlaylist = originalDownload;
  }
});

test("repair results retain song-information refresh errors", async () => {
  const originalRead = globalThis.__testIpc.rereadTags;
  const originalCovers = globalThis.__testIpc.fetchCovers;
  const originalGenres = globalThis.__testIpc.fetchGenres;
  scanTracks = [{ id: "repair", title: "Song", path: "song", durationMs: 1000, artist: null, album: null, genre: null }];
  await app.rescan(true);
  globalThis.__testIpc.rereadTags = async () => { throw new Error("Read failed"); };
  globalThis.__testIpc.fetchCovers = async () => ({
    restored: 0, tagged: 0, embedded: 0, online: 0, skipped: 1, untagged: 0, missing: 0, errors: [],
  });
  globalThis.__testIpc.fetchGenres = async () => ({
    tagged: 0, skipped: 1, untagged: 0, missing: 0, paused: 0, gaveUp: false, remaining: 0, errors: [],
  });
  try {
    await app.fixTagsAndCovers();
    assert.match(app.getState().notice, /Could not refresh song information: Read failed\./);
    assert.match(app.getState().notice, /1 song already had cover art\./);
    assert.match(app.getState().notice, /1 song already had a genre\./);
  } finally {
    globalThis.__testIpc.rereadTags = originalRead;
    globalThis.__testIpc.fetchCovers = originalCovers;
    globalThis.__testIpc.fetchGenres = originalGenres;
    scanTracks = [];
  }
});
