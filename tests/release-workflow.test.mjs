import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const recovery = readFileSync(new URL("../.github/workflows/release-phone.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const musl = readFileSync(new URL("../scripts/musl-build.sh", import.meta.url), "utf8");

test("release builds run after signing checks and publish only after every platform succeeds", () => {
  assert.match(workflow, /Check Android signing[\s\S]*Create the draft release/);
  for (const job of ["build", "musl", "android"]) {
    assert.match(workflow, new RegExp(`^  ${job}:\\n(?:    [^\\n]*\\n)*?    needs: prepare$`, "m"));
  }
  assert.match(workflow, /needs: \[prepare, build, musl, android\]/);
  assert.match(workflow, /node scripts\/release\.mjs finalize "\$RELEASE_TAG"/);
  assert.match(workflow, /node scripts\/release\.mjs slim --reuse-build/);
});

test("phone recovery uses tagged application source and current build tooling", () => {
  assert.match(recovery, /ref: \$\{\{ inputs\.tag \}\}/);
  assert.match(recovery, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(recovery, /\.release-tools\/scripts\/musl-build\.sh/);
  assert.match(recovery, /node scripts\/release\.mjs upload-musl "\$RELEASE_TAG"/);
  assert.match(recovery, /node scripts\/release\.mjs organize "\$RELEASE_TAG"/);
  assert.match(musl, /CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS="-C target-feature=-crt-static"/);
  assert.match(musl, /\nldd /);
});
