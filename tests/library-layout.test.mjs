import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

const { parse } = createRequire(import.meta.resolve("vite"))("postcss");

test("library errors cannot consume the collection list's space", async () => {
  const css = parse(await readFile(new URL("../src/styles/library.css", import.meta.url), "utf8"));
  const footer = css.nodes.find((node) => node.type === "rule" && node.selector === ".sheet-foot");
  assert.ok(footer);
  const declarations = Object.fromEntries(
    footer.nodes.filter((node) => node.type === "decl").map((node) => [node.prop, node.value]),
  );

  assert.equal(declarations["max-height"], "40%");
  assert.equal(declarations["overflow-y"], "auto");
});
