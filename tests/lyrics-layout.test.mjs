import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

const { parse } = createRequire(import.meta.resolve("vite"))("postcss");

test("Android lyric track keeps horizontal spacing and safe-area insets", async () => {
  const css = await readFile(new URL("../src/styles/android.css", import.meta.url), "utf8");
  const rule = parse(css).nodes.find((node) =>
    node.type === "rule" && node.selector === '[data-device="android"] .lyrics-track',
  );
  assert.ok(rule, "Missing Android lyric track layout");

  const declarations = Object.fromEntries(
    rule.nodes.filter((node) => node.type === "decl").map((node) => [node.prop, node.value]),
  );
  assert.equal(declarations.left, "calc(1.5rem + var(--inset-left))");
  assert.equal(declarations.right, "calc(1.5rem + var(--inset-right))");
});
