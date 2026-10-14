#!/usr/bin/env node
// Wave's release tool.
//
//   npm run release -- <command> [options]
//   node scripts/release.mjs <command> [options]
//
// The VERSION file at the repo root is the single source of truth for the
// version number. Every other file that carries a copy is written from it by
// `sync`, so VERSION is the only one to edit by hand.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_FILE = join(root, "VERSION");

/** Every file that carries a copy of the version, and how to find it. */
const TARGETS = [
  {
    file: "package.json",
    // The top-level "version" line; nothing else in the file starts that way.
    source: '^(\\s*"version"\\s*:\\s*")[^"]*(")',
    flags: "m",
  },
  {
    file: "package-lock.json",
    // The root entry and packages[""] both read `"name": "wave", "version": …`.
    source: '("name"\\s*:\\s*"wave"\\s*,\\s*\\r?\\n\\s*"version"\\s*:\\s*")[^"]*(")',
    flags: "g",
  },
  {
    file: "src-tauri/tauri.conf.json",
    source: '^(\\s*"version"\\s*:\\s*")[^"]*(")',
    flags: "m",
  },
  {
    file: "src-tauri/Cargo.toml",
    // The [package] version is the only line that begins with `version = `.
    source: '^(version\\s*=\\s*")[^"]*(")',
    flags: "m",
  },
  {
    file: "src-tauri/Cargo.lock",
    source: '(name = "wave"\\r?\\nversion = ")[^"]*(")',
    flags: "",
  },
];

const BUNDLE_DIR = join(root, "src-tauri", "target", "release", "bundle");
const WORKFLOW = join(root, ".github", "workflows", "release.yml");

// ---------------------------------------------------------------- output ----

const say = (message = "") => console.log(message);
const warn = (message) => console.error(`warning: ${message}`);
const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};

// ----------------------------------------------------------------- shell ----

function run(file, args, { capture = false } = {}) {
  try {
    return execFileSync(file, args, {
      cwd: root,
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
  } catch (error) {
    if (capture) fail(error.stderr?.trim() || `${file} ${args.join(" ")} failed`);
    fail(`${file} ${args.join(" ")} failed`);
  }
}

const git = (args, options) => run("git", args, options);
const gh = (args, options) => run("gh", args, options);

/** For the local CLIs, which are `.cmd` shims on Windows. */
function shell(command, { capture = false } = {}) {
  return execSync(command, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function haveGh() {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------- version ----

function readVersion() {
  if (!existsSync(VERSION_FILE)) fail("there is no VERSION file");
  const version = readFileSync(VERSION_FILE, "utf8").trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) fail(`VERSION holds "${version}", which is not a version`);
  return version;
}

/** Every version found in one target, in file order. */
function versionsIn(target) {
  const path = join(root, target.file);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const pattern = new RegExp(target.source, target.flags.includes("g") ? target.flags : `${target.flags}g`);

  const found = [];
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    // Group 1 is the text before the number and group 2 the text after it.
    found.push(match[0].slice(match[1].length, match[0].length - match[2].length));
  }
  return found;
}

function writeVersion(target, version) {
  const path = join(root, target.file);
  if (!existsSync(path)) {
    warn(`${target.file} is missing, skipped`);
    return false;
  }
  const text = readFileSync(path, "utf8");
  const pattern = new RegExp(target.source, target.flags.includes("g") ? target.flags : `${target.flags}g`);

  let changed = false;
  const next = text.replace(pattern, (_match, prefix, suffix) => {
    changed = true;
    return prefix + version + suffix;
  });
  if (changed) writeFileSync(path, next);
  return changed;
}

/** The targets whose copies do not read `version`. */
function drift(version) {
  const wrong = [];
  for (const target of TARGETS) {
    const found = versionsIn(target);
    if (found.length === 0) wrong.push({ file: target.file, found: "not found" });
    else if (found.some((value) => value !== version)) wrong.push({ file: target.file, found: found.join(", ") });
  }
  return wrong;
}

// -------------------------------------------------------------- commands ----

function commandStatus() {
  const version = readVersion();
  const wrong = drift(version);

  say(`VERSION  ${version}`);
  for (const target of TARGETS) {
    const found = versionsIn(target);
    const mark = found.length > 0 && found.every((value) => value === version) ? "ok" : "out of step";
    say(`  ${mark.padEnd(12)} ${target.file}${found.length ? ` (${found.join(", ")})` : ""}`);
  }

  if (wrong.length > 0) {
    say("");
    say("Run `npm run release -- sync` to bring them back into step.");
    process.exitCode = 1;
  }
}

function commandSync() {
  const version = readVersion();
  for (const target of TARGETS) {
    const changed = writeVersion(target, version);
    say(`  ${changed ? "wrote" : "already"}  ${target.file}`);
  }
  say(`\nEverything now reads ${version}.`);
}

function commandBump(part) {
  if (!part) fail("bump needs a part: major, minor, patch, or an exact version");

  const current = readVersion();
  let next;

  if (/^\d+\.\d+\.\d+/.test(part)) {
    next = part;
  } else if (["major", "minor", "patch"].includes(part)) {
    const [major, minor, patch] = current.split(".").map(Number);
    next =
      part === "major"
        ? `${major + 1}.0.0`
        : part === "minor"
          ? `${major}.${minor + 1}.0`
          : `${major}.${minor}.${patch + 1}`;
  } else {
    fail(`"${part}" is not a part or a version`);
  }

  writeFileSync(VERSION_FILE, `${next}\n`);
  say(`${current} -> ${next}\n`);
  commandSync();
}

function requireGh() {
  if (!haveGh()) fail("the GitHub CLI (gh) is needed for this, and is not on PATH");
}

function commandList() {
  requireGh();
  gh(["release", "list", "--limit", "100"]);
}

function commandView(tag) {
  if (!tag) fail("view needs a tag");
  requireGh();
  gh(["release", "view", tag]);
}

function commandOpen(tag) {
  if (!tag) fail("open needs a tag");
  requireGh();
  gh(["release", "view", tag, "--web"]);
}

function commandAssets(tag) {
  if (!tag) fail("assets needs a tag");
  requireGh();
  const release = JSON.parse(gh(["release", "view", tag, "--json", "assets"], { capture: true }));
  if (release.assets.length === 0) {
    say(`${tag} has no assets.`);
    return;
  }
  for (const asset of release.assets) {
    const size = (asset.size / 1024 / 1024).toFixed(1);
    say(`  ${asset.name}  (${size} MB)`);
  }
}

function commandUpload(tag, files) {
  if (!tag) fail("upload needs a tag");
  if (files.length === 0) fail("upload needs at least one file");
  requireGh();
  gh(["release", "upload", tag, ...files, "--clobber"]);
}

function commandRemoveAsset(tag, names) {
  if (!tag) fail("rm-asset needs a tag");
  if (names.length === 0) fail("rm-asset needs at least one asset name");
  requireGh();
  for (const name of names) gh(["release", "delete-asset", tag, name, "--yes"]);
}

function commandDelete(tag, options) {
  if (!tag) fail("delete needs a tag");
  if (!options.yes) fail(`this deletes the ${tag} release; add --yes to go ahead`);
  requireGh();
  const args = ["release", "delete", tag, "--yes"];
  if (options.tag) args.push("--cleanup-tag");
  gh(args);
  say(`Deleted ${tag}${options.tag ? " and its git tag" : ""}.`);
}

function commandEdit(tag, options) {
  if (!tag) fail("edit needs a tag");
  requireGh();
  const args = ["release", "edit", tag];
  if (options.title) args.push("--title", options.title);
  if (options.notes) args.push("--notes", options.notes);
  if (options.draft) args.push("--draft");
  if (options.publish) args.push("--draft=false");
  if (args.length === 3) fail("edit needs at least one of --title, --notes, --draft or --publish");
  gh(args);
}

/** Every installer the local build produced. */
function localAssets() {
  if (!existsSync(BUNDLE_DIR)) return [];
  const found = [];
  const wanted = [".exe", ".msi", ".deb", ".rpm", ".AppImage"];

  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (wanted.some((extension) => entry.endsWith(extension))) found.push(path);
    }
  };
  walk(BUNDLE_DIR);
  return found;
}

function releaseExists(tag) {
  try {
    execFileSync("gh", ["release", "view", tag], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function commandPublish(options) {
  const version = readVersion();
  const tag = `v${version}`;
  const plan = [];

  plan.push(`sync VERSION (${version}) into ${TARGETS.length} files`);
  plan.push(`commit any outstanding changes as "Release ${tag}"`);
  plan.push(`tag ${tag} and push it with the branch`);
  if (options.noPublish) plan.push("stop there");
  else if (options.local || !existsSync(WORKFLOW)) plan.push("build the installers here and publish the release from them");
  else plan.push("let CI build both platforms and publish the release");

  say(`Publishing ${tag}\n`);
  for (const step of plan) say(`  - ${step}`);
  say("");

  if (options.dryRun) {
    say("Dry run, so nothing was changed.");
    return;
  }

  // The tag must be free before anything is committed.
  const existing = git(["tag", "--list", tag], { capture: true }).trim();
  if (existing) fail(`${tag} already exists; bump the version first`);
  if (options.local && !existsSync(WORKFLOW)) say("No CI workflow, so the installers are built here.");

  commandSync();

  const dirty = git(["status", "--porcelain"], { capture: true }).trim();
  if (dirty) {
    git(["add", "-A"]);
    git(["commit", "-m", `Release ${tag}`]);
  } else {
    say("Nothing to commit.");
  }

  git(["tag", tag]);
  git(["push", "origin", "HEAD"]);
  git(["push", "origin", tag]);
  say(`\nPushed ${tag}.`);

  if (options.noPublish) return;

  if (!options.local && existsSync(WORKFLOW)) {
    say("CI is building the installers; watch it with `gh run list`.");
    say("The release appears when the build finishes.");
    return;
  }

  shell("npx tauri build --bundles all");

  const assets = localAssets();
  if (assets.length === 0) fail("the build produced no installers to upload");
  say(`\nUploading ${assets.length} installer(s).`);

  requireGh();
  const notes = options.notes ? ["--notes", options.notes] : ["--generate-notes"];

  if (releaseExists(tag)) {
    gh(["release", "upload", tag, ...assets, "--clobber"]);
  } else {
    const draft = options.draft ? ["--draft"] : [];
    gh(["release", "create", tag, ...assets, "--title", `Wave ${version}`, ...notes, ...draft]);
  }

  say(`\n${tag} is published.`);
}

// ------------------------------------------------------------------ args ----

function parse(argv) {
  const options = { rest: [], files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = (name) => {
      if (index + 1 >= argv.length) fail(`${name} needs a value`);
      index += 1;
      return argv[index];
    };
    switch (arg) {
      case "--draft": options.draft = true; break;
      case "--publish": options.publish = true; break;
      case "--local": options.local = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "--yes": options.yes = true; break;
      case "--no-publish": options.noPublish = true; break;
      case "--tag": options.tag = true; break;
      case "--title": options.title = value("--title"); break;
      case "--notes": options.notes = value("--notes"); break;
      default:
        if (arg.startsWith("--")) fail(`unknown option ${arg}`);
        options.rest.push(arg);
    }
  }
  return options;
}

const USAGE = `
Wave's release tool. VERSION at the repo root is the single source of truth.

  npm run release -- <command> [options]

Version
  status                          Show VERSION and whether every copy agrees
  sync                            Write VERSION into every file that carries it
  bump <major|minor|patch|x.y.z>  Change VERSION, then sync

Releases
  list                            List every release
  view <tag>                      Show one release
  assets <tag>                    List a release's assets
  publish [options]               Sync, commit, tag, push, and publish
  upload <tag> <file...>          Add assets to a release
  rm-asset <tag> <name...>        Remove assets from a release
  edit <tag> [options]            Change a release's title, notes or draft state
  delete <tag> --yes [--tag]      Delete a release, and its git tag with --tag
  open <tag>                      Open a release in the browser

publish options
  --draft        Create it as a draft
  --notes <text> Release notes (default: generated from the commits)
  --local        Build the installers here instead of waiting for CI
  --no-publish   Stop after pushing the tag
  --dry-run      Print the plan and change nothing

edit options
  --title <text>   --notes <text>   --draft   --publish
`.trim();

function main() {
  const [command, ...argv] = process.argv.slice(2);
  const options = parse(argv);
  const [first, ...more] = options.rest;

  switch (command) {
    case "status":
    case "check": return commandStatus();
    case "sync": return commandSync();
    case "bump": return commandBump(first);
    case "list": return commandList();
    case "view": return commandView(first);
    case "open": return commandOpen(first);
    case "assets": return commandAssets(first);
    case "upload": return commandUpload(first, more);
    case "rm-asset": return commandRemoveAsset(first, more);
    case "delete": return commandDelete(first, options);
    case "edit": return commandEdit(first, options);
    case "publish": return commandPublish(options);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      say(USAGE);
      return;
    default:
      fail(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main();
