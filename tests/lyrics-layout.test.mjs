import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

const { parse } = createRequire(import.meta.resolve("vite"))("postcss");

test("phone lyric tracks keep horizontal spacing and safe-area insets", async () => {
  const css = await readFile(new URL("../src/styles/android.css", import.meta.url), "utf8");
  const rule = parse(css).nodes.find((node) =>
    node.type === "rule" && node.selector === ':is([data-device="android"], [data-device="linuxPhone"]) .lyrics-track',
  );
  assert.ok(rule, "Missing phone lyric track layout");

  const declarations = Object.fromEntries(
    rule.nodes.filter((node) => node.type === "decl").map((node) => [node.prop, node.value]),
  );
  assert.equal(declarations.left, "calc(1.5rem + var(--inset-left))");
  assert.equal(declarations.right, "calc(1.5rem + var(--inset-right))");
});

test("phone queue and lyrics remain available on narrow screens", async () => {
  const css = parse(await readFile(new URL("../src/styles/android.css", import.meta.url), "utf8"));
  const prefix = ':is([data-device="android"], [data-device="linuxPhone"])';
  const declarations = (selector) => {
    const rule = css.nodes.find((node) => node.type === "rule" && node.selector === selector);
    assert.ok(rule, `Missing ${selector}`);
    return Object.fromEntries(rule.nodes.filter((node) => node.type === "decl").map((node) => [node.prop, node.value]));
  };
  assert.equal(declarations(`${prefix} .carousel`).visibility, "visible");
  assert.equal(declarations(`${prefix} .carousel`)["pointer-events"], "auto");
  assert.equal(declarations(`${prefix} .lyrics`).display, "block");
  assert.equal(declarations(`${prefix} .lyrics`)["mask-image"], "none");
  assert.equal(declarations(`${prefix} .lyrics[hidden]`).display, "none");
  assert.equal(declarations(`${prefix} .dock-grab[hidden]`).display, "none");
});

test("application and simulator expose the lyrics button as an expandable control", async () => {
  for (const path of ["../index.html", "../dev/phone/app.html"]) {
    const html = await readFile(new URL(path, import.meta.url), "utf8");
    const button = html.match(/<button\b[^>]*\bid="dock-grab"[^>]*>/)?.[0];
    assert.ok(button, `Missing lyrics button in ${path}`);
    assert.match(button, /aria-label="Open lyrics"/);
    assert.match(button, /aria-controls="lyrics-panel"/);
    assert.match(button, /aria-expanded="false"/);
  }
});
