import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

const { parse } = createRequire(import.meta.resolve("vite"))("postcss");

test("phone panels use the full-screen layout without including confirmations", async () => {
  const css = parse(await readFile(new URL("../src/styles/android.css", import.meta.url), "utf8"));
  const prefix = ':is([data-device="android"], [data-device="linuxPhone"])';
  const rule = css.nodes.find((node) =>
    node.type === "rule" && node.selectors.includes(`${prefix} .theme-dialog`)
      && node.nodes.some((declaration) => declaration.prop === "width" && declaration.value === "100%"),
  );
  assert.ok(rule);
  for (const name of ["settings", "import"]) {
    assert.ok(rule.selectors.includes(`${prefix} .${name}-dialog`));
  }
  for (const name of ["track-editor", "update"]) {
    assert.ok(rule.selectors.includes(`[data-device="linuxPhone"] .${name}-dialog`));
  }
  assert.ok(rule.selectors.every((selector) => !selector.includes(".confirm-dialog")));
  const declarations = Object.fromEntries(rule.nodes.map((node) => [node.prop, node.value]));
  assert.equal(declarations.margin, "0");
  assert.equal(declarations.width, "100%");
  assert.equal(declarations["max-width"], "none");
  assert.equal(declarations["max-height"], "none");
  assert.equal(declarations.padding, "var(--inset-top) var(--inset-right) var(--inset-bottom) var(--inset-left)");
  assert.equal(declarations["border-radius"], "0");

  const openRule = css.nodes.find((node) =>
    node.type === "rule" && node.selectors.includes(`${prefix} .theme-dialog[open]`),
  );
  assert.ok(openRule);
  for (const selector of rule.selectors) {
    assert.ok(openRule.selectors.includes(`${selector}[open]`));
  }
  assert.equal(openRule.nodes.find((node) => node.prop === "height")?.value, "100%");

  const paddingRule = css.nodes.find((node) =>
    node.type === "rule" && node.selectors.includes(`${prefix} .theme-dialog`)
      && node.nodes.some((declaration) => declaration.value?.includes("1.25rem")),
  );
  assert.ok(paddingRule.selectors.includes('[data-device="linuxPhone"] .track-editor-dialog'));
  const padding = paddingRule.nodes.find((node) => node.prop === "padding")?.value;
  for (const edge of ["top", "right", "bottom", "left"]) {
    assert.ok(padding.includes(`var(--inset-${edge})`));
  }
});

test("Linux phone confirmations stay compact and within the safe screen area", async () => {
  const css = parse(await readFile(new URL("../src/styles/android.css", import.meta.url), "utf8"));
  const rule = css.nodes.find((node) =>
    node.type === "rule" && node.selectors.includes('[data-device="linuxPhone"] .confirm-dialog'),
  );
  assert.ok(rule);
  assert.deepEqual(rule.selectors, ['[data-device="linuxPhone"] .confirm-dialog']);
  const declarations = Object.fromEntries(rule.nodes.map((node) => [node.prop, node.value]));
  assert.equal(declarations.inset, "var(--inset-top) var(--inset-right) var(--inset-bottom) var(--inset-left)");
  assert.match(declarations["max-width"], /var\(--inset-left\).*var\(--inset-right\)/);
  assert.match(declarations["max-height"], /var\(--inset-top\).*var\(--inset-bottom\)/);
  assert.equal(declarations["overflow-y"], "auto");
  assert.equal(declarations.width, undefined);
  assert.equal(declarations.height, undefined);
});

test("phone search and equaliser overlays respect the safe area", async () => {
  const css = parse(await readFile(new URL("../src/styles/android.css", import.meta.url), "utf8"));
  const prefix = ':is([data-device="android"], [data-device="linuxPhone"])';
  for (const name of ["search-modal", "eq-panel"]) {
    const rule = css.nodes.find((node) => node.type === "rule" && node.selectors.includes(`${prefix} .${name}`));
    assert.ok(rule);
    assert.ok(rule.nodes.some((node) => node.prop.startsWith("padding") && node.value.includes("var(--")));
  }
});

test("phone equaliser content stays padded while scrolling reaches the safe area edges", async () => {
  const css = parse(await readFile(new URL("../src/styles/android.css", import.meta.url), "utf8"));
  const androidBody = css.nodes.find((node) =>
    node.type === "rule" && node.selectors.includes('[data-device="android"] .eq-body'),
  );
  assert.ok(androidBody);
  assert.equal(androidBody.nodes.find((node) => node.prop === "padding")?.value, "1rem 0 1.25rem");
  const androidSide = css.nodes.find((node) =>
    node.type === "rule" && node.selectors.includes('[data-device="android"] .eq-side'),
  );
  assert.equal(androidSide?.nodes.find((node) => node.prop === "padding")?.value, "0 1.25rem");
  assert.equal(androidSide?.nodes.find((node) => node.prop === "overflow-y")?.value, "auto");

  const eqCss = parse(await readFile(new URL("../src/styles/eq.css", import.meta.url), "utf8"));
  const body = eqCss.nodes.find((node) => node.type === "rule" && node.selectors.includes(".eq-body"));
  assert.equal(body?.nodes.find((node) => node.prop === "padding")?.value, "1rem 1.5rem 1.25rem");
  const narrow = eqCss.nodes.find((node) => node.type === "atrule" && node.params === "(max-width: 56rem)");
  const narrowBody = narrow?.nodes.find((node) => node.type === "rule" && node.selectors.includes(".eq-body"));
  assert.equal(narrowBody?.nodes.find((node) => node.prop === "overflow-y")?.value, "auto");
});

test("phone notices sit below the topbar instead of covering popup buttons", async () => {
  const css = parse(await readFile(new URL("../src/styles/android.css", import.meta.url), "utf8"));
  const prefix = ':is([data-device="android"], [data-device="linuxPhone"])';
  const rule = css.nodes.find((node) =>
    node.type === "rule" && node.selectors.includes(`${prefix} .status`),
  );
  assert.ok(rule);
  assert.ok(rule.selectors.includes(`${prefix} .update-toast`));
  assert.equal(rule.nodes.find((node) => node.prop === "top")?.value, "calc(var(--phone-topbar, 4.5rem) + 0.5rem)");
});
