import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseOptions, runLab } from "../scripts/phone-lab.mjs";

test("phone lab CLI forwards archive options to validation", () => {
  const dir = mkdtempSync(join(tmpdir(), "wave-phone-lab-cli-"));
  try {
    const archive = join(dir, "missing package.tar.gz");
    const script = fileURLToPath(new URL("../scripts/phone-lab.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, "--archive", archive], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Archive not found or not a file:/);
    assert.ok(result.stderr.includes(archive));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("phone lab validates archive and version options", () => {
  const dir = mkdtempSync(join(tmpdir(), "wave-phone-lab-"));
  try {
    const archive = join(dir, "phone package.tar.gz");
    writeFileSync(archive, "archive");
    assert.deepEqual(parseOptions([]), { archive: undefined, version: undefined, music: undefined });
    assert.deepEqual(parseOptions(["--version", "0.3.2"]), { archive: undefined, version: "0.3.2", music: undefined });
    assert.deepEqual(parseOptions(["--archive", archive, "--music", dir]), { archive: resolve(archive), version: undefined, music: resolve(dir) });
    for (const args of [["--version"], ["--archive", "--version"], ["--version", "a", "--version", "b"], ["--bad", "x"]]) {
      assert.throws(() => parseOptions(args), /Usage:/);
    }
    assert.throws(() => parseOptions(["--archive", dir]), /not a file/);
    assert.throws(() => parseOptions(["--music", archive]), /Music directory/);
    assert.throws(() => parseOptions(["--archive", archive, "--version", "0.3.2"]), /either/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function labHarness({ existing, buildStatus = 0, autoClose = true, ownedId = "" } = {}) {
  const calls = [];
  const children = [];
  const signals = new EventEmitter();
  const spawnSyncFn = (command, args, options) => {
    calls.push({ command, args, options, sync: true });
    if (args[0] === "inspect") {
      return existing ? { status: 0, stdout: existing } : { status: 1, stdout: "" };
    }
    if (args[0] === "build") return { status: buildStatus };
    if (args[0] === "ps") return { status: 0, stdout: ownedId };
    return { status: 0, stdout: "" };
  };
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options, sync: false });
    const child = new EventEmitter();
    children.push(child);
    child.kill = () => queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    if (autoClose) queueMicrotask(() => child.emit("close", 0, null));
    return child;
  };
  return { calls, children, signals, spawnSyncFn, spawnFn };
}

test("phone lab builds ARM image and runs the selected release on localhost", async () => {
  const harness = labHarness();
  assert.equal(await runLab({ version: "0.3.2" }, harness), 0);
  const build = harness.calls.find((call) => call.args[0] === "build");
  const run = harness.calls.find((call) => call.args[0] === "run");
  assert.equal(build.command, "docker");
  assert.deepEqual(build.args.slice(0, 3), ["build", "--platform", "linux/arm64"]);
  assert.deepEqual(run.args.slice(0, 4), ["run", "--rm", "--name", "wave-phone-lab"]);
  assert.ok(run.args.includes("127.0.0.1:6080:6080"));
  assert.ok(run.args.includes("127.0.0.1:6082:6082"));
  assert.ok(run.args.includes("WAVE_LAB_VERSION=0.3.2"));
  harness.calls.length = 0;
  assert.equal(await runLab({ archive: "/tmp/package with spaces.tar.gz" }, harness), 0);
  assert.ok(harness.calls.find((call) => call.args[0] === "run").args.includes("type=bind,source=/tmp/package with spaces.tar.gz,target=/input/wave.tar.gz,readonly"));
  harness.calls.length = 0;
  assert.equal(await runLab({ music: "/tmp/music with spaces" }, harness), 0);
  assert.ok(harness.calls.find((call) => call.args[0] === "run").args.includes("type=bind,source=/tmp/music with spaces,target=/music,readonly"));
  assert.equal(await runLab({}, labHarness({ buildStatus: 3 })), 3);
});

test("Ctrl+C stops only the new lab container", async () => {
  const harness = labHarness({ autoClose: false, ownedId: "owned-container\n" });
  const running = runLab({}, harness);
  const args = harness.calls.find((call) => call.args[0] === "run").args;
  const label = args[args.indexOf("--label") + 1];
  harness.signals.emit("SIGINT");
  assert.equal(await running, 130);
  assert.ok(harness.calls.some((call) => call.args.includes(`label=${label}`)));
  assert.ok(harness.calls.some((call) => call.args[0] === "stop" && call.args[1] === "owned-container"));
  assert.equal(harness.signals.listenerCount("SIGINT"), 0);
});

test("phone lab reconnects to an existing lab and Ctrl+C stops that exact container", async () => {
  const harness = labHarness({ existing: "existing-id wave-phone-lab true", autoClose: false });
  const running = runLab({ version: "0.3.2" }, harness);
  assert.ok(harness.calls.some((call) => call.args[0] === "wait" && call.args[1] === "existing-id"));
  assert.ok(!harness.calls.some((call) => call.args[0] === "build"));
  harness.signals.emit("SIGINT");
  assert.equal(await running, 130);
  assert.ok(harness.calls.some((call) => call.args[0] === "stop" && call.args[1] === "existing-id"));
});

test("phone lab cleans up when Windows interrupts Docker first", async () => {
  const harness = labHarness({ existing: "existing-id wave-phone-lab true", autoClose: false });
  const running = runLab({}, harness);
  harness.children[0].emit("close", -1073741510, null);
  assert.equal(await running, 130);
  assert.ok(harness.calls.some((call) => call.args[0] === "stop" && call.args[1] === "existing-id"));
});

test("phone lab does not stop an unrelated container using the lab name", async () => {
  const harness = labHarness({ existing: "other-id other-image true" });
  assert.equal(await runLab({}, harness), 1);
  assert.ok(!harness.calls.some((call) => call.args[0] === "stop"));
});

test("phone lab explains when Docker is missing", async () => {
  const original = console.error;
  const messages = [];
  console.error = (message) => messages.push(message);
  try {
    assert.equal(await runLab({}, { spawnSyncFn: () => ({ error: { code: "ENOENT", message: "not found" } }) }), 1);
    assert.match(messages[0], /Docker was not found/);
    assert.match(messages[0], /Install/);
  } finally {
    console.error = original;
  }
});
