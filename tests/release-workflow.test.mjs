import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const recovery = readFileSync(new URL("../.github/workflows/release-phone.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const flatpakRecovery = readFileSync(new URL("../.github/workflows/release-flatpak.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const phoneTests = readFileSync(new URL("../.github/workflows/linux-phone.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const musl = readFileSync(new URL("../scripts/musl-build.sh", import.meta.url), "utf8");
const runtime = readFileSync(new URL("../scripts/musl-runtime-test.sh", import.meta.url), "utf8");
const gui = readFileSync(new URL("../scripts/musl-gui-test.sh", import.meta.url), "utf8");
const phoneConfig = JSON.parse(readFileSync(new URL("../src-tauri/tauri.phone.conf.json", import.meta.url), "utf8"));
const linuxConfig = JSON.parse(readFileSync(new URL("../src-tauri/tauri.linux.conf.json", import.meta.url), "utf8"));
const slimConfig = JSON.parse(readFileSync(new URL("../src-tauri/tauri.slim.conf.json", import.meta.url), "utf8"));
const packageScripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;

test("release builds run after signing checks and publish only after every platform succeeds", () => {
  assert.match(workflow, /name: Use current build test tooling[\s\S]*ref: \$\{\{ github\.sha \}\}[\s\S]*path: \.release-tools/);
  assert.match(workflow, /name: Test build and release scripts[\s\S]*npm run test:build-scripts[\s\S]*xvfb-run -a sh tests\/window-class-x11\.test\.sh[\s\S]*Check Android signing/);
  assert.match(workflow, /Check Android signing[\s\S]*Create the draft release/);
  for (const job of ["build", "musl", "android"]) {
    assert.match(workflow, new RegExp(`^  ${job}:\\n(?:    [^\\n]*\\n)*?    needs: prepare$`, "m"));
  }
  assert.match(workflow, /needs: \[prepare, build, musl, android\]/);
  assert.match(workflow, /node scripts\/release\.mjs finalize "\$RELEASE_TAG"/);
  assert.match(workflow, /node scripts\/release\.mjs slim --reuse-build/);
});

test("the ARM release builds, tests and publishes the phone Flatpak", () => {
  assert.match(workflow, /name: Set up the phone Flatpak runtime\n        if: matrix\.platform == 'ubuntu-22\.04-arm'/);
  assert.match(workflow, /apt-get install -y flatpak .*x11-utils/);
  assert.match(workflow, /flatpak install --user --noninteractive -y flathub org\.gnome\.Platform\/\/51/);
  assert.match(workflow, /npx tauri build --no-bundle --config src-tauri\/tauri\.phone\.conf\.json/);
  assert.match(workflow, /sh scripts\/flatpak-build\.sh/);
  assert.match(workflow, /name: Use current Flatpak test tooling[\s\S]*ref: \$\{\{ github\.sha \}\}[\s\S]*path: \.release-tools/);
  assert.match(workflow, /flatpak install --user --noninteractive -y "src-tauri\/target\/flatpak\/Wave_\$\{version\}_aarch64_phone\.flatpak"/);
  assert.match(workflow, /xvfb-run .*dbus-run-session -- sh \.release-tools\/scripts\/flatpak-runtime-test\.sh/);
  assert.match(workflow, /asset="Wave_\$\{version\}_aarch64_phone\.flatpak"/);
  assert.match(workflow, /node scripts\/release\.mjs upload "\$RELEASE_TAG" "src-tauri\/target\/flatpak\/\$asset"/);
  assert.match(workflow, /cmp "src-tauri\/target\/flatpak\/\$asset" "\$RUNNER_TEMP\/flatpak-download\/\$asset"/);
  assert.match(workflow, /name: Build the phone Flatpak[\s\S]*name: Save the phone Flatpak[\s\S]*name: Verify the phone Flatpak/);
});

test("Flatpak recovery builds only the phone package and keeps it if verification fails", () => {
  assert.match(flatpakRecovery, /runs-on: ubuntu-22\.04-arm/);
  assert.match(flatpakRecovery, /ref: \$\{\{ inputs\.tag \}\}[\s\S]*ref: \$\{\{ github\.sha \}\}/);
  assert.match(flatpakRecovery, /Wave_\$\{version\}_arm64\.deb/);
  assert.match(flatpakRecovery, /name: Build the phone Flatpak[\s\S]*name: Save the phone Flatpak[\s\S]*name: Verify the phone Flatpak[\s\S]*release\.mjs finalize/);
  assert.doesNotMatch(flatpakRecovery, /tauri-action|release\.mjs slim/);
});

test("Linux RPMs use fast compression and retain the full and slim package contents", () => {
  assert.deepEqual(linuxConfig.bundle.linux.rpm.compression, { type: "zstd", level: 3 });
  for (const tool of ["yt-dlp", "ffmpeg", "ffprobe", "deno"]) {
    assert.equal(linuxConfig.bundle.resources[`tools/${tool}`], `tools/${tool}`);
  }
  assert.equal(slimConfig.bundle.resources, null);
  assert.match(workflow, /name: Verify Linux RPM packages[\s\S]*rpm --checksig "\$full" "\$slim"/);
  assert.match(workflow, /%\{PAYLOADCOMPRESSOR\}/);
});

test("phone tests run only manually on ARM Alpine", () => {
  for (const source of [phoneTests, workflow, recovery]) {
    assert.match(source, /^  workflow_dispatch:/m);
    assert.doesNotMatch(source, /^  (?:push|pull_request):/m);
    assert.match(source, /actions\/cache@v5/);
  }
  for (const script of ["build-scripts", "flatpak", "linux-phone", "release-android", "release-assets", "release-workflow"]) {
    assert.ok(packageScripts["test:build-scripts"].includes(`tests/${script}.test.mjs`));
  }
  assert.match(phoneTests, /npm run test:build-scripts/);
  assert.match(phoneTests, /xvfb-run -a sh tests\/window-class-x11\.test\.sh/);
  assert.match(phoneTests, /tests\/phone-lab\.test\.mjs/);
  assert.match(phoneTests, /tests\/audio-stream-path\.test\.mjs/);
  assert.match(phoneTests, /tests\/startup-diagnostics\.test\.mjs/);
  assert.match(phoneTests, /run: npm ci[\s\S]*npm run test:build-scripts/);
  assert.match(phoneTests, /runs-on: ubuntu-22\.04-arm/);
  assert.match(phoneTests, /alpine:3\.22 sh scripts\/musl-build\.sh/);
  assert.match(phoneTests, /alpine:3\.22 sh scripts\/musl-runtime-test\.sh/);
  assert.match(phoneTests, /--env WAVE_TEST_WEBKIT_SANDBOX=0/);
  assert.doesNotMatch(phoneTests, /--security-opt seccomp=unconfined/);
  assert.match(phoneTests, /phone-lab-audio\.test\.sh/);
});

test("phone recovery uses tagged application source and current build tooling", () => {
  assert.match(recovery, /test-scripts:[\s\S]*npm run test:build-scripts[\s\S]*xvfb-run -a sh tests\/window-class-x11\.test\.sh[\s\S]*musl:[\s\S]*needs: test-scripts/);
  assert.match(recovery, /ref: \$\{\{ inputs\.tag \}\}/);
  assert.match(recovery, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(recovery, /\.release-tools\/scripts\/musl-build\.sh/);
  assert.match(recovery, /This tag lacks the phone UI fixes/);
  assert.match(recovery, /--env WAVE_TEST_MPRIS_QUIT=0/);
  assert.match(recovery, /--env WAVE_TEST_MPRIS_PLAYBACK=0/);
  assert.match(recovery, /\.release-tools\/scripts\/test-mpris\.py/);
  assert.match(recovery, /\.release-tools\/scripts\/check-window-class\.sh/);
  assert.match(recovery, /node scripts\/release\.mjs upload-musl "\$RELEASE_TAG"/);
  assert.match(recovery, /node scripts\/release\.mjs organize "\$RELEASE_TAG"/);
  assert.match(musl, /CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS="-C target-feature=-crt-static"/);
  assert.match(musl, /TAURI_CONFIG="\$\(cat src-tauri\/tauri\.phone\.conf\.json\)"/);
  assert.match(musl, /cargo test .*--target aarch64-unknown-linux-musl --lib/);
  assert.match(musl, /\nldd /);
});

test("phone releases verify installation in a clean Alpine environment", () => {
  for (const source of [workflow, recovery]) {
    assert.match(source, /name: Verify the musl installer in a clean Alpine runtime/);
    assert.match(source, /alpine:3\.22 sh scripts\/musl-runtime-test\.sh/);
    assert.match(source, /--env WAVE_TEST_WEBKIT_SANDBOX=0/);
    assert.doesNotMatch(source, /--security-opt seccomp=unconfined/);
    assert.match(source, /gh release download "\$RELEASE_TAG" --pattern "\$asset"/);
    assert.match(source, /cmp "src-tauri\/target\/musl\/\$asset"/);
  }
  assert.match(runtime, /sh install\.sh --version/);
  assert.match(runtime, /ldd "\$HOME\/\.local\/bin\/wave-bin"/);
  assert.match(runtime, /xvfb-run .*musl-gui-test\.sh/);
  assert.match(runtime, /apk add --no-cache .*xprop/);
  assert.match(workflow, /name: Use current phone test tooling[\s\S]*\.release-tools\/scripts\/musl-runtime-test\.sh[\s\S]*\.release-tools\/scripts\/check-window-class\.sh[\s\S]*Verify the musl installer/);
  assert.match(runtime, /WEBKIT_FORCE_SANDBOX=1/);
  assert.match(runtime, /WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1/);
  assert.match(runtime, /sh install\.sh --uninstall/);
  assert.equal(phoneConfig.app.windows[0].url, "index.html?device=linuxPhone");
  assert.match(gui, /frontend ready \(linuxPhone\)/);
  assert.match(gui, /check-window-class\.sh/);
  assert.doesNotMatch(gui, /getwindowclassname/);
  assert.match(gui, /xdotool .*click 1/);
  assert.match(gui, /Wave did not produce audible audio/);
  assert.match(gui, /phone import panel did not visibly open/);
  assert.match(gui, /WAVE_WEBKIT_HELPER_DIR=/);
  assert.match(gui, /WAVE_WEBKIT_BUNDLE_DIR=/);
  assert.match(gui, /WAVE_TEST_MPRIS_QUIT:-1/);
  assert.match(gui, /test-mpris\.py.*wave_test\.monitor/);
  assert.match(gui, /org\.mpris\.MediaPlayer2\.Quit/);
  assert.match(gui, /yt-dlp --ignore-config/);
  assert.match(gui, /"\$wave" import "\$work\/music"/);
});

test("phone builds restore ownership of cached files after the container exits", () => {
  for (const source of [workflow, recovery]) {
    assert.match(source, /name: Build the musl package[\s\S]*name: Restore musl cache ownership\n        if: always\(\)/);
    assert.match(source, /for path in "\$RUNNER_TEMP\/musl-cargo" src-tauri\/target\/aarch64-unknown-linux-musl/);
    assert.match(source, /sudo chown -R "\$\(id -u\):\$\(id -g\)" "\$path"/);
  }
});
