#!/usr/bin/env node
// Adds Wave's desktop development library options without changing Tauri's
// other commands or arguments.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function selectLibrary(args, npmConfig = {}) {
  if (args[0] !== "dev") return { args: [...args], mode: null };

  const separator = args.indexOf("--");
  const options = separator < 0 ? args : args.slice(0, separator);
  const trailing = separator < 0 ? [] : args.slice(separator);
  const positional = options[1] === "shared" || options[1] === "isolated" ? options[1] : null;
  const shared = positional === "shared" || options.includes("--shared-library") ||
    npmConfig.npm_config_shared_library === "true";
  const isolated = positional === "isolated" || options.includes("--isolated-library") ||
    npmConfig.npm_config_isolated_library === "true";
  if (shared && isolated) {
    throw new Error("Choose either the shared or isolated library, not both.");
  }

  return {
    args: [
      ...options.filter((arg, index) =>
        !(index === 1 && positional) && arg !== "--shared-library" && arg !== "--isolated-library"),
      ...trailing,
    ],
    mode: isolated ? "isolated" : "shared",
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const selected = selectLibrary(process.argv.slice(2), process.env);
    if (selected.mode) {
      process.env.WAVE_DEV_LIBRARY = selected.mode;
      delete process.env.npm_config_shared_library;
      delete process.env.npm_config_isolated_library;
    }
    const cli = createRequire(import.meta.url)("@tauri-apps/cli");
    await cli.run(selected.args, "npm run tauri");
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
