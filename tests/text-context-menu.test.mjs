import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

test("touch text fields retain native context menus without changing other menus", async () => {
  const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("function mountShortcuts()");
  const end = source.indexOf("\nif (document.readyState", start);
  assert.ok(start >= 0 && end > start);

  class Input {}
  class TextArea {}
  const handlers = new Map();
  let touch = true;
  runInNewContext(`${ts.transpile(source.slice(start, end))}\nmountShortcuts();`, {
    document: { documentElement: { classList: { add() {}, remove() {} } } },
    window: { addEventListener: (type, handler) => handlers.set(type, handler) },
    HTMLInputElement: Input,
    HTMLTextAreaElement: TextArea,
    HTMLSelectElement: class {},
    isTouch: () => touch,
  });

  const contextMenu = (target) => {
    const event = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    handlers.get("contextmenu")(event);
    return event.defaultPrevented;
  };

  assert.equal(contextMenu(new Input()), false);
  assert.equal(contextMenu(new TextArea()), false);
  assert.equal(contextMenu({}), true);

  touch = false;
  assert.equal(contextMenu(new Input()), true);
  assert.equal(contextMenu(new TextArea()), true);
  assert.equal(contextMenu({}), true);
});
