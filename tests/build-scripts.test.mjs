import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("phone build scripts and window-class checks", (t) => {
  const script = fileURLToPath(new URL("./build-scripts.test.sh", import.meta.url));
  let command = "sh";
  let args = [script];
  if (process.platform === "win32") {
    const path = spawnSync("wsl.exe", ["--exec", "wslpath", "-a", script], { encoding: "utf8", timeout: 15_000 });
    if (path.status !== 0) {
      t.skip("Linux shell unavailable");
      return;
    }
    command = "wsl.exe";
    args = ["--exec", "sh", path.stdout.trim()];
  } else if (process.platform !== "linux") {
    t.skip("Linux shell unavailable");
    return;
  }
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
});

test("release JavaScript scripts parse successfully", () => {
  for (const script of ["release.mjs", "release-assets.mjs", "tools.mjs", "tauri.mjs"]) {
    const result = spawnSync(process.execPath, ["--check", fileURLToPath(new URL(`../scripts/${script}`, import.meta.url))], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

function toolsFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "wave-tools-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  const out = join(root, "src-tauri", "tools");
  mkdirSync(out, { recursive: true });
  copyFileSync(fileURLToPath(new URL("../scripts/tools.mjs", import.meta.url)), join(root, "scripts", "tools.mjs"));
  for (const file of ["ffmpeg", "ffprobe", "deno"]) writeFileSync(join(out, file), file);
  const mock = join(root, "fetch.cjs");
  writeFileSync(mock, `
    const { createHash } = require("node:crypto");
    const payload = Buffer.from("downloaded yt-dlp");
    const hash = createHash("sha256").update(payload).digest("hex");
    globalThis.fetch = async url => {
      if (url.startsWith("https://api.github.com/")) {
        return { ok: true, json: async () => ({
          tag_name: "test-release",
          assets: [
            ...(!process.env.MOCK_MISSING_ASSET ? [{ name: "yt-dlp_linux_aarch64", browser_download_url: "https://example.test/download" }] : []),
            { name: "SHA2-256SUMS", browser_download_url: "https://example.test/checksums" },
          ],
        }) };
      }
      if (url === "https://example.test/download") {
        return { ok: true, arrayBuffer: async () => payload };
      }
      if (url === "https://example.test/checksums") {
        return { ok: true, text: async () => (process.env.MOCK_BAD_HASH ? "0".repeat(64) : hash) + "  yt-dlp_linux_aarch64\\n" };
      }
      throw new Error("Unexpected network request: " + url);
    };
  `);
  const env = { ...process.env, NODE_OPTIONS: `--require "${mock.replaceAll("\\", "/")}"` };
  delete env.GITHUB_TOKEN;
  const run = (args = [], extraEnv = {}) => spawnSync(process.execPath, [
    join(root, "scripts", "tools.mjs"), "--platform", "linux", "--arch", "arm64", ...args,
  ], { cwd: root, env: { ...env, ...extraEnv }, encoding: "utf8" });
  return { out, run };
}

test("download tools are verified, recorded and reused without downloading again", (t) => {
  const { out, run } = toolsFixture(t);
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(join(out, "yt-dlp"), "utf8"), "downloaded yt-dlp");
  const manifest = JSON.parse(readFileSync(join(out, "versions.json"), "utf8"));
  assert.equal(manifest["linux-arm64"]["yt-dlp"].tag, "test-release");
  assert.equal(manifest["linux-arm64"]["yt-dlp"].asset, "yt-dlp_linux_aarch64");
  const cached = run([], { MOCK_MISSING_ASSET: "1" });
  assert.equal(cached.status, 0, cached.stderr);
  assert.match(cached.stdout, /yt-dlp\s+already there/);
});

test("download tools reject missing assets and incorrect checksums", (t) => {
  const { out, run } = toolsFixture(t);
  const missing = run([], { MOCK_MISSING_ASSET: "1" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /has no yt-dlp_linux_aarch64/);
  const badHash = run([], { MOCK_BAD_HASH: "1" });
  assert.notEqual(badHash.status, 0);
  assert.match(badHash.stderr, /does not match SHA2-256SUMS/);
  assert.throws(() => readFileSync(join(out, "yt-dlp")), { code: "ENOENT" });
});

test("download tools reject unsupported options before downloading", (t) => {
  const { run } = toolsFixture(t);
  const result = run(["--arch", "invalid"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--arch takes x64 or arm64/);
});
