import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const context = {
  state: { settings: { miniPlayer: false }, windowSlots: [] },
  calls: [],
  failSettings: false,
  failSnap: false,
};
globalThis.__windowSlotTest = context;

const mocks = {
  "@tauri-apps/api/window": "export const getCurrentWindow = () => ({});",
  "../lib/ipc": `
    export const applyWindowSlot = async (slot, part) => {
      globalThis.__windowSlotTest.calls.push(["snap", slot, part]);
      if (globalThis.__windowSlotTest.failSnap) throw new Error("No frame");
    };
  `,
  "../lib/state": `
    const context = () => globalThis.__windowSlotTest;
    export const getState = () => context().state;
    export const updateSettings = async (patch) => {
      context().calls.push(["settings", patch]);
      if (context().failSettings) return false;
      Object.assign(context().state.settings, patch);
      return true;
    };
    export const setNotice = (message) => context().calls.push(["notice", message]);
    export const player = {};
    export const cycleAccent = () => {};
    export const toggleAlwaysOnTop = async () => {};
    export const toggleMiniPlayer = async () => {};
    export const toggleQueue = () => {};
  `,
  "./library": "export const openSwell = () => {};",
  "./topbar": "export const focusSearch = () => {};",
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "window-slot-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/]actions\.ts$/.test(importer) && source in mocks) {
        return `\0window-slot-test:${source}`;
      }
    },
    load(id) {
      if (id.startsWith("\0window-slot-test:")) return mocks[id.slice("\0window-slot-test:".length)];
    },
  }],
});
after(() => vite.close());
const { runSlotAction } = await vite.ssrLoadModule("/src/ui/actions.ts");

function reset(miniPlayer = false, savedMini = true) {
  context.state = { settings: { miniPlayer }, windowSlots: [{ miniPlayer: savedMini }] };
  context.calls = [];
  context.failSettings = false;
  context.failSnap = false;
}

test("position actions enable saved mini-player mode before snapping", async () => {
  for (const [action, part] of [["snap-window", "frame"], ["snap-window-position", "position"]]) {
    reset();
    await runSlotAction(action, 0);
    assert.deepEqual(context.calls, [["settings", { miniPlayer: true }], ["snap", 0, part]]);
  }
});

test("size-only, normal and already-mini slots do not change mini-player mode", async () => {
  reset();
  await runSlotAction("snap-window-size", 0);
  assert.deepEqual(context.calls, [["snap", 0, "size"]]);

  reset(false, false);
  await runSlotAction("snap-window-position", 0);
  assert.deepEqual(context.calls, [["snap", 0, "position"]]);

  reset(true);
  await runSlotAction("snap-window", 0);
  assert.deepEqual(context.calls, [["snap", 0, "frame"]]);
});

test("a failed mode change does not apply the saved position", async () => {
  reset();
  context.failSettings = true;
  await runSlotAction("snap-window-position", 0);
  assert.deepEqual(context.calls, [["settings", { miniPlayer: true }]]);
});

test("missing frames still show the existing notice", async () => {
  reset();
  context.state.windowSlots = [];
  context.failSnap = true;
  await runSlotAction("snap-window", 0);
  assert.equal(context.calls[0][0], "snap");
  assert.match(context.calls[1][1], /No window position or size is saved/);
});
