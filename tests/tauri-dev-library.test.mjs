import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { selectLibrary } from "../scripts/tauri.mjs";

test("desktop development selects a library without passing Wave flags to Tauri", () => {
  assert.deepEqual(selectLibrary(["dev"]), { args: ["dev"], mode: "shared" });
  assert.deepEqual(selectLibrary(["dev", "shared", "--no-watch"]), {
    args: ["dev", "--no-watch"],
    mode: "shared",
  });
  assert.deepEqual(selectLibrary(["dev", "isolated", "--no-watch"]), {
    args: ["dev", "--no-watch"],
    mode: "isolated",
  });
  assert.deepEqual(selectLibrary(["dev", "--shared-library", "--no-watch"]), {
    args: ["dev", "--no-watch"],
    mode: "shared",
  });
  assert.deepEqual(selectLibrary(["dev", "--isolated-library"]), {
    args: ["dev"],
    mode: "isolated",
  });
});

test("npm-consumed library flags still select the requested mode", () => {
  assert.deepEqual(selectLibrary(["dev"], { npm_config_shared_library: "true" }), {
    args: ["dev"],
    mode: "shared",
  });
  assert.deepEqual(selectLibrary(["dev"], { npm_config_isolated_library: "true" }), {
    args: ["dev"],
    mode: "isolated",
  });
  assert.deepEqual(selectLibrary(["dev"], { npm_config_isolated_library: "false" }), {
    args: ["dev"],
    mode: "shared",
  });
  assert.throws(
    () => selectLibrary(["dev", "shared"], { npm_config_isolated_library: "true" }),
    /either the shared or isolated library/,
  );
});

test("library selection preserves other Tauri commands and application arguments", () => {
  assert.deepEqual(selectLibrary(["build", "--debug"]), {
    args: ["build", "--debug"],
    mode: null,
  });
  assert.deepEqual(selectLibrary(["android", "dev"]), {
    args: ["android", "dev"],
    mode: null,
  });
  assert.deepEqual(selectLibrary(["dev", "--", "--shared-library"]), {
    args: ["dev", "--", "--shared-library"],
    mode: "shared",
  });
  assert.deepEqual(selectLibrary(["dev", "--", "isolated"]), {
    args: ["dev", "--", "isolated"],
    mode: "shared",
  });
});

test("conflicting library options are rejected", () => {
  assert.throws(
    () => selectLibrary(["dev", "--shared-library", "--isolated-library"]),
    /either the shared or isolated library/,
  );
  assert.throws(
    () => selectLibrary(["dev", "isolated", "--shared-library"]),
    /either the shared or isolated library/,
  );
});

test("the wrapper forwards Tauri's help and rejects conflicting modes", () => {
  const wrapper = fileURLToPath(new URL("../scripts/tauri.mjs", import.meta.url));
  const help = spawnSync(process.execPath, [wrapper, "dev", "--shared-library", "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:/);

  const conflict = spawnSync(process.execPath, [
    wrapper, "dev", "--shared-library", "--isolated-library",
  ], { encoding: "utf8" });
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /Choose either the shared or isolated library/);
});

test("PowerShell npm commands select the intended library without warnings", {
  skip: process.platform !== "win32",
}, () => {
  const dir = mkdtempSync(join(tmpdir(), "wave-npm-test-"));
  const wrapper = new URL("../scripts/tauri.mjs", import.meta.url).href;
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      private: true,
      scripts: { probe: "node probe.mjs" },
    }));
    writeFileSync(join(dir, "probe.mjs"),
      `import { selectLibrary } from ${JSON.stringify(wrapper)};\n` +
      "console.log(JSON.stringify(selectLibrary(process.argv.slice(2), process.env)));\n");

    for (const [suffix, mode] of [["", "shared"], [" shared", "shared"], [" isolated", "isolated"]]) {
      const result = spawnSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command", `npm run probe dev${suffix}`,
      ], { cwd: dir, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /npm warn Unknown (?:cli|env) config "?(?:--)?(?:shared|isolated)-library/i);
      assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), {
        args: ["dev"], mode,
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
