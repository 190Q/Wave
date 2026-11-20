import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assetGroups, downloads, missingAssets } from "../scripts/release-assets.mjs";

test("release downloads list every required asset in platform order", () => {
  const groups = assetGroups("1.2.3");
  assert.deepEqual(groups.map(([name]) => name), [
    "Windows x64",
    "Linux x86_64",
    "Linux ARM64",
    "Linux phones (Alpine / postmarketOS)",
    "Android",
  ]);
  const names = groups.flatMap(([, entries]) => entries.map(([, name]) => name));
  assert.equal(names.length, 18);
  assert.equal(new Set(names).size, 18);
  const body = downloads("1.2.3");
  for (const name of names) assert.ok(body.includes(`/${name})`), name);
  assert.ok(body.indexOf("Windows x64") < body.indexOf("Linux x86_64"));
  assert.ok(body.indexOf("Linux ARM64") < body.indexOf("Linux phones"));
  assert.ok(body.indexOf("Linux phones") < body.indexOf("Android"));
});

test("only nonempty available assets count toward a complete release", () => {
  const names = assetGroups("1.2.3").flatMap(([, entries]) => entries.map(([, name]) => name));
  const assets = names.map((name) => ({ name, size: 10 }));
  assert.deepEqual(missingAssets("1.2.3", assets), []);
  assets[0].size = 0;
  assets[1].state = "starter";
  assets.pop();
  assert.deepEqual(missingAssets("1.2.3", assets), [names[0], names[1], names[names.length - 1]]);
  const body = downloads("1.2.3", assets);
  assert.ok(!body.includes(`/${names[0]})`));
  assert.ok(!body.includes(`/${names[names.length - 1]})`));
  assert.ok(!body.includes(`/${names[1]})`));
  assert.ok(body.includes(`/${names[2]})`));
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "wave-release-bundle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "scripts"));
  for (const file of ["release.mjs", "release-assets.mjs"]) {
    copyFileSync(fileURLToPath(new URL(`../scripts/${file}`, import.meta.url)), join(root, "scripts", file));
  }
  writeFileSync(join(root, "VERSION"), "1.2.3\n");
  const bundle = join(root, "src-tauri", "target", "release", "bundle", "nsis");
  mkdirSync(bundle, { recursive: true });
  const full = join(bundle, "Wave_1.2.3_x64-setup.exe");
  writeFileSync(full, "full");

  const mock = join(bin, "npx.mjs");
  writeFileSync(mock, `
    import { rmSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    writeFileSync(join(process.cwd(), "arguments.json"), JSON.stringify(process.argv.slice(2)));
    if (process.env.MOCK_DELETE_BUNDLE) rmSync(join(process.cwd(), "src-tauri", "target", "release", "bundle", "nsis"), { recursive: true });
    if (process.env.MOCK_BUILD_FAILURE) process.exit(1);
    writeFileSync(join(process.cwd(), "src-tauri", "target", "release", "bundle", "nsis", "Wave_1.2.3_x64-setup.exe"), "slim");
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
  delete env.MOCK_BUILD_FAILURE;
  delete env.MOCK_DELETE_BUNDLE;
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, ["scripts/release.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...env, ...extraEnv },
  });
  return { root, full, bundle, run };
}

test("slim bundling reuses the compiled binary and preserves full installers", (t) => {
  const { root, full, bundle, run } = fixture(t);
  const result = run(["slim", "--reuse-build"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "arguments.json"), "utf8")), [
    "tauri", "bundle", "--config", "src-tauri/tauri.slim.conf.json",
  ]);
  assert.equal(readFileSync(full, "utf8"), "full");
  assert.equal(readFileSync(join(bundle, "Wave_1.2.3_x64-setup-slim.exe"), "utf8"), "slim");
});

test("a failed slim bundle restores existing full installers", (t) => {
  const { full, run } = fixture(t);
  const result = run(["slim", "--reuse-build"], { MOCK_BUILD_FAILURE: "1", MOCK_DELETE_BUNDLE: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(full, "utf8"), "full");
});

test("standalone slim builds still compile when no reusable build is requested", (t) => {
  const { root, run } = fixture(t);
  const result = run(["slim"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(root, "arguments.json"), "utf8"))[1], "build");
});

test("musl releases archive the launcher and the compiled phone executable", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wave-release-musl-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  for (const file of ["release.mjs", "release-assets.mjs", "musl-launcher.sh", "wave-webkit.py"]) {
    copyFileSync(fileURLToPath(new URL(`../scripts/${file}`, import.meta.url)), join(root, "scripts", file));
  }
  copyFileSync(fileURLToPath(new URL("../install.sh", import.meta.url)), join(root, "install.sh"));
  writeFileSync(join(root, "VERSION"), "1.2.3\n");
  const mock = join(root, "mock-build.cjs");
  writeFileSync(mock, `
    const child = require("node:child_process");
    const fs = require("node:fs");
    const path = require("node:path");
    Object.defineProperty(process, "platform", { value: "linux" });
    child.execSync = command => {
      const dir = path.join(process.cwd(), "src-tauri", "target", "aarch64-unknown-linux-musl", "release");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "wave"), "compiled binary");
      fs.writeFileSync(path.join(process.cwd(), "build-command"), command);
    };
    child.execFileSync = (file, args) => {
      if (file !== "tar") throw new Error("unexpected command");
      const stage = args[3];
      fs.writeFileSync(path.join(process.cwd(), "archive.json"), JSON.stringify({
        args, launcher: fs.readFileSync(path.join(stage, "wave"), "utf8"),
        binary: fs.readFileSync(path.join(stage, "wave-bin"), "utf8")
      }));
    };
    require("node:module").syncBuiltinESMExports();
  `);
  const env = { ...process.env, NODE_OPTIONS: `--require "${mock.replaceAll("\\", "/")}"` };
  delete env.CARGO_TARGET_DIR;
  const result = spawnSync(process.execPath, ["scripts/release.mjs", "musl"], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(root, "build-command"), "utf8"), /--target aarch64-unknown-linux-musl --config src-tauri\/tauri\.phone\.conf\.json/);
  const archive = JSON.parse(readFileSync(join(root, "archive.json"), "utf8"));
  assert.deepEqual(archive.args.slice(-5), ["wave", "wave-bin", "wave-webkit.py", "install.sh", "VERSION"]);
  assert.match(archive.args[1], /Wave_1\.2\.3_aarch64_musl\.tar\.gz$/);
  assert.match(archive.launcher, /WAVE_WEBKIT_HELPER_DIR/);
  assert.equal(archive.binary, "compiled binary");
  assert.deepEqual(readdirSync(join(root, "src-tauri", "target", "musl")), []);
});

function releaseFixture(t, release) {
  const root = mkdtempSync(join(tmpdir(), "wave-release-github-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  for (const file of ["release.mjs", "release-assets.mjs"]) {
    copyFileSync(fileURLToPath(new URL(`../scripts/${file}`, import.meta.url)), join(root, "scripts", file));
  }
  writeFileSync(join(root, "VERSION"), "1.2.3\n");
  const mock = join(root, "mock-gh.cjs");
  writeFileSync(mock, `
    const child = require("node:child_process");
    const fs = require("node:fs");
    const original = child.execFileSync;
    child.execFileSync = (file, args, options = {}) => {
      if (file !== "gh") return original(file, args, options);
      if (args[0] === "--version") return "";
      if (args[0] === "run" && args[1] === "list") {
        fs.writeFileSync(process.env.MOCK_OUTPUT, JSON.stringify({ args }));
        return JSON.stringify([{ databaseId: 123 }]);
      }
      if (args[0] === "run" && args[1] === "view") {
        return JSON.stringify({
          url: "https://example.com/run/123",
          status: "in_progress",
          jobs: [{ name: "phone", status: "in_progress", steps: [{ name: "Build", status: "in_progress" }] }],
        });
      }
      const release = JSON.parse(process.env.MOCK_RELEASE);
      if (args[0] === "release" && args[1] === "view") {
        if (!release) throw new Error("release not found");
        return JSON.stringify(release);
      }
      fs.writeFileSync(process.env.MOCK_OUTPUT, JSON.stringify({ args, input: options.input }));
      return "";
    };
    require("node:module").syncBuiltinESMExports();
  `);
  const output = join(root, "gh-output.json");
  const run = (args) => spawnSync(process.execPath, ["scripts/release.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: `--require "${mock.replaceAll("\\", "/")}"`,
      MOCK_RELEASE: JSON.stringify(release),
      MOCK_OUTPUT: output,
    },
  });
  return { output, run };
}

test("preparation creates a draft but leaves an existing release untouched", (t) => {
  const missing = releaseFixture(t, null);
  const created = missing.run(["prepare", "v1.2.3", "--feature", "A feature"]);
  assert.equal(created.status, 0, created.stderr);
  const call = JSON.parse(readFileSync(missing.output, "utf8"));
  assert.ok(call.args.includes("--draft"));
  assert.ok(call.args.includes("--verify-tag"));
  assert.match(call.input, /^## New features\n\n- A feature/);
  assert.match(call.input, /## Downloads/);
  assert.match(call.input, /yt-dlp, FFmpeg, Deno and the YouTube solver/);

  const existing = releaseFixture(t, { isDraft: false });
  const result = existing.run(["prepare", "v1.2.3"]);
  assert.equal(result.status, 0, result.stderr);
  assert.throws(() => readFileSync(existing.output), { code: "ENOENT" });
});

test("finalization refuses an incomplete draft without publishing it", (t) => {
  const { output, run } = releaseFixture(t, { isDraft: true, body: "Notes", assets: [] });
  const result = run(["finalize", "v1.2.3"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing 18 asset/);
  assert.throws(() => readFileSync(output), { code: "ENOENT" });
});

test("phone status selects the recovery workflow and summarizes its active step", (t) => {
  const { output, run } = releaseFixture(t, null);
  const result = run(["runs", "phone"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(readFileSync(output, "utf8")).args.includes("release-phone.yml"));
  assert.match(result.stdout, /in_progress\s+phone: Build/);
});

test("finalization preserves features, replaces old links, and publishes a complete draft", (t) => {
  const assets = assetGroups("1.2.3").flatMap(([, entries]) =>
    entries.map(([, name]) => ({ name, size: 10 })),
  );
  const body = "## New features\n\n- A feature\n\n<!-- wave-downloads:start -->\nOld links\n<!-- wave-downloads:end -->\n\nExisting notes";
  const { output, run } = releaseFixture(t, { isDraft: true, body, assets });
  const result = run(["finalize", "v1.2.3"]);
  assert.equal(result.status, 0, result.stderr);
  const call = JSON.parse(readFileSync(output, "utf8"));
  assert.ok(call.args.includes("--draft=false"));
  assert.match(call.input, /^## New features\n\n- A feature/);
  assert.match(call.input, /## Downloads/);
  assert.match(call.input, /Existing notes/);
  assert.doesNotMatch(call.input, /Old links/);
  assert.equal((call.input.match(/<!-- wave-downloads:start -->/g) ?? []).length, 1);
});
