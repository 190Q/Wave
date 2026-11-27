import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

test("l activates the current song's like control in normal and mini mode", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("function mountShortcuts()");
  const end = source.indexOf("\nif (document.readyState", start);
  assert.ok(start >= 0 && end > start);

  class Input {}
  class Select {}
  class TextArea {}
  const handlers = new Map();
  const likes = new Set();
  const calls = [];
  const animations = [];
  let track = { id: "first" };
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
    HTMLSelectElement: Select,
    HTMLTextAreaElement: TextArea,
    isTouch: () => false,
    toggleCurrentLike: () => {
      if (!track) return;
      calls.push(track.id);
      animations.push(track.id);
      if (likes.has(track.id)) likes.delete(track.id);
      else likes.add(track.id);
    },
  });
  const press = (key, options = {}) => {
    const event = {
      key, code: "", target: {}, ctrlKey: false, shiftKey: false, repeat: false,
      altKey: false, metaKey: false, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...options,
    };
    for (const handler of handlers.get("keydown")) handler(event);
    return event.defaultPrevented;
  };

  assert.equal(press("l"), true);
  assert.equal(likes.has("first"), true);
  assert.deepEqual(animations, ["first"]);
  assert.equal(press("l", { repeat: true }), true);
  assert.equal(likes.has("first"), true);
  assert.deepEqual(animations, ["first"]);
  mini = true;
  assert.equal(press("L", { shiftKey: true }), true);
  assert.equal(likes.has("first"), false);
  track = { id: "second" };
  assert.equal(press("l"), true);
  assert.equal(likes.has("second"), true);

  for (const options of [
    { ctrlKey: true }, { altKey: true }, { metaKey: true },
    { target: new Input() }, { target: new Select() }, { target: new TextArea() },
  ]) {
    assert.equal(press("l", options), false);
  }
  track = undefined;
  assert.equal(press("l"), true);
  assert.deepEqual(calls, ["first", "first", "second"]);
  assert.deepEqual(animations, ["first", "first", "second"]);
});
