import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "wave-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "scripts"));
  copyFileSync(fileURLToPath(new URL("../scripts/release.mjs", import.meta.url)), join(root, "scripts", "release.mjs"));
  copyFileSync(fileURLToPath(new URL("../scripts/release-assets.mjs", import.meta.url)), join(root, "scripts", "release-assets.mjs"));
  writeFileSync(join(root, "VERSION"), "1.2.3\n");

  const mock = join(bin, "npx.mjs");
  writeFileSync(mock, `
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const args = process.argv.slice(2);
    const type = args.includes("--debug") ? "debug" : "release";
    const dir = join(process.cwd(), "src-tauri", "gen", "android", "app", "build", "outputs", "apk", "universal", type);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(process.cwd(), "arguments.json"), JSON.stringify(args));
    writeFileSync(join(dir, "app-universal-" + type + ".apk"), type);
    writeFileSync(join(dir, "output-metadata.json"), JSON.stringify({
      elements: [{ outputFile: process.env.MOCK_UNSIGNED ? "app-universal-release-unsigned.apk" : "app-universal-" + type + ".apk", versionName: "1.2.3" }]
    }));
  `);
  if (process.platform === "win32") {
    writeFileSync(join(bin, "npx.cmd"), `@"${process.execPath}" "${mock}" %*\r\n`);
  } else {
    const shim = join(bin, "npx");
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${mock}" "$@"\n`);
    chmodSync(shim, 0o755);
  }

  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  delete env.CARGO_TARGET_DIR;
  delete env.MOCK_UNSIGNED;
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, ["scripts/release.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, ...extraEnv },
  });
  return { root, run };
}

test("Android release and debug builds use the expected arguments and filenames", (t) => {
  const { root, run } = fixture(t);
  for (const [args, debug] of [
    [["android"], false],
    [["apk"], false],
    [["android", "debug"], true],
    [["apk", "--debug"], true],
  ]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "arguments.json"), "utf8")),
      ["tauri", "android", "build", "--apk", ...(debug ? ["--debug"] : []), "-t", "aarch64"],
    );
    const name = `Wave_1.2.3_arm64${debug ? "-debug" : ""}.apk`;
    assert.equal(readFileSync(join(root, "src-tauri", "target", "android", name), "utf8"), debug ? "debug" : "release");
  }
});

test("Android builds reject a stale signed APK when Gradle produced an unsigned one", (t) => {
  const { run } = fixture(t);
  const result = run(["android"], { MOCK_UNSIGNED: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /was not signed/);
});

test("local release previews include Android only when requested", (t) => {
  const { run } = fixture(t);
  const withAndroid = run(["publish", "--local", "--android", "--dry-run"]);
  assert.equal(withAndroid.status, 0, withAndroid.stderr);
  assert.match(withAndroid.stdout, /Android APK/);
  const withoutAndroid = run(["publish", "--local", "--dry-run"]);
  assert.equal(withoutAndroid.status, 0, withoutAndroid.stderr);
  assert.doesNotMatch(withoutAndroid.stdout, /Android APK/);
});
