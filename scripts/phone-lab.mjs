#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: node scripts/phone-lab.mjs [--version 0.3.2 | --archive /path/to/Wave_aarch64_musl.tar.gz] [--music /path/to/music]";

export function parseOptions(args) {
  let archive;
  let version;
  let music;
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (!value || value.startsWith("--")) throw new Error(usage);
    if (args[i] === "--archive" && !archive) archive = resolve(value);
    else if (args[i] === "--version" && !version) version = value;
    else if (args[i] === "--music" && !music) music = resolve(value);
    else throw new Error(usage);
    i++;
  }
  if (archive && version) throw new Error("Choose either --archive or --version.");
  if (archive) {
    try {
      if (!statSync(archive).isFile()) throw new Error();
    } catch {
      throw new Error(`Archive not found or not a file: ${archive}`);
    }
  }
  if (music) {
    try {
      if (!statSync(music).isDirectory()) throw new Error();
    } catch {
      throw new Error(`Music directory not found: ${music}`);
    }
  }
  return { archive, version, music };
}

function dockerError(error) {
  if (error.code === "ENOENT") {
    console.error(process.platform === "win32"
      ? "Docker was not found. Install and start Docker Desktop, then restart your terminal."
      : "Docker was not found. Install Docker and start its daemon.");
  } else {
    console.error(`Could not start Docker: ${error.message}`);
  }
}

function docker(arguments_, spawnSyncFn) {
  const result = spawnSyncFn("docker", arguments_, { cwd: root, stdio: "inherit" });
  if (result.error) {
    dockerError(result.error);
    return 1;
  }
  return result.status ?? 1;
}

export async function runLab({ archive, version, music }, {
  spawnSyncFn = spawnSync,
  spawnFn = spawn,
  signals = process,
} = {}) {
  const existing = spawnSyncFn("docker", [
    "inspect", "--format", "{{.Id}} {{.Config.Image}} {{.State.Running}}", "wave-phone-lab",
  ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (existing.error) {
    dockerError(existing.error);
    return 1;
  }
  if (existing.status === 0) {
    const [id, image, running] = existing.stdout.trim().split(/\s+/);
    if (image !== "wave-phone-lab" || running !== "true") {
      console.error("The container name wave-phone-lab is already in use. Remove or rename that container before starting the lab.");
      return 1;
    }
    console.log("The lab is already running. Reconnecting; new options take effect only after restarting.");
    console.log("Open http://127.0.0.1:6080/vnc.html. Press Ctrl+C to stop the lab and remove its temporary library.");
    return superviseDocker(["wait", id], () => stopContainers([id], spawnSyncFn), { spawnFn, signals });
  }

  const status = docker(["build", "--platform", "linux/arm64", "-f", "scripts/phone-lab.Dockerfile", "-t", "wave-phone-lab", "."], spawnSyncFn);
  if (status !== 0) return status;
  const label = `dev.wave.phone-lab.run=${randomUUID()}`;
  const run = ["run", "--rm", "--name", "wave-phone-lab", "--label", label, "--platform", "linux/arm64", "--shm-size", "512m",
    "-p", "127.0.0.1:6080:6080", "-p", "127.0.0.1:6082:6082"];
  if (archive) run.push("--mount", `type=bind,source=${archive},target=/input/wave.tar.gz,readonly`);
  if (music) run.push("--mount", `type=bind,source=${music},target=/music,readonly`);
  if (version) run.push("-e", `WAVE_LAB_VERSION=${version}`);
  console.log("Open http://127.0.0.1:6080/vnc.html after the installation finishes. Press Ctrl+C to stop.");
  console.log("To hear playback, open http://127.0.0.1:6082/stream.mp3 in another tab and press play.");
  console.log("To stop the lab, run: docker stop wave-phone-lab");
  if (music) console.log("The music directory is available at /music in the file picker.");
  const stop = () => {
    const result = spawnSyncFn("docker", ["ps", "-aq", "--filter", `label=${label}`], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0) stopContainers(result.stdout.trim().split(/\s+/).filter(Boolean), spawnSyncFn);
  };
  return superviseDocker([...run, "wave-phone-lab"], stop, { spawnFn, signals, cleanupOnFailure: true });
}

function stopContainers(ids, spawnSyncFn) {
  for (const id of ids) {
    spawnSyncFn("docker", ["stop", id], { cwd: root, stdio: "ignore" });
  }
}

function superviseDocker(arguments_, stop, { spawnFn, signals, cleanupOnFailure = false }) {
  return new Promise((resolve) => {
    const child = spawnFn("docker", arguments_, { cwd: root, stdio: "inherit" });
    let interrupted = false;
    let error;
    const interrupt = () => {
      if (interrupted) return;
      interrupted = true;
      stop();
      child.kill();
    };
    signals.on("SIGINT", interrupt);
    signals.on("SIGTERM", interrupt);
    child.on("error", (caught) => { error = caught; });
    child.on("close", (code, signal) => {
      signals.removeListener("SIGINT", interrupt);
      signals.removeListener("SIGTERM", interrupt);
      if (error) dockerError(error);
      const interruptedChild = signal === "SIGINT" || code === 130 || code === -1073741510 || code === 3221225786;
      if (interrupted || interruptedChild || (cleanupOnFailure && (error || code !== 0 || signal))) stop();
      resolve(interrupted || interruptedChild ? 130 : (code ?? 1));
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runLab(parseOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
