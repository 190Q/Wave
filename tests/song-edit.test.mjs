import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
});
after(() => vite.close());
const {
  readEditableLyrics, writeEditableLyrics, parseEditTime, formatEditTime, validateCuts,
  sourceCutRanges, sourceTime, editedTime,
} = await vite.ssrLoadModule("/src/lib/song-edit.ts");
const { EditHistory } = await vite.ssrLoadModule("/src/lib/edit-history.ts");

test("LRC metadata, offsets, repeated timestamps and untimed lines survive editing", () => {
  const lyrics = readEditableLyrics("[ar:Singer]\n[offset:500]\n[00:02.00][00:04.5]Hello\n[00:05.00]\nUntimed");
  assert.deepEqual(lyrics.metadata, ["[ar:Singer]"]);
  assert.deepEqual(lyrics.lines, [
    { timeMs: 1500, text: "Hello" },
    { timeMs: 4000, text: "Hello" },
    { timeMs: 4500, text: "" },
    { timeMs: null, text: "Untimed" },
  ]);
  assert.equal(writeEditableLyrics(lyrics), "[ar:Singer]\n[00:01.500]Hello\n[00:04.000]Hello\n[00:04.500]\nUntimed\n");
});

test("time input accepts fractions and rejects malformed or out-of-range seconds", () => {
  assert.equal(parseEditTime("01:02.5"), 62500);
  assert.equal(parseEditTime("1:02:05"), 62050);
  assert.equal(parseEditTime("0:00"), 0);
  assert.equal(parseEditTime("1:60"), null);
  assert.equal(parseEditTime("-1:00"), null);
  assert.equal(parseEditTime("words"), null);
  assert.equal(formatEditTime(62501), "01:02.501");
});

test("cuts cannot overlap, exceed the audio, or remove it entirely", () => {
  assert.equal(validateCuts([{ startMs: 100, endMs: 300 }, { startMs: 500, endMs: 700 }], 1000), null);
  assert.ok(validateCuts([{ startMs: 100, endMs: 400 }, { startMs: 300, endMs: 500 }], 1000));
  assert.ok(validateCuts([{ startMs: 100, endMs: 1200 }], 1000));
  assert.ok(validateCuts([{ startMs: 0, endMs: 1000 }], 1000));
});

test("selections on shortened audio map to their surviving source ranges", () => {
  const previous = [{ startMs: 2000, endMs: 4000 }, { startMs: 6000, endMs: 7000 }];
  assert.deepEqual(sourceCutRanges({ startMs: 0, endMs: 1000 }, previous), [{ startMs: 0, endMs: 1000 }]);
  assert.deepEqual(sourceCutRanges({ startMs: 2000, endMs: 3000 }, previous), [{ startMs: 4000, endMs: 5000 }]);
  assert.deepEqual(sourceCutRanges({ startMs: 1000, endMs: 5000 }, previous), [
    { startMs: 1000, endMs: 2000 },
    { startMs: 4000, endMs: 6000 },
    { startMs: 7000, endMs: 8000 },
  ]);
  assert.deepEqual(sourceCutRanges({ startMs: 0, endMs: 2000 }, previous), [{ startMs: 0, endMs: 2000 }]);
  assert.deepEqual(sourceCutRanges({ startMs: 2000, endMs: 3000 }, [
    { startMs: 2000, endMs: 4000 }, { startMs: 4000, endMs: 5000 },
  ]), [{ startMs: 5000, endMs: 6000 }]);
  assert.equal(sourceTime(2000, previous), 4000);
  assert.equal(sourceTime(5000, previous), 8000);
  assert.equal(editedTime(3000, previous), 2000);
  assert.equal(editedTime(8000, previous), 5000);
});

test("cut mapping preserves every selected source sample across existing cuts", () => {
  const length = 10;
  for (let mask = 0; mask < (1 << length) - 1; mask += 1) {
    const cuts = [];
    for (let index = 0; index < length; index += 1) {
      if (!(mask & (1 << index))) continue;
      const previous = cuts.at(-1);
      if (previous?.endMs === index) previous.endMs = index + 1;
      else cuts.push({ startMs: index, endMs: index + 1 });
    }
    const remaining = Array.from({ length }, (_, index) => index)
      .filter((index) => !(mask & (1 << index)));
    for (let start = 0; start < remaining.length; start += 1) {
      for (let end = start + 1; end <= remaining.length; end += 1) {
        const ranges = sourceCutRanges({ startMs: start, endMs: end }, cuts);
        const actual = ranges.flatMap((range) =>
          Array.from({ length: range.endMs - range.startMs }, (_, index) => index + range.startMs));
        assert.deepEqual(actual, remaining.slice(start, end), `mask ${mask}, range ${start}-${end}`);
      }
    }
  }
});

test("writing edited lyrics preserves their timestamps and untimed lines", () => {
  const lyrics = { metadata: [], lines: [
    { timeMs: 1000, text: "Before" },
    { timeMs: 3000, text: "Inside" },
    { timeMs: 8000, text: "After" },
    { timeMs: null, text: "Untimed" },
  ] };
  assert.equal(writeEditableLyrics(lyrics), "[00:01.000]Before\n[00:03.000]Inside\n[00:08.000]After\nUntimed\n");
});

test("undo and redo cover grouped typing, cuts and imported audio without sharing mutations", () => {
  const initial = { text: "Before", cuts: [], audio: null };
  const history = new EditHistory(initial);
  history.record({ ...initial, text: "B" }, "text-0");
  history.record({ ...initial, text: "Better" }, "text-0");
  history.endGroup();
  const cut = { text: "Better", cuts: [{ startMs: 100, endMs: 300 }], audio: null };
  history.record(cut);
  history.record({ ...cut, cuts: [], audio: "staged.wav" });
  cut.cuts[0].endMs = 999;
  assert.equal(history.undo().cuts[0].endMs, 300);
  assert.equal(history.undo().text, "Better");
  assert.equal(history.undo().text, "Before");
  assert.equal(history.undo(), null);
  assert.equal(history.redo().text, "Better");
  assert.equal(history.redo().cuts[0].endMs, 300);
  assert.equal(history.redo().audio, "staged.wav");
  assert.equal(history.redo(), null);
});

test("a new edit after undo clears redo history", () => {
  const history = new EditHistory({ value: 0 }, 2);
  history.record({ value: 1 });
  history.record({ value: 2 });
  assert.equal(history.undo().value, 1);
  history.record({ value: 3 });
  assert.equal(history.canRedo, false);
  assert.equal(history.undo().value, 1);
  assert.equal(history.undo().value, 0);
});

test("shared and phone markup do not contain a desktop editor", async () => {
  for (const file of ["../index.html", "../dev/phone/app.html", "../src/lib/mock/commands.ts"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /song-editor-modal|stage_editor_audio|save_song_edit/);
  }
});

test("the editor timeline hides its scrollbar while remaining scrollable", async () => {
  const css = await readFile(new URL("../src/styles/song-editor.css", import.meta.url), "utf8");
  assert.match(css, /\.song-editor-viewport\s*\{[^}]*overflow-x:\s*auto\s*;/);
  assert.match(css, /\.song-editor-viewport\s*\{[^}]*scrollbar-width:\s*none\s*;/);
  assert.match(css, /\.song-editor-viewport::-webkit-scrollbar\s*\{[^}]*display:\s*none\s*;/);
  assert.match(css, /\.song-editor-timeline-inner\s*\{[^}]*overflow:\s*clip\s*;/);
});

test("compact editor panels keep a bounded scrollable lyrics list", async () => {
  const css = await readFile(new URL("../src/styles/song-editor.css", import.meta.url), "utf8");
  assert.match(css, /\.song-editor-lines\s*\{[^}]*overflow-y:\s*auto\s*;/);
  assert.match(css, /@media \(max-width: 60rem\), \(max-height: 38rem\)[\s\S]*?\.song-editor-lower\s*\{[^}]*grid-auto-rows:\s*minmax\(14rem,\s*18rem\)\s*;/);
});

test("the editor and equaliser use shared panel and button styles", async () => {
  const shared = await readFile(new URL("../src/styles/shared.css", import.meta.url), "utf8");
  const markup = await readFile(new URL("../src/ui/song-editor-markup.ts", import.meta.url), "utf8");
  assert.match(shared, /\.fullscreen-modal,\s*\.eq-modal\s*\{/);
  assert.match(shared, /\.fullscreen-panel,\s*\.eq-panel\s*\{/);
  assert.match(markup, /class="pill icon-only" id="song-editor-close"[^>]*>\s*<span class="btn-icon" data-icon="close">/);
});
