#!/usr/bin/env node
// Wave's download tools fetcher.
//
//   npm run tools
//   node scripts/tools.mjs [--platform win|linux] [--force]
//                          [--yt-dlp <tag>] [--ffmpeg <tag>] [--deno <tag>]
//
// Wave downloads through yt-dlp, which needs ffmpeg to make an mp3 and Deno to
// solve YouTube's player challenges. All three ship with the app, so a fresh
// install can download without anything being set up by hand first.
//
// Nothing here is committed. The files land in src-tauri/tools, which the
// bundle takes as resources, and are fetched again for every release. That is
// deliberate: yt-dlp's own guidance is to always run the newest version, since
// YouTube breaks older extractors.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "src-tauri", "tools");
const MANIFEST = join(OUT_DIR, "versions.json");

/**
 * Where each tool comes from, and what to keep once it is unpacked.
 *
 * `pick` maps the name in src-tauri/tools to the path inside the unpacked
 * archive, or to the download itself when the asset is a bare executable.
 */
const SOURCES = [
  {
    key: "yt-dlp",
    repo: "yt-dlp/yt-dlp",
    // The PyInstaller builds, which carry the challenge scripts yt-dlp-ejs
    // ships, so nothing has to be fetched at run time.
    asset: { win: "yt-dlp.exe", linux: "yt-dlp_linux" },
    checksums: "SHA2-256SUMS",
    pick: { win: { "yt-dlp.exe": "yt-dlp.exe" }, linux: { "yt-dlp": "yt-dlp_linux" } },
    unpack: false,
  },
  {
    key: "ffmpeg",
    // yt-dlp's own build fork, which is the one its documentation points at.
    // Static, so neither platform needs shared libraries beside it.
    repo: "yt-dlp/FFmpeg-Builds",
    asset: {
      win: "ffmpeg-master-latest-win64-gpl.zip",
      linux: "ffmpeg-master-latest-linux64-gpl.tar.xz",
    },
    checksums: "checksums.sha256",
    pick: {
      win: {
        "ffmpeg.exe": "ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe",
        "ffprobe.exe": "ffmpeg-master-latest-win64-gpl/bin/ffprobe.exe",
      },
      linux: {
        "ffmpeg": "ffmpeg-master-latest-linux64-gpl/bin/ffmpeg",
        "ffprobe": "ffmpeg-master-latest-linux64-gpl/bin/ffprobe",
      },
    },
    unpack: true,
  },
  {
    key: "deno",
    // yt-dlp hands YouTube's JavaScript challenges to a runtime, and Deno is
    // the only one it enables by default. A single self-contained executable,
    // which is why yt-dlp picked it.
    repo: "denoland/deno",
    asset: {
      win: "deno-x86_64-pc-windows-msvc.zip",
      linux: "deno-x86_64-unknown-linux-gnu.zip",
    },
    // Published as a file beside each asset, rather than one for the release.
    checksums: "asset",
    pick: { win: { "deno.exe": "deno.exe" }, linux: { "deno": "deno" } },
    unpack: true,
  },
];

const PLATFORMS = ["win", "linux"];

const say = (message = "") => console.log(message);
const warn = (message) => console.error(`warning: ${message}`);
const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};

const USAGE = `
Wave's download tools fetcher.

  npm run tools
  node scripts/tools.mjs [options]

Options
  --platform <win|linux>   Which platform to fetch for (default: this one)
  --force                  Fetch again even when the files are already there
  --yt-dlp <tag>           Pin a yt-dlp release, instead of the latest
  --ffmpeg <tag>           Pin an FFmpeg-Builds release
  --deno <tag>             Pin a Deno release
  -h, --help               Show this message

The files land in src-tauri/tools and are what the bundle ships. They are not
committed, so the first build on a machine downloads about 250 MB.
`.trim();

function parse(argv) {
  const options = { platform: null, force: false, tags: {} };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = (name) => {
      if (index + 1 >= argv.length) fail(`${name} needs a value`);
      index += 1;
      return argv[index];
    };

    switch (arg) {
      case "--platform":
        options.platform = value("--platform");
        break;
      case "--force":
        options.force = true;
        break;
      case "--yt-dlp":
        options.tags["yt-dlp"] = value("--yt-dlp");
        break;
      case "--ffmpeg":
        options.tags.ffmpeg = value("--ffmpeg");
        break;
      case "--deno":
        options.tags.deno = value("--deno");
        break;
      case "-h":
      case "--help":
        say(USAGE);
        process.exit(0);
        break;
      default:
        fail(`unknown option ${arg}\n\n${USAGE}`);
    }
  }

  if (options.platform && !PLATFORMS.includes(options.platform)) {
    fail(`--platform takes ${PLATFORMS.join(" or ")}, not ${options.platform}`);
  }
  return options;
}

function hostPlatform() {
  if (process.platform === "win32") return "win";
  if (process.platform === "linux") return "linux";
  fail(`there is no Wave build for ${process.platform}; it ships for Windows and Linux`);
}

/** The release a tool is taken from, named by a tag or left as the latest. */
async function fetchRelease(repo, tag) {
  const url = tag
    ? `https://api.github.com/repos/${repo}/releases/tags/${tag}`
    : `https://api.github.com/repos/${repo}/releases/latest`;

  const headers = { accept: "application/vnd.github+json" };
  // The release build passes one in, so a busy runner cannot hit the anonymous
  // rate limit halfway through the three downloads.
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const response = await fetch(url, { headers });
  if (!response.ok) fail(`could not read ${url} (${response.status})`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) fail(`could not read ${url} (${response.status})`);
  return response.text();
}

async function fetchTo(url, path) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) fail(`could not download ${url} (${response.status})`);
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
}

/**
 * Every `hash  name` pair in a checksum file, in file order. Deno publishes
 * PowerShell's `Name : ... / Hash : ...` listing instead, and yt-dlp publishes
 * a `sha256sum` one, so both shapes are read.
 */
function pairs(text) {
  const found = [];

  for (const line of text.split(/\r?\n/)) {
    const standard = line.match(/^([0-9a-f]{64})\s+\*?(.+?)\s*$/i);
    if (standard) {
      found.push({ hash: standard[1].toLowerCase(), name: standard[2] });
      continue;
    }

    const flipped = line.match(/^(.+?):\s*([0-9a-f]{64})\s*$/i);
    if (flipped) found.push({ hash: flipped[2].toLowerCase(), name: flipped[1].trim() });
  }

  return found;
}

/** The one hash a checksum file holds for `name`, or nothing. */
function checksum(text, name) {
  const found = pairs(text);

  const named = found.find((pair) => pair.name === name || pair.name.endsWith(`/${name}`));
  if (named) return named.hash;

  // A file holding a single hash does not have to say what it is for.
  return found.length === 1 ? found[0].hash : null;
}

/** Fails unless the download matches what the release publishes for it. */
async function verify(source, release, assetName, digest) {
  const wanted =
    source.checksums === "asset" ? `${assetName}.sha256sum` : source.checksums;

  const published = release.assets.find((candidate) => candidate.name === wanted);
  if (!published) {
    warn(`${release.tag_name} publishes no ${wanted}, so ${assetName} went unchecked`);
    return;
  }

  const expected = checksum(await fetchText(published.browser_download_url), assetName);
  if (!expected) fail(`${wanted} says nothing about ${assetName}`);
  if (expected !== digest) fail(`${assetName} does not match ${wanted}`);
}

/** Unpacks an archive with tar, which reads zip and tar.xz on both platforms. */
function unpack(archive, dest) {
  mkdirSync(dest, { recursive: true });
  try {
    execFileSync("tar", ["-xf", archive, "-C", dest], { stdio: "ignore" });
  } catch {
    fail(`could not unpack ${archive}; a tar that reads it has to be on PATH`);
  }
}

async function fetchTool(source, platform, options, manifest) {
  const wanted = source.pick[platform];
  const names = Object.keys(wanted);
  const known = manifest[platform]?.[source.key];
  const present = names.every((name) => existsSync(join(OUT_DIR, name)));

  if (present && !options.force) {
    say(`  ${source.key.padEnd(7)} already there${known ? ` (${known.tag})` : ""}`);
    return;
  }

  const release = await fetchRelease(source.repo, options.tags[source.key]);
  const assetName = source.asset[platform];
  const asset = release.assets.find((candidate) => candidate.name === assetName);
  if (!asset) fail(`${source.repo} ${release.tag_name} has no ${assetName}`);

  const work = mkdtempSync(join(tmpdir(), "wave-tools-"));
  try {
    const download = join(work, assetName);
    await fetchTo(asset.browser_download_url, download);

    const digest = createHash("sha256").update(readFileSync(download)).digest("hex");
    await verify(source, release, assetName, digest);

    let tree = null;
    if (source.unpack) {
      tree = join(work, "unpacked");
      unpack(download, tree);
    }

    for (const [name, inside] of Object.entries(wanted)) {
      const from = tree ? join(tree, inside) : download;
      if (!existsSync(from)) fail(`${assetName} holds no ${inside}`);

      const target = join(OUT_DIR, name);
      copyFileSync(from, target);
      // The bundle keeps the mode, and Linux will not run them without it.
      if (platform === "linux") chmodSync(target, 0o755);
    }

    manifest[platform] = manifest[platform] ?? {};
    manifest[platform][source.key] = {
      tag: release.tag_name,
      asset: assetName,
      sha256: digest,
    };
    say(`  ${source.key.padEnd(7)} ${release.tag_name}  (${assetName})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const options = parse(process.argv.slice(2));
  const platform = options.platform ?? hostPlatform();

  mkdirSync(OUT_DIR, { recursive: true });

  const manifest = existsSync(MANIFEST)
    ? JSON.parse(readFileSync(MANIFEST, "utf8"))
    : {};

  say(`Fetching the download tools for ${platform}`);
  for (const source of SOURCES) {
    await fetchTool(source, platform, options, manifest);
  }

  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  say(`\nIn ${OUT_DIR}`);
}

await main();
