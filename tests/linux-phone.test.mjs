import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("Linux phone installer and launcher", (t) => {
  const script = fileURLToPath(new URL("./linux-phone.test.sh", import.meta.url));
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
