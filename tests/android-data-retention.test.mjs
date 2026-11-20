import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Android offers to keep app data when Wave is uninstalled", () => {
  const manifest = readFileSync(new URL("../src-tauri/gen/android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");
  assert.match(manifest, /<application\b[^>]*\bandroid:hasFragileUserData\s*=\s*["']true["']/);
});
