#!/usr/bin/env node
// Runs Wave in a phone-sized window, with the front end told it is on a Linux
// phone, so the phone layout and the MPRIS entry can be looked at without a
// device.
//
//   npm run phone
//
// The window size and the forced device are the ones the aarch64 musl package
// is built with, in src-tauri/tauri.phone.conf.json.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = "src-tauri/tauri.phone.conf.json";

if (!existsSync(join(root, CONFIG))) {
  console.error(`error: ${CONFIG} is missing`);
  process.exit(1);
}

// The remembered window frame wins over the configured size, so a machine that
// has already run Wave at its desk size has to forget it first: shift-clicking
// the close button does that, and the next launch is 360x720.
console.log("Wave in a 360x720 window, as a Linux phone. Ctrl+C to quit.");
console.log("If the window opens at its desk size, shift-click close once, then run this again.");

try {
  execSync(`npx tauri dev --config ${CONFIG}`, { cwd: root, stdio: "inherit" });
} catch (error) {
  process.exit(error.status ?? 1);
}
