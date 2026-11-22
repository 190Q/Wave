#!/usr/bin/env node
// Wave's release tool.
//
//   node scripts/release.mjs <command> [options]
//
// The VERSION file at the repo root is the single source of truth for the
// version number. Every other file that carries a copy is written from it by
// `sync`, so VERSION is the only one to edit by hand.
import { execFileSync, execSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloads, missingAssets } from "./release-assets.mjs";

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

const TARGET_DIR = process.env.CARGO_TARGET_DIR
  ? resolve(process.env.CARGO_TARGET_DIR)
  : join(root, "src-tauri", "target");

const BUNDLE_DIR = join(TARGET_DIR, "release", "bundle");
const WORKFLOW = join(root, ".github", "workflows", "release.yml");

// Passed to the CLI, which reads it from the repo root.
const SLIM_CONFIG = "src-tauri/tauri.slim.conf.json";
// The phone config uses a phone-sized window and Alpine's native download tools.
const PHONE_CONFIG = "src-tauri/tauri.phone.conf.json";

// What a slim installer is called, so the two builds of a version cannot be
// mistaken for one another.
const SLIM_SUFFIX = "-slim";

// The musl package: the target it is built for, the binary Cargo.toml names,
// and where the tarball lands. It is kept out of the bundle directory, so the
// Linux installers a release carries cannot pick it up as one of their own.
const MUSL_TARGET = "aarch64-unknown-linux-musl";
const BINARY = "wave";
const MUSL_DIR = join(TARGET_DIR, "musl");

const ANDROID_DIR = join(TARGET_DIR, "android");
const APK_OUTPUT_DIR = join(
  root,
  "src-tauri",
  "gen",
  "android",
  "app",
  "build",
  "outputs",
  "apk",
  "universal",
);


const say = (message = "") => console.log(message);
const warn = (message) => console.error(`warning: ${message}`);
const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};

function run(file, args, { capture = false, input } = {}) {
  // A command that reads stdin has to be handed a pipe for it.
  const stdio = capture
    ? ["ignore", "pipe", "pipe"]
    : input === undefined
      ? "inherit"
      : ["pipe", "inherit", "inherit"];

  try {
    return execFileSync(file, args, {
      cwd: root,
      encoding: "utf8",
      input,
      stdio,
    });
  } catch (error) {
    if (capture) fail(error.stderr?.trim() || `${file} ${args.join(" ")} failed`);
    fail(`${file} ${args.join(" ")} failed`);
  }
}

function commandRuns(id) {
  requireGh();
  if (!id || id === "phone") {
    const workflow = id === "phone" ? "release-phone.yml" : "release.yml";
    const runs = JSON.parse(gh(["run", "list", "--workflow", workflow, "--limit", "1", "--json", "databaseId"], { capture: true }));
    if (runs.length === 0) fail(`there are no runs of ${workflow}`);
    id = String(runs[0].databaseId);
  }
  const run = JSON.parse(gh(["run", "view", id, "--json", "status,conclusion,url,jobs"], { capture: true }));
  say(`${run.url}  ${run.conclusion || run.status}`);
  for (const job of run.jobs) {
    const step = job.steps?.find((item) => item.status === "in_progress")
      ?? job.steps?.find((item) => item.conclusion === "failure");
    say(`  ${(job.conclusion || job.status).padEnd(12)} ${job.name}${step ? `: ${step.name}` : ""}`);
  }
}

function releaseForTag(tag) {
  if (!tag) fail("a release tag is required");
  const version = readVersion();
  if (tag !== `v${version}`) fail(`${tag} does not match VERSION ${version}`);
  requireGh();
  return version;
}

function commandPrepare(tag, options) {
  releaseForTag(tag);
  if (releaseExists(tag)) {
    say(`${tag} already has a release; leaving its publication state unchanged.`);
    return;
  }
  gh(["release", "create", tag, "--verify-tag", "--draft", "--title", `Wave ${tag}`, "--notes-file", "-"], {
    input: releaseBody(options.features),
  });
}

function commandOrganize(tag, finalize = false) {
  const version = releaseForTag(tag);
  const release = JSON.parse(gh(["release", "view", tag, "--json", "assets,body,isDraft"], { capture: true }));
  if (finalize) {
    const missing = missingAssets(version, release.assets);
    if (missing.length > 0) fail(`the release is missing ${missing.length} asset(s):\n  ${missing.join("\n  ")}`);
  }
  const args = ["release", "edit", tag, "--notes-file", "-"];
  if (finalize && release.isDraft) args.push("--draft=false");
  gh(args, { input: withDownloads(release.body ?? "", version, release.assets) });
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

function readVersion() {
  if (!existsSync(VERSION_FILE)) fail("there is no VERSION file");
  const version = readFileSync(VERSION_FILE, "utf8").trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) fail(`VERSION holds "${version}", which is not a version`);
  return version;
}

/** The parts a version can be bumped by, and what each is usually for. */
const PARTS = ["patch", "minor", "major"];

/** The version that follows `current` when `part` is bumped. */
function bumped(current, part) {
  const [major, minor, patch] = current.split(".").map(Number);
  if (part === "major") return `${major + 1}.0.0`;
  if (part === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
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

/**
 * The body every release carries, under the feature list. It lives here rather
 * than in the workflow so a build made on this machine and one made by CI read
 * the same.
 */
const BODY = [
  "Installers for Windows, Linux and Android.",
  "",
  "Every installer comes in two builds. The plain one ships yt-dlp, ffmpeg,",
  "ffprobe and Deno, so downloading a link works on a fresh install. The",
  "`-slim` one leaves all four out and weighs a few megabytes, for when you",
  "already have your own copies on PATH.",
  "",
  "**Linux, one line:**",
  "",
  "```sh",
  "curl -fsSL https://raw.githubusercontent.com/190Q/Wave/main/install.sh | sh",
  "```",
  "",
  "**Windows, from PowerShell:**",
  "",
  "```powershell",
  "irm https://raw.githubusercontent.com/190Q/Wave/main/install.ps1 | iex",
  "```",
  "",
  "Linux builds target glibc 2.35 or newer (Ubuntu 22.04+, Debian 12+,",
  "Fedora 36+) and come for x86_64 and aarch64. postmarketOS and Alpine are",
  "musl, where the glibc packages cannot run, so they get an aarch64 tarball",
  "of their own. Its installer offers to install Alpine packages for WebKitGTK,",
  "runtime dependencies, yt-dlp, FFmpeg, Deno and the YouTube solver, or lists",
  "them for manual installation.",
  "",
  "The Android APK is for a phone. Install it once by hand, and Wave offers each",
  "later release in **Settings → Updates**: it downloads the APK and hands it to",
  "the system installer, which asks you to confirm. Nothing goes through a store.",
].join("\n");

/**
 * The heading the feature list is written under, and the section it owns. An
 * edit replaces the whole section, so listing again corrects the list rather
 * than stacking a second copy on top of the first.
 */
const FEATURES_SECTION = /^## New features[^\n]*\n\n?(?:- [^\n]*\n?)*/m;

/** One line per feature; a value holding newlines gives one line each. */
function featureLines(features) {
  return features
    .flatMap((feature) => feature.split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The `## New features` section, or nothing when there is nothing to list. */
function featuresBlock(features) {
  const lines = featureLines(features);
  if (lines.length === 0) return "";
  return `## New features\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`;
}

/** A body with the feature list above it, replacing any list already there. */
function withFeatures(body, features) {
  if (features.length === 0) return body;
  const rest = body.replace(FEATURES_SECTION, "").replace(/^\n+/, "");
  return `${featuresBlock(features)}\n${rest}`;
}

/** The body a release is given: the feature list, then the installers blurb. */
function releaseBody(features, assets) {
  return withFeatures(withDownloads(BODY, readVersion(), assets), features);
}

function withDownloads(body, version, assets) {
  const withoutDownloads = body
    .replace(/<!-- wave-downloads:start -->[\s\S]*?<!-- wave-downloads:end -->\n*/g, "")
    .trimStart();
  const section = downloads(version, assets);
  const features = withoutDownloads.match(FEATURES_SECTION);
  if (!features) return `${section}\n\n${withoutDownloads}`;
  const end = features.index + features[0].length;
  return `${withoutDownloads.slice(0, end).trimEnd()}\n\n${section}\n\n${withoutDownloads.slice(end).trimStart()}`;
}

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
  } else if (PARTS.includes(part)) {
    next = bumped(current, part);
  } else {
    fail(`"${part}" is not a part or a version`);
  }

  writeFileSync(VERSION_FILE, `${next}\n`);
  say(`${current} -> ${next}\n`);
  commandSync();
}

/** Prints the body a release is given, which is what the workflow hands CI. */
function commandBody(options) {
  say(releaseBody(options.features));
}

/** Whether a tag is already in this repo. */
function tagged(tag) {
  return git(["tag", "--list", tag], { capture: true }).trim() !== "";
}

/**
 * The steps for cutting a release, worked out from the tree as it stands. It
 * reads VERSION and git only, so it needs no network and no gh.
 */
function commandGuide(part) {
  const version = readVersion();
  const kind = part ?? "patch";

  let next;
  if (/^\d+\.\d+\.\d+/.test(kind)) next = kind;
  else if (PARTS.includes(kind)) next = bumped(version, kind);
  else fail(`"${kind}" is not a part or a version; guide takes patch, minor, major, or x.y.z`);

  const versionTag = `v${version}`;
  const released = tagged(versionTag);
  const cutting = !released && !part ? version : next;
  const cuttingTag = `v${cutting}`;
  const dirty = git(["status", "--porcelain"], { capture: true }).trim() !== "";
  const wrong = drift(version);
  const ci = existsSync(WORKFLOW);
  const rest = PARTS.filter((candidate) => candidate !== kind)
    .map((candidate) => `${candidate} gives ${bumped(version, candidate)}`);
  const others = rest.length > 1 ? `${rest.slice(0, -1).join(", ")} and ${rest[rest.length - 1]}` : rest[0];

  const state = tagged(cuttingTag)
    ? `${cuttingTag} is already tagged, so pick another version`
    : released
      ? `${versionTag} is released, so ${cuttingTag} is the next one`
      : `${versionTag} is free, so ${version} is still to go out`;

  say(`Wave release guide, cutting ${cuttingTag}`);
  say("");
  say(`  VERSION  ${version}`);
  say(`  copies   ${wrong.length === 0 ? "every copy agrees" : `${wrong.length} out of step, which the bump writes`}`);
  say(`  tree     ${dirty ? "has uncommitted changes, which publish commits as the release" : "is clean"}`);
  say(`  tag      ${state}`);
  say("");
  say("Steps");
  say("");
  if (cutting === version) {
    say("  1. Bump the version, unless you meant a different one");
    say(`       npm run release -- bump patch        ${version} -> ${bumped(version, "patch")}`);
    say(`     ${versionTag} is not tagged, so ${version} is the version to publish as it`);
    say("     stands, and this step can be skipped.");
  } else {
    say("  1. Bump the version");
    say(`       npm run release -- bump ${PARTS.includes(kind) ? kind : cutting}`);
    say(`     ${version} -> ${cutting}. VERSION is the single source of truth, and this writes it`);
    say("     into every file that carries a copy: package.json, package-lock.json,");
    say("     src-tauri/tauri.conf.json, src-tauri/Cargo.toml and src-tauri/Cargo.lock.");
    say("     patch is for fixes, minor for new features and major for a change that");
    say("     breaks an older install.");
    say(`     From here, ${others}.`);
    if (PARTS.includes(kind)) {
      say("     A version can also be named instead:");
      say(`       npm run release -- bump ${cutting}`);
    }
  }
  say("");
  say("  2. Check that every copy agrees");
  say("       npm run release -- status");
  say("     Lists every file that carries a copy of VERSION and whether it matches.");
  say("");
  say("  3. Publish");
  say('       node scripts/release.mjs publish --feature "Added a queue" --feature "Fixed a bug"');
  say("     This is the one step that cannot go through npm, which takes any option");
  say("     for itself and drops it before the script sees it. It syncs VERSION,");
  say(`     commits everything outstanding as "Release ${cuttingTag}", tags ${cuttingTag}, and`);
  say("     pushes the branch and the tag.");
  if (ci) {
    say("     It then dispatches the release workflow, which builds Windows and Linux");
    say("     for x86_64 and aarch64, adds the aarch64 musl package and the Android");
    say("     APK, and publishes every build with the release.");
  } else {
    say("     It then builds both installers here and publishes the release from them.");
  }
  say("     Every --feature becomes one line of a New features list at the top of the");
  say("     release body, and the flag repeats. Leave it off when nothing is new.");
  say("     It commits the whole working tree, so put that in the state you want");
  say(`     first, and it stops if ${cuttingTag} is already tagged.`);
  say("     To see the plan and change nothing:");
  say("       node scripts/release.mjs publish --dry-run");
  say("");
  if (ci) {
    say("  4. Watch the build");
    say("       node scripts/release.mjs runs");
    say("     The release appears once all platforms have finished.");
    say("");
  }
  if (kind === "major") {
    say("A major release");
    say("  The steps are the same, and the notes are what change. A major version reads as a");
    say("  break, so give --feature a line for everything people will notice, and say plainly");
    say("  what an older install loses or has to do differently.");
    say("");
  }
  say("Other things worth knowing");
  say("  The Android job signs the APK with the keystore held as the ANDROID_KEYSTORE");
  say("  secret, base64 encoded, so an update installs over the copy on the phone.");
  for (const [command, description] of [
    ["publish --dry-run", "print the plan and change nothing"],
    ["publish --no-publish", "stop after pushing the tag"],
    ["publish --local", "build both installers here instead of in CI"],
    [`edit ${cuttingTag} --feature`, "change the list on a release that is already out"],
    [`assets ${cuttingTag}`, "list what a release carries"],
  ]) {
    say(`  ${`node scripts/release.mjs ${command}`.padEnd(48)}${description}`);
  }
  say(`  ${"npm run release -- help".padEnd(48)}every command and option`);
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
  if (options.draft) args.push("--draft");
  if (options.publish) args.push("--draft=false");

  let body = null;
  if (options.features.length > 0) {
    // The list goes above whatever the release already says, so the installers
    // blurb the build wrote is kept.
    body = withFeatures(options.notes ?? releaseBodyOf(tag), options.features);
  } else if (options.notes) {
    body = options.notes;
  }

  if (args.length === 3 && body === null) {
    fail("edit needs at least one of --title, --notes, --feature, --draft or --publish");
  }

  if (body !== null) args.push("--notes-file", "-");
  gh(args, body === null ? undefined : { input: body });
}

/** Every installer the local build produced for `version`. */
function localAssets(version) {
  if (!existsSync(BUNDLE_DIR)) return [];
  const found = [];
  const wanted = [".exe", ".msi", ".deb", ".rpm", ".AppImage"];

  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (wanted.some((extension) => entry.endsWith(extension))) {
        // A folder holding several versions keeps the installers of each, and
        // only this version's are the ones being published.
        if (entry.includes(version)) found.push(path);
      }
    }
  };
  walk(BUNDLE_DIR);
  return found;
}

/** Where a slim installer lands, beside the full one it matches. */
function slimName(path) {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return join(dirname(path), `${name.slice(0, dot)}${SLIM_SUFFIX}${name.slice(dot)}`);
}

/** The installers a build rewrote, which is what that build just produced. */
function freshAssets(version, build) {
  const before = new Map(
    localAssets(version).map((path) => [path, statSync(path).mtimeMs]),
  );

  build();

  return localAssets(version).filter(
    (path) => before.get(path) !== statSync(path).mtimeMs,
  );
}

/** The slim installers a local build produced. */
function slimAssets() {
  return localAssets(readVersion()).filter((path) =>
    basename(path).includes(SLIM_SUFFIX),
  );
}

/**
 * Builds the slim installers, which leave out the download tools, and renames
 * them so they sit beside the full ones rather than over the top of them.
 */
function commandSlim(reuseBuild = false) {
  const version = readVersion();
  const full = localAssets(version).filter((path) => !basename(path).includes(SLIM_SUFFIX));
  mkdirSync(TARGET_DIR, { recursive: true });
  const staging = mkdtempSync(join(TARGET_DIR, "wave-full-"));
  const saved = [];
  try {
    for (const [index, path] of full.entries()) {
      const backup = join(staging, String(index));
      renameSync(path, backup);
      saved.push({ path, backup });
    }
    const command = reuseBuild ? "bundle" : "build";
    const produced = freshAssets(version, () =>
      shell(`npx tauri ${command} --config ${SLIM_CONFIG}`),
    );
    if (produced.length === 0) throw new Error("the slim build produced no installers");
    for (const path of produced) renameSync(path, slimName(path));
    say(`\nRenamed ${produced.length} slim installer(s).`);
  } finally {
    for (const { path, backup } of saved) {
      mkdirSync(dirname(path), { recursive: true });
      renameSync(backup, path);
    }
    rmSync(staging, { recursive: true, force: true });
  }
}

function commandUploadSlim(tag) {
  if (!tag) fail("upload-slim needs a tag");

  const files = slimAssets();
  if (files.length === 0) fail("there are no slim installers built for this version");

  requireGh();
  gh(["release", "upload", tag, ...files, "--clobber"]);
}

/** What the musl package is called, target and all, so it cannot be taken for
 * a glibc installer. */
function muslName(version) {
  return `Wave_${version}_aarch64_musl.tar.gz`;
}

/**
 * Builds the aarch64 musl package, which postmarketOS and Alpine can run where
 * the glibc installers cannot.
 *
 * There is no bundle, so nothing is named for an architecture by tauri and the
 * tarball is named here instead. The installer supplies Alpine's download tools.
 * It has to run on Linux inside Alpine, which is what the release workflow
 * puts it in; nothing else has the musl toolchain.
 */
function commandMusl() {
  if (process.platform !== "linux") fail("the musl package has to be built on Linux");

  const version = readVersion();
  shell(`npx tauri build --no-bundle --target ${MUSL_TARGET} --config ${PHONE_CONFIG}`);

  const binary = join(TARGET_DIR, MUSL_TARGET, "release", BINARY);
  if (!existsSync(binary)) fail(`the musl build produced no ${BINARY}`);

  mkdirSync(MUSL_DIR, { recursive: true });
  const archive = join(MUSL_DIR, muslName(version));
  const staging = mkdtempSync(join(MUSL_DIR, "wave-phone-"));
  try {
    copyFileSync(binary, join(staging, "wave-bin"));
    copyFileSync(join(root, "scripts", "musl-launcher.sh"), join(staging, "wave"));
    copyFileSync(join(root, "scripts", "wave-webkit.py"), join(staging, "wave-webkit.py"));
    copyFileSync(join(root, "install.sh"), join(staging, "install.sh"));
    copyFileSync(VERSION_FILE, join(staging, "VERSION"));
    chmodSync(join(staging, "wave"), 0o755);
    chmodSync(join(staging, "wave-bin"), 0o755);
    run("tar", ["-czf", archive, "-C", staging, "wave", "wave-bin", "wave-webkit.py", "install.sh", "VERSION"]);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  say(`\nWrote ${archive}`);
}

/** The musl package built for this version, if it is there. */
function muslPackage() {
  const path = join(MUSL_DIR, muslName(readVersion()));
  return existsSync(path) ? path : null;
}

function commandUploadMusl(tag) {
  if (!tag) fail("upload-musl needs a tag");

  const path = muslPackage();
  if (!path) {
    fail(`there is no musl package for ${readVersion()}; build one with \`node scripts/release.mjs musl\``);
  }

  requireGh();
  gh(["release", "upload", tag, path, "--clobber"]);
}

/** The release filename is also the name the app looks for when updating. */
function apkName(version, debug = false) {
  return `Wave_${version}_arm64${debug ? "-debug" : ""}.apk`;
}

function commandApk(debug = false) {
  const version = readVersion();
  const buildType = debug ? "debug" : "release";
  const apkBuild = join(APK_OUTPUT_DIR, buildType, `app-universal-${buildType}.apk`);
  shell(`npx tauri android build --apk ${debug ? "--debug " : ""}-t aarch64`);

  if (!existsSync(apkBuild)) {
    fail(`the Android build produced no ${buildType} APK; is the signing keystore there?`);
  }

  let metadata;
  try {
    metadata = JSON.parse(readFileSync(join(dirname(apkBuild), "output-metadata.json"), "utf8"));
  } catch {
    fail("the Android build produced no readable APK metadata");
  }
  if (!metadata.elements?.some((item) => item.outputFile === basename(apkBuild) && item.versionName === version)) {
    fail(`the Android APK does not match VERSION ${version} or was not signed; check the build output and version sync`);
  }

  mkdirSync(ANDROID_DIR, { recursive: true });
  const target = join(ANDROID_DIR, apkName(version, debug));
  copyFileSync(apkBuild, target);
  say(`\nWrote ${target}`);
}

function commandUploadApk(tag) {
  if (!tag) fail("upload-apk needs a tag");

  const path = join(ANDROID_DIR, apkName(readVersion()));
  if (!existsSync(path)) {
    fail(`there is no APK for ${readVersion()}; build one with \`node scripts/release.mjs apk\``);
  }

  requireGh();
  gh(["release", "upload", tag, path, "--clobber"]);
}

function releaseExists(tag) {
  try {
    execFileSync("gh", ["release", "view", tag], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** What a release's body says now. */
function releaseBodyOf(tag) {
  const release = JSON.parse(gh(["release", "view", tag, "--json", "body"], { capture: true }));
  return release.body ?? "";
}

/** Rewrites a release's body with the feature list above it. */
function setBody(tag, body, features) {
  gh(["release", "edit", tag, "--notes-file", "-"], { input: withFeatures(body, features) });
}

function commandPublish(options) {
  if (options.android && !options.local) fail("--android requires --local; CI already builds Android");
  if (options.android && options.noPublish) fail("--android cannot be used with --no-publish");

  const version = readVersion();
  const tag = `v${version}`;
  const features = options.features;
  const ci = !options.local && existsSync(WORKFLOW);
  const plan = [];

  plan.push(`sync VERSION (${version}) into ${TARGETS.length} files`);
  plan.push(`commit any outstanding changes as "Release ${tag}"`);
  plan.push(`tag ${tag} and push it with the branch`);
  if (options.noPublish) plan.push("stop there");
  else if (ci) plan.push("dispatch the release workflow, which builds both platforms and publishes both builds");
  else plan.push(`build the full and the slim installers${options.android ? " and the Android APK" : ""} here and publish the release from them`);

  say(`Publishing ${tag}\n`);
  for (const step of plan) say(`  - ${step}`);

  const lines = featureLines(features);
  if (lines.length > 0) {
    say("");
    say(`Features (${lines.length}):`);
    for (const line of lines) say(`  - ${line}`);
  }
  say("");

  if (options.dryRun) {
    say("Dry run, so nothing was changed.");
    return;
  }

  // CI is driven through gh, so it has to be there before anything is pushed.
  if (ci) requireGh();

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

  if (ci) {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], { capture: true }).trim();
    const args = ["workflow", "run", "release.yml", "--ref", branch, "-f", `tag=${tag}`];
    // The list travels with the dispatch, because the body is written by the
    // build rather than here.
    if (lines.length > 0) args.push("-f", `features=${lines.join("\n")}`);
    gh(args);
    say("\nCI is building the installers; watch it with `gh run list`.");
    say("The release appears when the build finishes.");
    return;
  }

  shell("npx tauri build");
  commandSlim(true);

  const assets = localAssets(version);
  if (assets.length === 0) fail("the build produced no installers to upload");
  if (options.android) {
    commandApk();
    assets.push(join(ANDROID_DIR, apkName(version)));
  }
  say(`\nUploading ${assets.length} installer(s).`);

  requireGh();

  if (releaseExists(tag)) {
    gh(["release", "upload", tag, ...assets, "--clobber"]);
    if (lines.length > 0) setBody(tag, releaseBodyOf(tag), features);
  } else {
    // gh puts the generated commit list after the notes rather than replacing
    // them, so the blurb and the list both survive.
    const local = assets.map((path) => ({ name: basename(path), size: statSync(path).size }));
    const body = options.notes ? withFeatures(options.notes, features) : releaseBody(features, local);
    const notes = options.notes ? ["--notes", body] : ["--notes", body, "--generate-notes"];
    const draft = options.draft ? ["--draft"] : [];
    gh(["release", "create", tag, ...assets, "--title", `Wave ${version}`, ...notes, ...draft]);
  }

  say(`\n${tag} is published.`);
}

function parse(argv) {
  // The release workflow passes the list through the environment, where a
  // multi-line value needs no quoting.
  const options = {
    rest: [],
    files: [],
    features: (process.env.WAVE_RELEASE_FEATURES ?? "").split("\n").filter((line) => line.trim()),
  };

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
      case "--android": options.android = true; break;
      case "--debug": options.debug = true; break;
      case "--reuse-build": options.reuseBuild = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "--yes": options.yes = true; break;
      case "--no-publish": options.noPublish = true; break;
      case "--tag": options.tag = true; break;
      case "--title": options.title = value("--title"); break;
      case "--notes": options.notes = value("--notes"); break;
      case "--feature": options.features.push(value("--feature")); break;
      default:
        if (arg.startsWith("--")) fail(`unknown option ${arg}`);
        options.rest.push(arg);
    }
  }
  return options;
}

const USAGE = `
Wave's release tool. VERSION at the repo root is the single source of truth.

  node scripts/release.mjs <command> [options]
  npm run release -- <command>

npm keeps any option for itself and drops it, so a command with options has to
be run through node directly.

Version
  status                          Show VERSION and whether every copy agrees
  sync                            Write VERSION into every file that carries it
  bump <major|minor|patch|x.y.z>  Change VERSION, then sync

Releases
  guide [part]                    Print the steps for cutting a release, where
                                  part is patch, minor, major or x.y.z
  list                            List every release
  view <tag>                      Show one release
  assets <tag>                    List a release's assets
  runs [id|phone]                 Show a compact release or phone recovery status
  body [--feature <text>...]      Print the body a release is given
  publish [options]               Sync, commit, tag, push, and publish
  slim                            Build the slim installers and rename them
  slim --reuse-build              Bundle slim installers from an existing build
  musl                            Build the aarch64 musl package, on Alpine
  android [debug]                 Build an arm64 Android APK (debug for testing)
  apk [debug]                     Alias for android
  upload <tag> <file...>          Add assets to a release
  upload-slim <tag>               Add the slim installers to a release
  upload-musl <tag>               Add the musl package to a release
  upload-apk <tag>                Add the Android APK to a release
  prepare <tag>                   Create a draft release if one does not exist
  organize <tag>                  Organize download links on a release
  finalize <tag>                  Verify assets and publish a complete release
  rm-asset <tag> <name...>        Remove assets from a release
  edit <tag> [options]            Change a release's title, notes or draft state
  delete <tag> --yes [--tag]      Delete a release, and its git tag with --tag
  open <tag>                      Open a release in the browser

publish options
  --feature <text>  One line of the release's feature list (repeatable)
  --draft           Create it as a draft
  --notes <text>    Release notes (default: the installers blurb, then the commits)
  --local           Build the installers here instead of waiting for CI
  --android         Include an Android APK when publishing with --local
  --no-publish      Stop after pushing the tag
  --dry-run         Print the plan and change nothing

edit options
  --title <text>   --notes <text>   --feature <text>   --draft   --publish
`.trim();

function main() {
  const [command, ...argv] = process.argv.slice(2);
  const options = parse(argv);
  const [first, ...more] = options.rest;

  if (options.android && command !== "publish") fail("--android is only available for publish");
  if (options.debug && command !== "android" && command !== "apk") fail("--debug is only available for android or apk");
  if (options.reuseBuild && command !== "slim") fail("--reuse-build is only available for slim");

  switch (command) {
    case "status":
    case "check": return commandStatus();
    case "sync": return commandSync();
    case "bump": return commandBump(first);
    case "guide": return commandGuide(first);
    case "body": return commandBody(options);
    case "list": return commandList();
    case "view": return commandView(first);
    case "open": return commandOpen(first);
    case "assets": return commandAssets(first);
    case "runs": return commandRuns(first);
    case "slim": return commandSlim(options.reuseBuild);
    case "musl": return commandMusl();
    case "android":
    case "apk":
      if ((first && first !== "debug") || more.length > 0) fail(`${command} only accepts debug`);
      return commandApk(options.debug || first === "debug");
    case "upload": return commandUpload(first, more);
    case "upload-slim": return commandUploadSlim(first);
    case "upload-musl": return commandUploadMusl(first);
    case "upload-apk": return commandUploadApk(first);
    case "prepare": return commandPrepare(first, options);
    case "organize": return commandOrganize(first);
    case "finalize": return commandOrganize(first, true);
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
