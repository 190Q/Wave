import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
const android = JSON.parse(read("src-tauri/tauri.android.conf.json"));
const gradle = read("src-tauri/gen/android/app/build.gradle.kts");
const manifest = read("src-tauri/gen/android/app/src/main/AndroidManifest.xml");
const debugManifest = read("src-tauri/gen/android/app/src/debug/AndroidManifest.xml");

test("Android debug builds use a distinct ID in Tauri and Gradle", () => {
  assert.equal(tauri.identifier, "com.wave.app");
  assert.equal(android.bundle.android.debugApplicationIdSuffix, ".dev");
  assert.match(gradle, /applicationId = "com\.wave\.app"/);
  assert.match(gradle, /getByName\("debug"\)\s*\{\s*applicationIdSuffix = "\.dev"/);
});

test("Android providers use the installed application ID", () => {
  assert.match(manifest, /android:authorities="\$\{applicationId\}\.fileprovider"/);
  assert.match(manifest, /android:authorities="\$\{applicationId\}\.documents"/);
});

test("debug builds have a distinct label and cannot install release updates", () => {
  const labels = read("src-tauri/gen/android/app/src/debug/res/values/strings.xml");
  const installer = read("src-tauri/gen/android/app/src/main/java/com/wave/app/ApkInstallPlugin.kt");
  assert.match(labels, /name="app_name">"Wave Dev"/);
  assert.match(labels, /name="main_activity_title">"Wave Dev"/);
  assert.match(manifest, /android:name="android\.permission\.REQUEST_INSTALL_PACKAGES"/);
  assert.match(debugManifest, /android:name="android\.permission\.REQUEST_INSTALL_PACKAGES" tools:node="remove"/);
  assert.match(installer, /if \(BuildConfig\.DEBUG\) \{\s*invoke\.reject/);
});

test("debug builds use a badged icon without replacing the release icon", () => {
  const icon = read("src-tauri/gen/android/app/src/debug/res/mipmap-anydpi/ic_launcher_dev.xml");
  const badge = read("src-tauri/gen/android/app/src/debug/res/drawable/wave_dev_badge.xml");
  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(debugManifest, /android:icon="@mipmap\/ic_launcher_dev"/);
  assert.match(debugManifest, /android:roundIcon="@mipmap\/ic_launcher_dev"/);
  assert.match(icon, /@mipmap\/ic_launcher/);
  assert.match(icon, /@drawable\/wave_dev_badge/);
  assert.match(badge, /android:fillColor="#FFB74D"/);
});
