import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("Android requests portrait orientation for its main activity", async () => {
  const manifest = await readFile(
    new URL("../src-tauri/gen/android/app/src/main/AndroidManifest.xml", import.meta.url),
    "utf8",
  );
  const activity = manifest.match(/<activity\b[^>]*android:name="\.MainActivity"[^>]*>/s)?.[0];
  assert.ok(activity);
  assert.match(activity, /\bandroid:screenOrientation="portrait"/);
});

test("simulator restricts Android to portrait without removing Linux landscape", async () => {
  class Element {
    listeners = new Map();
    value = "";
    checked = false;
    hidden = false;
    textContent = "";
    classList = { toggle() {} };
    style = {
      values: new Map(),
      setProperty(name, value) { this.values.set(name, value); },
    };
    set innerHTML(value) {
      this.options = [...value.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    dispatch(type) { this.listeners.get(type)?.(); }
  }

  const ids = [
    "phone", "app", "status", "status-time", "cutout", "gesture", "note", "preset",
    "kind", "cutout-shape", "lyrics", "update", "reload", "lock-now", "seek",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  elements.app.contentWindow = {
    Event,
    dispatchEvent() {},
    __WAVE_SIM__: {
      summary: () => ({ tracks: 1, playlists: 0, likes: 0 }),
      nowPlaying: () => null,
    },
  };
  const storage = new Map([["wave:device", "android"]]);
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  globalThis.window = { localStorage, setInterval() {} };
  globalThis.document = {
    getElementById: (id) => elements[id] ?? null,
    querySelectorAll: () => [],
  };

  const vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, watch: null },
  });
  try {
    await vite.ssrLoadModule("/dev/phone/frame.ts");
    const preset = elements.preset;
    const kind = elements.kind;
    assert.equal(kind.value, "android");
    assert.deepEqual(preset.options, ["compact", "small", "pixel", "tall"]);

    kind.value = "linuxPhone";
    kind.dispatch("change");
    assert.ok(preset.options.includes("landscape"));
    preset.value = "landscape";
    preset.dispatch("change");
    assert.equal(elements.phone.style.values.get("--screen-width"), "720px");
    assert.equal(elements.phone.style.values.get("--screen-height"), "360px");

    kind.value = "desktop";
    kind.dispatch("change");
    assert.equal(preset.value, "landscape");
    assert.ok(preset.options.includes("landscape"));

    kind.value = "android";
    kind.dispatch("change");
    assert.equal(preset.value, "compact");
    assert.ok(!preset.options.includes("landscape"));
    assert.equal(elements.phone.style.values.get("--screen-width"), "360px");
    assert.equal(elements.phone.style.values.get("--screen-height"), "720px");

    preset.value = "small";
    preset.dispatch("change");
    kind.value = "linuxPhone";
    kind.dispatch("change");
    assert.equal(preset.value, "small");
    assert.ok(preset.options.includes("landscape"));
  } finally {
    await vite.close();
  }
});
