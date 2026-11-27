import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const records = [];
const changes = new Set();
const listening = new Set();
let timer = 0;

globalThis.__handoffRecordPlay = async (record) => records.push(record);
globalThis.window = {
  addEventListener() {},
  clearInterval() {},
  clearTimeout() {},
  setInterval() { return ++timer; },
  setTimeout() { return ++timer; },
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "analytics-native-handoff-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "./ipc" && /[\\/]analytics\.ts$/.test(importer ?? "")) {
        return "\0analytics-native-handoff-ipc";
      }
    },
    load(id) {
      if (id === "\0analytics-native-handoff-ipc") {
        return "export const recordPlay = (record) => globalThis.__handoffRecordPlay(record);";
      }
    },
  }],
});
after(() => vite.close());

const analytics = await vite.ssrLoadModule("/src/lib/analytics.ts");
const player = {
  currentId: "one",
  onChange(listener) {
    changes.add(listener);
    return () => changes.delete(listener);
  },
  onListening(listener) {
    listening.add(listener);
    return () => listening.delete(listener);
  },
  sampleListening() {},
};
const snapshot = { currentId: "one", playing: true, sourceId: "queue", sourceName: "Queue", shuffle: false, repeat: "off" };
const change = () => {
  for (const listener of changes) listener(snapshot);
};
const progress = (elapsedMs) => {
  for (const listener of listening) listener(elapsedMs);
};

test("native playback exclusively owns listening history until fallback resumes", async () => {
  analytics.mountAnalytics({
    player,
    enabled: () => true,
    trackById: (id) => id ? { id, durationMs: 120000 } : undefined,
    collectionById: () => undefined,
  });

  change();
  progress(3000);
  analytics.handoffPlaybackToNative();
  progress(5000);
  analytics.noteTrackEnded();
  await analytics.flushAnalytics();

  assert.equal(records.length, 1);
  assert.equal(records[0].reason, "stopped");
  assert.equal(records[0].msPlayed, 3000);

  analytics.reclaimPlaybackOwnership();
  change();
  progress(2000);
  analytics.noteTrackEnded();
  await analytics.flushAnalytics();

  assert.equal(records.length, 2);
  assert.equal(records[1].reason, "ended");
  assert.equal(records[1].msPlayed, 2000);
});
