import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true, watch: null },
});
after(() => vite.close());
const { reportInitialization } = await vite.ssrLoadModule("/src/lib/startup-health.ts");

test("Linux startup does not force-disable the WebKit DMA-BUF renderer", () => {
  const source = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /WEBKIT_DISABLE_DMABUF_RENDERER/);
});

test("startup failures are never reported as ready", async () => {
  const reports = [];
  let artworkCalls = 0;
  const report = async (ready, detail) => reports.push({ ready, detail });
  const artwork = async () => { artworkCalls++; };
  await reportInitialization(async () => "library unavailable", artwork, () => "linuxPhone", report);
  assert.equal(artworkCalls, 0);
  assert.deepEqual(reports, [{ ready: false, detail: "Error: library unavailable" }]);
  reports.length = 0;
  await reportInitialization(async () => null, async () => { throw new Error("artwork failed"); }, () => "linuxPhone", report);
  assert.deepEqual(reports, [{ ready: false, detail: "Error: artwork failed" }]);
  reports.length = 0;
  await reportInitialization(async () => null, artwork, () => "linuxPhone", report);
  assert.deepEqual(reports, [{ ready: true, detail: "linuxPhone" }]);
});

test("early frontend failures are reported to the backend when available", async () => {
  const listeners = {};
  const reports = [];
  const window = {
    addEventListener: (event, handler) => { listeners[event] = handler; },
    __TAURI_INTERNALS__: {
      invoke: (command, payload) => {
        reports.push({ command, ...payload });
        return Promise.resolve();
      },
    },
  };
  const script = readFileSync(new URL("../public/startup-diagnostics.js", import.meta.url), "utf8");
  runInNewContext(script, { window });
  listeners.error({ message: "script failed" });
  listeners.error({});
  listeners.unhandledrejection({ reason: "promise failed" });
  assert.deepEqual(reports.map((report) => [report.command, report.ready, report.detail]), [
    ["report_frontend_startup", false, "script failed"],
    ["report_frontend_startup", false, "A frontend resource failed to load"],
    ["report_frontend_startup", false, "promise failed"],
  ]);
  delete window.__TAURI_INTERNALS__;
  assert.doesNotThrow(() => listeners.error({ message: "outside Tauri" }));
});
