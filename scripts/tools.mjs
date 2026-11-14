#!/usr/bin/env node
// Wave's download tools fetcher.
//
//   npm run tools
//   node scripts/tools.mjs [--platform win|linux] [--arch x64|arm64] [--force]
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
import { inflateRawSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "src-tauri", "tools");
const MANIFEST = join(OUT_DIR, "versions.json");

/**
 * Where each tool comes from, and what to keep once it is unpacked.
 *
 * `asset` and `pick` are read as [platform][arch], because the three tools
 * publish a different build per architecture and a Linux package has to carry
 * the one it was built for. Windows is x64 only.
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
    asset: {
      win: { x64: "yt-dlp.exe" },
      linux: { x64: "yt-dlp_linux", arm64: "yt-dlp_linux_aarch64" },
    },
    checksums: "SHA2-256SUMS",
    pick: {
      win: { x64: { "yt-dlp.exe": "yt-dlp.exe" } },
      linux: {
        x64: { "yt-dlp": "yt-dlp_linux" },
        arm64: { "yt-dlp": "yt-dlp_linux_aarch64" },
      },
    },
    unpack: false,
  },
  {
    key: "ffmpeg",
    // yt-dlp's own build fork, which is the one its documentation points at.
    // Static, so neither platform needs shared libraries beside it. The arm64
    // archive holds the same two programs, under a directory of its own name.
    repo: "yt-dlp/FFmpeg-Builds",
    asset: {
      win: { x64: "ffmpeg-master-latest-win64-gpl.zip" },
      linux: {
        x64: "ffmpeg-master-latest-linux64-gpl.tar.xz",
        arm64: "ffmpeg-master-latest-linuxarm64-gpl.tar.xz",
      },
    },
    checksums: "checksums.sha256",
    pick: {
      win: {
        x64: {
          "ffmpeg.exe": "ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe",
          "ffprobe.exe": "ffmpeg-master-latest-win64-gpl/bin/ffprobe.exe",
        },
      },
      linux: {
        x64: {
          "ffmpeg": "ffmpeg-master-latest-linux64-gpl/bin/ffmpeg",
          "ffprobe": "ffmpeg-master-latest-linux64-gpl/bin/ffprobe",
        },
        arm64: {
          "ffmpeg": "ffmpeg-master-latest-linuxarm64-gpl/bin/ffmpeg",
          "ffprobe": "ffmpeg-master-latest-linuxarm64-gpl/bin/ffprobe",
        },
      },
    },
    unpack: true,
  },
  {
    key: "deno",
    // yt-dlp hands YouTube's JavaScript challenges to a runtime, and Deno is
    // the only one it enables by default. A single self-contained executable,
    // which is why yt-dlp picked it. Only glibc builds are published, so there
    // is nothing here for a musl system.
    repo: "denoland/deno",
    asset: {
      win: { x64: "deno-x86_64-pc-windows-msvc.zip" },
      linux: {
        x64: "deno-x86_64-unknown-linux-gnu.zip",
        arm64: "deno-aarch64-unknown-linux-gnu.zip",
      },
    },
    // Published as a file beside each asset, rather than one for the release.
    checksums: "asset",
    pick: {
      win: { x64: { "deno.exe": "deno.exe" } },
      linux: { x64: { "deno": "deno" }, arm64: { "deno": "deno" } },
    },
    unpack: true,
  },
];

const PLATFORMS = ["win", "linux"];
const ARCHES = ["x64", "arm64"];

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
  --arch <x64|arm64>       Which architecture to fetch for (default: this one)
  --force                  Fetch again even when the files are already there
  --yt-dlp <tag>           Pin a yt-dlp release, instead of the latest
  --ffmpeg <tag>           Pin an FFmpeg-Builds release
  --deno <tag>             Pin a Deno release
  -h, --help               Show this message

The files land in src-tauri/tools and are what the bundle ships. They are not
committed, so the first build on a machine downloads about 250 MB.
`.trim();

function parse(argv) {
  const options = { platform: null, arch: null, force: false, tags: {} };

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
      case "--arch":
        options.arch = value("--arch");
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
  if (options.arch && !ARCHES.includes(options.arch)) {
    fail(`--arch takes ${ARCHES.join(" or ")}, not ${options.arch}`);
  }
  return options;
}

function hostPlatform() {
  if (process.platform === "win32") return "win";
  if (process.platform === "linux") return "linux";
  fail(`there is no Wave build for ${process.platform}; it ships for Windows and Linux`);
}

function hostArch() {
  if (process.arch === "x64") return "x64";
  if (process.arch === "arm64") return "arm64";
  fail(`there is no Wave build for ${process.arch}; it ships for x64 and arm64`);
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

/**
 * Where a zip's central directory starts and how many entries it holds, read
 * from the end-of-central-directory record at the end of the file.
 */
function zipDirectory(zip) {
  const lowest = Math.max(0, zip.length - 22 - 0xffff);

  for (let at = zip.length - 22; at >= lowest; at -= 1) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      const offset = zip.readUInt32LE(at + 16);
      if (offset === 0xffffffff) fail("the zip is zip64, which is not supported");
      return { offset, count: zip.readUInt16LE(at + 10) };
    }
  }

  fail("the zip has no end-of-central-directory record");
}

/**
 * Unpacks a zip here rather than handing it to a tool, so a build never depends
 * on unzip being installed. The tar on Linux is GNU tar, which cannot read zip
 * at all, and that is what broke the Linux release.
 *
 * Entries are read from the central directory, which keeps the real sizes even
 * when a streamed zip wrote zeroes into its local headers.
 */
function unzip(archive, dest) {
  const zip = readFileSync(archive);
  const directory = zipDirectory(zip);
  let at = directory.offset;

  for (let index = 0; index < directory.count; index += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) fail(`${archive} has a broken central directory`);

    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const mode = zip.readUInt32LE(at + 38) >>> 16;
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);

    // The local header repeats the name and the extra field, at its own lengths.
    const local = zip.readUInt32LE(at + 42);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);

    const target = join(dest, name);
    if (!target.startsWith(dest)) fail(`${archive} holds ${name}, which escapes the archive`);

    if (name.endsWith("/")) {
      mkdirSync(target, { recursive: true });
    } else {
      mkdirSync(dirname(target), { recursive: true });
      if (method === 0) writeFileSync(target, raw);
      else if (method === 8) writeFileSync(target, inflateRawSync(raw));
      else fail(`${archive} holds ${name}, compressed in a way that is not supported`);
      // The bundle keeps the mode, and Linux will not run them without it.
      if (mode & 0o111) chmodSync(target, 0o755);
    }

    at += 46 + nameLength + extraLength + commentLength;
  }
}

/** Unpacks an archive: a zip is read here, and a tar.xz goes through tar. */
function unpack(archive, dest) {
  mkdirSync(dest, { recursive: true });

  if (archive.endsWith(".zip")) {
    unzip(archive, dest);
    return;
  }

  try {
    execFileSync("tar", ["-xf", archive, "-C", dest], { stdio: "ignore" });
  } catch {
    fail(`could not unpack ${archive}; tar has to be on PATH`);
  }
}

async function fetchTool(source, platform, arch, options, manifest) {
  const wanted = source.pick[platform]?.[arch];
  if (!wanted) fail(`${source.key} publishes nothing for ${platform} ${arch}`);

  const names = Object.keys(wanted);
  const bucket = `${platform}-${arch}`;
  const known = manifest[bucket]?.[source.key];
  const present = names.every((name) => existsSync(join(OUT_DIR, name)));

  if (present && !options.force) {
    say(`  ${source.key.padEnd(7)} already there${known ? ` (${known.tag})` : ""}`);
    return;
  }

  const release = await fetchRelease(source.repo, options.tags[source.key]);
  const assetName = source.asset[platform][arch];
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

    manifest[bucket] = manifest[bucket] ?? {};
    manifest[bucket][source.key] = {
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
  const arch = options.arch ?? hostArch();

  mkdirSync(OUT_DIR, { recursive: true });

  const manifest = existsSync(MANIFEST)
    ? JSON.parse(readFileSync(MANIFEST, "utf8"))
    : {};

  say(`Fetching the download tools for ${platform} ${arch}`);
  for (const source of SOURCES) {
    await fetchTool(source, platform, arch, options, manifest);
  }

  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  say(`\nIn ${OUT_DIR}`);
}

await main();
