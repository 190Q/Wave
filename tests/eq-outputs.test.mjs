import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

let snapshot = { outputs: [], activeIds: [], routeKnown: true };
let nativeRead = () => Promise.resolve(snapshot);
let webRead = () => Promise.resolve([]);

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    userAgent: "Windows",
    mediaDevices: { enumerateDevices: () => webRead(), addEventListener() {} },
  },
});
globalThis.document = { hidden: false, addEventListener() {} };
globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke(command) {
      if (command === "get_audio_outputs") return nativeRead();
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    },
  },
  setTimeout() { return 1; },
  clearTimeout() {},
  setInterval() { return 1; },
  clearInterval() {},
  cancelAnimationFrame() {},
};
globalThis.isTauri = true;
globalThis.requestAnimationFrame = () => 1;
globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
globalThis.Audio = class {
  paused = true;
  ended = false;
  addEventListener() {}
  removeEventListener() {}
};
class FakeNode {
  gain = { value: 0 };
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
  connect() {}
  disconnect() {}
}
const sinkRequests = [];
globalThis.AudioContext = class {
  state = "running";
  sampleRate = 48000;
  destination = new FakeNode();
  createGain() { return new FakeNode(); }
  createDynamicsCompressor() { return new FakeNode(); }
  createAnalyser() { return new FakeNode(); }
  setSinkId(id) {
    return new Promise((resolve, reject) => sinkRequests.push({ id, resolve, reject }));
  }
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
});
after(() => vite.close());
const app = await vite.ssrLoadModule("/src/lib/state.ts");

const speaker = { id: "speaker", label: "Speakers (USB)" };
const headphones = { id: "headphones", label: "Wireless Headphones" };
const preset = (id) => ({
  id, name: id, source: "manual", bands: [],
  autoPreamp: false, preampDb: 0, limiter: false,
});

test("native names and multiple outputs do not depend on webview access", async () => {
  snapshot = { outputs: [speaker, headphones], activeIds: [speaker.id], routeKnown: true };
  webRead = () => Promise.resolve([
    { kind: "audiooutput", deviceId: "", label: "" },
    { kind: "audiooutput", deviceId: "default", label: "" },
  ]);
  await app.refreshEqOutputs();
  app.setEqEnabled(true);
  assert.deepEqual(app.eqStatus().outputs, [speaker, headphones]);
  assert.deepEqual(app.eqStatus().activeOutputIds, [speaker.id]);
  assert.deepEqual(app.eqStatus().sinkOutputs, []);
  assert.equal(app.eqStatus().nativeOutputs, true);
});

test("output rules follow system changes and manual curves yield when the output changes", async () => {
  const settings = app.getState().settings;
  settings.eqPresets = [preset("speaker-curve"), preset("headphone-curve")];
  app.setEqDeviceRule(speaker.id, "speaker-curve");
  app.setEqDeviceRule(headphones.id, "headphone-curve");
  assert.equal(app.getState().settings.eqDeviceRules[speaker.id], "speaker-curve");
  assert.equal(app.getState().settings.eqActivePresetId, "speaker-curve");
  app.applyEqPreset("speaker-curve");
  snapshot = { outputs: [speaker, headphones], activeIds: [headphones.id], routeKnown: true };
  await app.refreshEqOutputs();
  assert.equal(app.getState().settings.eqActivePresetId, "headphone-curve");
  assert.deepEqual(app.eqStatus().origin, {
    kind: "device", label: headphones.label, presetId: "headphone-curve",
  });
});

test("an unknown system route does not claim or apply a device rule", async () => {
  snapshot = { outputs: [speaker, headphones], activeIds: [], routeKnown: false };
  await app.refreshEqOutputs();
  assert.deepEqual(app.eqStatus().activeOutputIds, []);
  assert.notEqual(app.eqStatus().origin?.kind, "device");
  assert.equal(app.eqStatus().routeKnown, false);
});

test("a selected web sink maps to a uniquely named native device", async () => {
  snapshot = { outputs: [speaker, headphones], activeIds: [speaker.id], routeKnown: true };
  webRead = () => Promise.resolve([
    { kind: "audiooutput", deviceId: "web-headphones", label: headphones.label },
  ]);
  await app.refreshEqOutputs();
  app.setEqOutput("web-headphones");
  assert.deepEqual(app.eqStatus().activeOutputIds, [speaker.id]);
  assert.equal(sinkRequests.at(-1).id, "web-headphones");
  sinkRequests.at(-1).resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(app.eqStatus().activeOutputIds, [headphones.id]);
  assert.equal(app.eqStatus().origin?.presetId, "headphone-curve");
  app.setEqOutput("");
  sinkRequests.at(-1).resolve();
  await new Promise((resolve) => setImmediate(resolve));
});

test("a rejected sink selection does not activate the wrong device rule", async () => {
  app.setEqOutput("web-headphones");
  sinkRequests.at(-1).reject(new Error("device unavailable"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(app.eqStatus().activeOutputIds, [speaker.id]);
  assert.equal(app.eqStatus().origin?.presetId, "speaker-curve");
  app.setEqOutput("");
});

test("a failed native refresh clears the route without losing known device names", async () => {
  webRead = () => new Promise(() => {});
  nativeRead = () => Promise.reject(new Error("temporarily unavailable"));
  void app.refreshEqOutputs();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(app.eqStatus().outputs, [speaker, headphones]);
  assert.deepEqual(app.eqStatus().activeOutputIds, []);
  assert.equal(app.eqStatus().routeKnown, false);
  assert.equal(app.eqStatus().nativeOutputs, true);
  nativeRead = () => Promise.resolve(snapshot);
});

test("native route updates do not wait for a pending webview enumeration", async () => {
  webRead = () => new Promise(() => {});
  snapshot = { outputs: [speaker], activeIds: [speaker.id], routeKnown: true };
  void app.refreshEqOutputs();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(app.eqStatus().outputs, [speaker]);
  assert.deepEqual(app.eqStatus().activeOutputIds, [speaker.id]);
});

test("older refresh results cannot overwrite a newer route", async () => {
  webRead = () => Promise.resolve([]);
  let finish;
  nativeRead = () => new Promise((resolve) => { finish = resolve; });
  const older = app.refreshEqOutputs();
  nativeRead = () => Promise.resolve({
    outputs: [headphones], activeIds: [headphones.id], routeKnown: true,
  });
  await app.refreshEqOutputs();
  finish({ outputs: [speaker], activeIds: [speaker.id], routeKnown: true });
  await older;
  assert.deepEqual(app.eqStatus().outputs, [headphones]);
  assert.deepEqual(app.eqStatus().activeOutputIds, [headphones.id]);
});

test("unsupported native detection falls back to selectable web outputs", async () => {
  globalThis.isTauri = false;
  webRead = () => Promise.resolve([
    { kind: "audiooutput", deviceId: "default", label: "Default" },
    { kind: "audiooutput", deviceId: "web-headphones", label: headphones.label },
  ]);
  await app.refreshEqOutputs();
  assert.deepEqual(app.eqStatus().outputs, [{ id: "web-headphones", label: headphones.label }]);
  assert.equal(app.eqStatus().nativeOutputs, false);
  app.setEqOutput("web-headphones");
  sinkRequests.at(-1).resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(app.eqStatus().activeOutputIds, ["web-headphones"]);
});
