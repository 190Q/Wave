import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { inflateSync } from "node:zlib";

const android = new URL("../src-tauri/gen/android/app/src/main/", import.meta.url);
const densities = [
  ["mdpi", 48],
  ["hdpi", 72],
  ["xhdpi", 96],
  ["xxhdpi", 144],
  ["xxxhdpi", 192],
];

test("Android uses the same non-adaptive launcher icon for standard and round icons", () => {
  const manifest = readFileSync(new URL("AndroidManifest.xml", android), "utf8");
  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher"/);
  assert.equal(existsSync(new URL("res/mipmap-anydpi-v26/ic_launcher.xml", android)), false);
  assert.equal(existsSync(new URL("res/mipmap-anydpi-v26/ic_launcher_round.xml", android)), false);
});

test("Android launcher icons have a transparent background at every density", () => {
  for (const [density, size] of densities) {
    const png = readFileSync(new URL(`res/mipmap-${density}/ic_launcher.png`, android));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.equal(png[24], 8);
    assert.equal(png[25], 6);

    const chunks = [];
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      const type = png.toString("ascii", offset + 4, offset + 8);
      if (type === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    const pixels = inflateSync(Buffer.concat(chunks));
    for (let x = 0; x < size; x += 1) {
      assert.equal(pixels[1 + x * 4 + 3], 0, `${density} top edge must be transparent`);
    }
  }
});
