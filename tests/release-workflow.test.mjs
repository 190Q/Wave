import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const recovery = readFileSync(new URL("../.github/workflows/release-phone.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const phoneTests = readFileSync(new URL("../.github/workflows/linux-phone.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const musl = readFileSync(new URL("../scripts/musl-build.sh", import.meta.url), "utf8");
const runtime = readFileSync(new URL("../scripts/musl-runtime-test.sh", import.meta.url), "utf8");
const linuxConfig = JSON.parse(readFileSync(new URL("../src-tauri/tauri.linux.conf.json", import.meta.url), "utf8"));
const slimConfig = JSON.parse(readFileSync(new URL("../src-tauri/tauri.slim.conf.json", import.meta.url), "utf8"));

test("release builds run after signing checks and publish only after every platform succeeds", () => {
  assert.match(workflow, /Check Android signing[\s\S]*Create the draft release/);
  for (const job of ["build", "musl", "android"]) {
    assert.match(workflow, new RegExp(`^  ${job}:\\n(?:    [^\\n]*\\n)*?    needs: prepare$`, "m"));
  }
  assert.match(workflow, /needs: \[prepare, build, musl, android\]/);
  assert.match(workflow, /node scripts\/release\.mjs finalize "\$RELEASE_TAG"/);
  assert.match(workflow, /node scripts\/release\.mjs slim --reuse-build/);
});

test("Linux RPMs use fast compression and retain the full and slim package contents", () => {
  assert.deepEqual(linuxConfig.bundle.linux.rpm.compression, { type: "zstd", level: 3 });
  for (const tool of ["yt-dlp", "ffmpeg", "ffprobe", "deno"]) {
    assert.equal(linuxConfig.bundle.resources[`tools/${tool}`], `tools/${tool}`);
  }
  assert.equal(slimConfig.bundle.resources, null);
  assert.match(workflow, /name: Verify Linux RPM packages[\s\S]*rpm --checksig "\$full" "\$slim"/);
  assert.match(workflow, /%\{PAYLOADCOMPRESSOR\}/);
});

test("phone tests run manually on ARM Alpine", () => {
  assert.match(phoneTests, /^  workflow_dispatch:/m);
  assert.doesNotMatch(phoneTests, /^  (?:pull_request|push):/m);
  assert.match(phoneTests, /tests\/linux-phone\.test\.mjs/);
  assert.match(phoneTests, /runs-on: ubuntu-22\.04-arm/);
  assert.match(phoneTests, /alpine:3\.22 sh scripts\/musl-build\.sh/);
  assert.match(phoneTests, /alpine:3\.22 sh scripts\/musl-runtime-test\.sh/);
});

test("phone recovery uses tagged application source and current build tooling", () => {
  assert.match(recovery, /ref: \$\{\{ inputs\.tag \}\}/);
  assert.match(recovery, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(recovery, /\.release-tools\/scripts\/musl-build\.sh/);
  assert.match(recovery, /node scripts\/release\.mjs upload-musl "\$RELEASE_TAG"/);
  assert.match(recovery, /node scripts\/release\.mjs organize "\$RELEASE_TAG"/);
  assert.match(musl, /CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS="-C target-feature=-crt-static"/);
  assert.match(musl, /TAURI_CONFIG="\$\(cat src-tauri\/tauri\.phone\.conf\.json\)"/);
  assert.match(musl, /cargo test .*--target aarch64-unknown-linux-musl --lib/);
  assert.match(musl, /\nldd /);
});

test("phone releases verify installation in a clean Alpine environment", () => {
  for (const source of [workflow, recovery]) {
    assert.match(source, /name: Verify the musl installer in a clean Alpine runtime/);
    assert.match(source, /alpine:3\.22 sh scripts\/musl-runtime-test\.sh/);
  }
  assert.match(runtime, /sh install\.sh --version/);
  assert.match(runtime, /ldd "\$HOME\/\.local\/bin\/wave-bin"/);
  assert.match(runtime, /sh install\.sh --uninstall/);
});

test("phone builds restore ownership of cached files after the container exits", () => {
  for (const source of [workflow, recovery]) {
    assert.match(source, /name: Build the musl package[\s\S]*name: Restore musl cache ownership\n        if: always\(\)/);
    assert.match(source, /for path in "\$RUNNER_TEMP\/musl-cargo" src-tauri\/target\/aarch64-unknown-linux-musl/);
    assert.match(source, /sudo chown -R "\$\(id -u\):\$\(id -g\)" "\$path"/);
  }
});
