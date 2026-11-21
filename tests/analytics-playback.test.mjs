import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const records = [];
globalThis.__analyticsRecords = records;
globalThis.__analyticsWrite = async (record) => {
  if (globalThis.__analyticsFailWrite) throw new Error("listen write failed");
  records.push(record);
};
const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "analytics-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !/[\\/]src[\\/]lib[\\/](analytics|player)\.ts/.test(importer)) return;
      if (source === "./device" || source === "./ipc") return `\0analytics-test:${source}`;
    },
    load(id) {
      if (id === "\0analytics-test:./device") return "export const isAndroidPlatform = false;";
      if (id === "\0analytics-test:./ipc") {
        return "export const recordPlay = (record) => globalThis.__analyticsWrite(record);";
      }
    },
  }],
});
after(() => vite.close());
const { AudioEngine } = await vite.ssrLoadModule("/src/lib/audio.ts");
const { Player } = await vite.ssrLoadModule("/src/lib/player.ts");
const analytics = await vite.ssrLoadModule("/src/lib/analytics.ts");

class FakeAudio {
  paused = true;
  ended = false;
  seeking = false;
  currentTime = 0;
  duration = 300;
  readyState = 1;
  src = "";
  addEventListener() {}
  removeEventListener() {}
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute() { this.src = ""; }
  load() {}
}

test("listens follow real media progress through background gaps and boundaries", async () => {
  let clock = 0;
  const realPerformance = globalThis.performance;
  globalThis.performance = { now: () => clock };
  globalThis.Audio = FakeAudio;
  globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
  globalThis.document = { hidden: true, addEventListener() {} };
  globalThis.window = {
    addEventListener() {},
    cancelAnimationFrame() {},
    setInterval(callback) { this.checkpoint = callback; return 1; },
    clearInterval() {},
    setTimeout() { return 1; },
    clearTimeout() {},
  };
  globalThis.requestAnimationFrame = () => 1;

  try {
    const engine = new AudioEngine();
    const player = new Player(engine, (id) => ({
      path: `http://127.0.0.1:1234/${id}`, durationMs: 300000, gain: 1,
    }));
    analytics.mountAnalytics({
      player,
      enabled: () => true,
      trackById: (id) => id ? { id, durationMs: 300000 } : undefined,
      collectionById: () => undefined,
    });
    player.setQueue("queue", "Queue", ["one", "two"]);
    player.play();

    clock += 65000;
    engine.element.currentTime = 65;
    window.checkpoint();
    await Promise.resolve();
    assert.equal(records.at(-1).msPlayed, 65000);
    const listenId = records.at(-1).listenId;
    await analytics.prepareAnalyticsTransfer();
    assert.equal(records.at(-1).listenId, listenId);
    assert.equal(records.at(-1).reason, "open");
    assert.equal(records.at(-1).msPlayed, 65000);
    globalThis.__analyticsFailWrite = true;
    await assert.rejects(analytics.prepareAnalyticsTransfer(), /listen write failed/);
    globalThis.__analyticsFailWrite = false;

    clock += 10000;
    player.sampleListening();
    player.seek(180000);
    clock += 5000;
    engine.element.currentTime = 185;
    player.sampleListening();
    player.seek(5000);
    clock += 3000;
    engine.element.currentTime = 8;
    player.next();

    clock += 2000;
    engine.element.currentTime = 2;
    player.pause();
    clock += 20000;
    player.sampleListening();
    player.play();
    clock += 3000;
    engine.element.currentTime = 5;
    engine.element.ended = true;
    analytics.noteTrackEnded();
    await analytics.flushAnalytics();

    const skipped = records.find((record) => record.trackId === "one" && record.reason === "skipped");
    const ended = records.find((record) => record.trackId === "two" && record.reason === "ended");
    assert.equal(skipped.msPlayed, 73000);
    assert.equal(ended.msPlayed, 5000);
    assert.equal(ended.completed, true);
  } finally {
    globalThis.performance = realPerformance;
  }
});
