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
        return "export const flushAnalytics = async () => {}; export const mountAnalytics = () => {}; export const notePlaybackError = () => {}; export const noteTrackEnded = () => {}; export const recordEvent = () => {}; export const rememberTracks = () => {};";
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
let holdReads = null;
let deleteError = null;
let importErrors = ["Cannot copy this file"];
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

test("Android settings do not include Discord presence", () => {
  assert.equal("discordPresence" in app.getState().settings, false);
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
    assert.match(app.getState().notice, /1 failed.*Cannot copy this file/);
  }
  assert.deepEqual(audioPickerCalls, ["android"]);
  importErrors = ["Cannot copy this file", "Import finished, but the playlists could not be refreshed: unavailable"];
  for (const action of actions) {
    await action();
    assert.match(app.getState().notice, /2 failed.*playlists could not be refreshed: unavailable/);
  }
  importErrors = ["Cannot copy this file"];
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
