import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createServer } from "vite";

const context = {
  touch: false,
  snapshot: { currentId: "song", positionMs: 15000, durationMs: 120000 },
  seeks: [],
  listeners: [],
};
globalThis.__seekTimeTest = context;

const mocks = {
  "../lib/device": "export const isTouch = () => globalThis.__seekTimeTest.touch;",
  "../lib/state": `
    export const player = {
      snapshot: () => globalThis.__seekTimeTest.snapshot,
      seek: (time) => globalThis.__seekTimeTest.seeks.push(time),
      onChange: (listener) => globalThis.__seekTimeTest.listeners.push(listener),
    };
  `,
};
const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "seek-time-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/]seek-time\.ts$/.test(importer) && source in mocks) {
        return `\0seek-time-test:${source}`;
      }
    },
    load(id) {
      if (id.startsWith("\0seek-time-test:")) return mocks[id.slice("\0seek-time-test:".length)];
    },
  }],
});
after(() => vite.close());
const { mountSeekTime, openSeekTime, parseSeekTime } = await vite.ssrLoadModule("/src/ui/seek-time.ts");

class Element {
  constructor() {
    this.handlers = new Map();
    this.attributes = new Map();
    this.classes = new Set();
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
    this.hidden = false;
    this.value = "";
  }

  addEventListener(name, handler) { this.handlers.set(name, handler); }
  dispatch(name, event = {}) {
    event.preventDefault ??= () => {};
    this.handlers.get(name)?.(event);
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  setCustomValidity(message) { this.validityMessage = message; }
  reportValidity() { this.reported = true; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function setup({ touch = false, mini = false } = {}) {
  context.touch = touch;
  context.snapshot = { currentId: "song", positionMs: 15000, durationMs: 120000 };
  context.seeks = [];
  context.listeners = [];
  const ids = ["seek-dialog", "seek-form", "seek-input", "seek-hint", "seek-error", "seek-cancel"];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
  const root = new Element();
  if (mini) root.classList.add("is-mini-player");
  const timers = new Map();
  let nextTimer = 0;
  globalThis.document = { documentElement: root, getElementById: (id) => elements[id] ?? null };
  globalThis.window = {
    setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
  };
  mountSeekTime();
  return {
    ...elements,
    flush: () => { for (const [id, callback] of timers) { timers.delete(id); callback(); } },
  };
}

test("seek times accept seconds and colon-separated minutes or hours", () => {
  for (const [text, expected] of [
    ["0", 0], ["90", 90000], [" 1:30 ", 90000], ["61:02", 3662000], ["1:01:02", 3662000],
  ]) {
    assert.equal(parseSeekTime(text), expected);
  }
  for (const text of ["", "-1", "1.5", "1:60", "1:60:00", "1::02", "1:2:3:4", "9e9", "999999999999999999999999"]) {
    assert.equal(parseSeekTime(text), null, text);
  }
});

test("the dialog validates input and seeks without changing playback", () => {
  const ui = setup();
  openSeekTime();
  assert.equal(ui["seek-dialog"].open, true);
  assert.equal(ui["seek-input"].value, "0:15");
  assert.equal(ui["seek-input"].selected, true);
  assert.match(ui["seek-hint"].textContent, /up to 2:00/);

  ui["seek-input"].value = "1:60";
  ui["seek-form"].dispatch("submit");
  assert.deepEqual(context.seeks, []);
  assert.match(ui["seek-error"].textContent, /Enter a time/);
  assert.equal(ui["seek-input"].attributes.get("aria-invalid"), "true");
  ui["seek-input"].dispatch("input");
  assert.equal(ui["seek-error"].hidden, true);

  ui["seek-input"].value = "2:01";
  ui["seek-form"].dispatch("submit");
  assert.match(ui["seek-error"].textContent, /up to 2:00/);
  assert.deepEqual(context.seeks, []);

  ui["seek-input"].value = "90";
  ui["seek-form"].dispatch("submit");
  assert.deepEqual(context.seeks, [90000]);
  ui.flush();
  assert.equal(ui["seek-dialog"].open, false);
});

test("no track, cancellation, track changes and reopening do not seek", () => {
  const ui = setup();
  context.snapshot.currentId = null;
  openSeekTime();
  assert.equal(ui["seek-dialog"].open, undefined);
  context.snapshot.currentId = "song";
  openSeekTime();
  ui["seek-cancel"].dispatch("click");
  openSeekTime();
  ui.flush();
  assert.equal(ui["seek-dialog"].open, true);

  context.snapshot.currentId = "other";
  for (const listener of context.listeners) listener(context.snapshot);
  ui["seek-form"].dispatch("submit");
  ui.flush();
  assert.equal(ui["seek-dialog"].open, false);
  assert.deepEqual(context.seeks, []);

  openSeekTime();
  ui["seek-dialog"].dispatch("cancel");
  ui.flush();
  assert.equal(ui["seek-dialog"].open, false);
  assert.deepEqual(context.seeks, []);
});

test("unknown durations remain seekable and mini-player errors are reported", () => {
  const ui = setup({ touch: true, mini: true });
  context.snapshot.durationMs = 0;
  openSeekTime();
  assert.notEqual(ui["seek-input"].selected, true);
  ui["seek-input"].value = "bad";
  ui["seek-form"].dispatch("submit");
  assert.equal(ui["seek-input"].reported, true);
  ui["seek-input"].dispatch("input");
  ui["seek-input"].value = "1:02:03";
  ui["seek-form"].dispatch("submit");
  assert.deepEqual(context.seeks, [3723000]);
  ui.flush();
});

test("g shortcut works in desktop and mini mode but not in text fields or modified chords", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("function mountShortcuts()");
  const end = source.indexOf('\nif (document.readyState', start);
  const handlers = new Map();
  const calls = [];
  class Input {}
  let mini = false;
  const root = { classList: { contains: () => mini, add() {}, remove() {} } };
  runInNewContext(`${ts.transpile(source.slice(start, end))}\nmountShortcuts();`, {
    document: { documentElement: root },
    window: { addEventListener(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    } },
    HTMLInputElement: Input,
    HTMLSelectElement: class {},
    HTMLTextAreaElement: class {},
    isTouch: () => false,
    openSeekTime: () => calls.push("open"),
  });
  const press = (key, options = {}) => {
    const event = {
      key, code: "", target: {}, ctrlKey: false, shiftKey: false, repeat: false,
      altKey: false, metaKey: false, preventDefault() {}, ...options,
    };
    for (const handler of handlers.get("keydown")) handler(event);
  };
  press("g");
  mini = true;
  press("G");
  press("g", { repeat: true });
  press("g", { ctrlKey: true });
  press("g", { target: new Input() });
  assert.deepEqual(calls, ["open", "open"]);
});
