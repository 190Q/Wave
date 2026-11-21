import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const mocks = {
  "../lib/audio": "export const assetUrl = (path) => path;",
  "../lib/device": 'export const device = () => "desktop";',
  "../lib/ipc": "export const loadLyrics = async () => globalThis.__songEditorTest.lyrics ?? null; export const editorWaveform = async () => [];",
  "../lib/motion": "export const reduceMotionActive = () => globalThis.__songEditorTest.reducedMotion ?? true;",
  "../lib/state": `
    export const getState = () => globalThis.__songEditorTest.state;
    export const player = { pause() {}, finishTransitions() {} };
    export const connectPreviewAudio = () => () => {};
    export const previewAudioPath = () => "audio";
    export const previewStagedAudioPath = () => "audio";
    export const saveEditedSong = async () => {};
  `,
  "./icons": "export const fillIcons = () => {};",
  "./popups": "export const claimPopup = () => {}; export const releasePopup = () => {};",
  "./song-editor-markup": "export const createSongEditor = () => globalThis.__songEditorTest.modal;",
};

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: "song-editor-scroll-test-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /[\\/]src[\\/]ui[\\/]song-editor\.ts$/.test(importer) && source in mocks) {
        return `\0song-editor-scroll-test:${source}`;
      }
    },
    load(id) {
      if (id.startsWith("\0song-editor-scroll-test:")) return mocks[id.slice("\0song-editor-scroll-test:".length)];
    },
  }],
});
after(() => vite.close());
const { openSongEditor } = await vite.ssrLoadModule("/src/ui/song-editor.ts");

class Element {
  constructor() {
    this.listeners = new Map();
    this.style = {
      setProperty(name, value) { this[name] = value; },
      removeProperty(name) { delete this[name]; },
    };
    const classes = new Set();
    this.classList = {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, on = !classes.has(name)) {
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    };
    this.clientWidth = 100;
    this.clientHeight = 100;
    this.scrollLeft = 0;
    this.scrollTop = 0;
    this.scrollCalls = [];
    this.textContent = "";
    this.hidden = false;
    this.dataset = {};
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== callback));
  }

  dispatch(type, values = {}) {
    const event = {
      target: this, button: 0, deltaX: 0, deltaY: 0, ctrlKey: false, shiftKey: false,
      clientX: 0, preventDefault() {}, stopPropagation() {}, ...values,
    };
    for (const callback of this.listeners.get(type) ?? []) callback(event);
  }

  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  contains() { return false; }
  getBoundingClientRect() { return { left: 0 }; }
  getContext() { return null; }
  focus() {}
  scrollTo(options) {
    this.scrollCalls.push(options);
    this.scrollTop = options.top;
  }
}

class Audio extends Element {
  constructor() {
    super();
    this.duration = 120;
    this.currentTime = 0;
    this.paused = true;
    globalThis.__songEditorTest.audio = this;
  }

  play() {
    this.paused = false;
    this.dispatch("play");
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.dispatch("pause");
  }

  load() {}
  removeAttribute() {}
}

test("song editor timeline navigation and lyric selection", async (t) => {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const viewport = element("viewport");
  element("timeline-inner").getBoundingClientRect = () => ({ left: -viewport.scrollLeft });
  const modal = new Element();
  modal.hidden = true;
  modal.querySelector = (selector) => selector.startsWith("#song-editor-")
    ? element(selector.slice("#song-editor-".length)) : new Element();
  const track = { id: "track", path: "audio", title: "Song", artist: "Artist", durationMs: 120000 };
  globalThis.__songEditorTest = { modal, state: { tracksById: new Map([[track.id, track]]) } };
  globalThis.Audio = Audio;
  globalThis.HTMLInputElement = class extends Element {
    blur() { globalThis.document.activeElement = null; }
  };
  globalThis.document = { activeElement: null };
  const windowEvents = new Element();
  globalThis.window = {
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    devicePixelRatio: 1,
  };

  const frames = new Map();
  let frameId = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const advance = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback();
  };

  openSongEditor(track.id);
  await Promise.resolve();
  const audio = globalThis.__songEditorTest.audio;
  element("play").dispatch("click");
  audio.currentTime = 9;
  advance();
  assert.equal(viewport.scrollLeft, 70);

  viewport.dispatch("wheel", { shiftKey: true, deltaY: 200 });
  audio.currentTime = 10;
  advance();
  assert.equal(viewport.scrollLeft, 270);
  viewport.dispatch("wheel", { shiftKey: true, deltaY: -100 });
  advance();
  assert.equal(viewport.scrollLeft, 170);

  element("ruler").dispatch("pointerdown", { clientX: 50 });
  audio.currentTime = 30;
  advance();
  assert.equal(viewport.scrollLeft, 280);

  viewport.dispatch("pointerdown", { button: 1 });
  viewport.scrollLeft = 400;
  advance();
  assert.equal(viewport.scrollLeft, 400);
  viewport.scrollLeft = 150;
  advance();
  assert.equal(viewport.scrollLeft, 150);

  element("ruler").dispatch("pointerdown", { clientX: 50 });
  viewport.dispatch("wheel", { deltaX: 100 });
  viewport.scrollLeft += 100;
  advance();
  assert.equal(viewport.scrollLeft, 250);

  element("play").dispatch("click");
  viewport.dispatch("wheel", { shiftKey: true, deltaY: 30 });
  element("play").dispatch("click");
  advance();
  assert.equal(viewport.scrollLeft, 280);

  element("ruler").dispatch("pointerdown", { clientX: 98 });
  viewport.dispatch("wheel", { ctrlKey: true, deltaY: -100, clientX: 0 });
  const zoomedPosition = viewport.scrollLeft;
  advance();
  assert.equal(viewport.scrollLeft, zoomedPosition);

  openSongEditor(track.id);
  await Promise.resolve();
  const reopenedAudio = globalThis.__songEditorTest.audio;
  element("play").dispatch("click");
  reopenedAudio.currentTime = 9;
  advance();
  assert.equal(viewport.scrollLeft, 70);

  await t.test("one highlight follows active lyrics and respects reduced motion", async () => {
    globalThis.__songEditorTest.lyrics = "[00:01.000]First\n[00:02.000]Second\n[00:03.000]Third";
    openSongEditor(track.id);
    await Promise.resolve();
    globalThis.__songEditorTest.reducedMotion = false;

    const lines = element("lines");
    const content = element("lines-content");
    lines.scrollTop = 0;
    lines.scrollCalls = [];
    lines.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100 });
    globalThis.getComputedStyle = () => ({ height: "200px" });
    const rows = [0, 120, 240].map((top, index) => {
      const row = new Element();
      row.dataset.line = String(index);
      row.offsetTop = top;
      row.offsetHeight = 40;
      row.classList.toggle = (name, on) => { if (name === "is-active") row.active = on; };
      row.getBoundingClientRect = () => ({
        top: (top - lines.scrollTop) / 2,
        bottom: (top + 40 - lines.scrollTop) / 2,
      });
      return row;
    });
    lines.querySelectorAll = (selector) => selector === "[data-line]" ? rows : [];
    const audio = globalThis.__songEditorTest.audio;

    audio.currentTime = 1;
    audio.dispatch("timeupdate");
    assert.equal(rows[0].active, true);
    assert.equal(content.classList.contains("is-highlighted"), true);
    assert.equal(content.style["--lyric-highlight-top"], "0px");
    assert.equal(content.style["--lyric-highlight-height"], "40px");
    assert.deepEqual(lines.scrollCalls.at(-1), { top: 0, behavior: "smooth" });

    audio.currentTime = 3;
    audio.dispatch("timeupdate");
    assert.equal(rows[0].active, false);
    assert.equal(rows[2].active, true);
    assert.equal(content.classList.contains("is-highlighted"), true);
    assert.equal(content.style["--lyric-highlight-top"], "240px");
    assert.deepEqual(lines.scrollCalls.at(-1), { top: 80, behavior: "smooth" });
    const calls = lines.scrollCalls.length;
    audio.dispatch("timeupdate");
    assert.equal(lines.scrollCalls.length, calls);

    rows[2].offsetTop = 250;
    rows[2].offsetHeight = 50;
    windowEvents.dispatch("resize");
    assert.equal(content.style["--lyric-highlight-top"], "250px");
    assert.equal(content.style["--lyric-highlight-height"], "50px");

    element("shift-forward").dispatch("click");
    assert.equal(content.classList.contains("is-highlighted"), true);
    assert.equal(content.style["--lyric-highlight-top"], "120px");
    element("undo").dispatch("click");
    assert.equal(content.classList.contains("is-highlighted"), true);
    assert.equal(content.style["--lyric-highlight-top"], "250px");

    globalThis.__songEditorTest.reducedMotion = true;
    audio.currentTime = 1;
    audio.dispatch("timeupdate");
    assert.equal(content.style["--lyric-highlight-top"], "0px");
    assert.deepEqual(lines.scrollCalls.at(-1), { top: 0, behavior: "instant" });
    audio.currentTime = 0;
    audio.dispatch("timeupdate");
    assert.deepEqual(lines.scrollCalls.at(-1), { top: 0, behavior: "instant" });
    assert.equal(rows[0].active, false);
    assert.equal(content.classList.contains("is-highlighted"), false);
    assert.equal(content.style["--lyric-highlight-top"], undefined);

    globalThis.__songEditorTest.reducedMotion = false;
    audio.currentTime = 3;
    audio.dispatch("timeupdate");
    assert.equal(content.classList.contains("is-highlighted"), true);
    assert.equal(content.style["--lyric-highlight-top"], "250px");
    globalThis.__songEditorTest.reducedMotion = true;

    lines.querySelectorAll = () => [];
  });

  await t.test("lyric selection clears outside its fields and timeline chip", async () => {
    globalThis.__songEditorTest.lyrics = "[00:01.000]First\n[00:02.000]Second";
    openSongEditor(track.id);
    await Promise.resolve();

    const lines = element("lines");
    const lyricTrack = element("lyric-track");
    const input = new HTMLInputElement();
    input.dataset.lyricText = "0";
    input.value = "Edited";
    input.closest = (selector) => selector === "[data-lyric-time], [data-lyric-text]" ? input : null;
    lines.contains = (target) => target === input;
    const selected = () => lyricTrack.innerHTML.match(/song-editor-chip is-selected"\s+data-chip="(\d+)"/)?.[1] ?? null;

    document.activeElement = input;
    lines.dispatch("focusin", { target: input });
    lines.dispatch("input", { target: input });
    assert.equal(selected(), "0");
    modal.dispatch("pointerdown", { target: input });
    assert.equal(selected(), "0");
    assert.equal(document.activeElement, input);

    modal.dispatch("pointerdown", { target: new Element() });
    assert.equal(selected(), null);
    assert.equal(document.activeElement, null);

    document.activeElement = input;
    lines.dispatch("focusin", { target: input });
    modal.dispatch("pointerdown", { target: element("wave-track") });
    assert.equal(selected(), null);
    assert.equal(document.activeElement, null);

    document.activeElement = input;
    lines.dispatch("focusin", { target: input });
    const chip = new Element();
    chip.dataset.chip = "1";
    chip.closest = (selector) => selector === "[data-chip]" ? chip : null;
    modal.dispatch("pointerdown", { target: chip });
    lyricTrack.dispatch("pointerdown", { target: chip, pointerId: 1 });
    windowEvents.dispatch("pointerup", { pointerId: 1 });
    assert.equal(selected(), "1");
    assert.equal(document.activeElement, null);

    modal.dispatch("pointerdown", { target: chip });
    assert.equal(selected(), "1");
    modal.dispatch("pointerdown", { target: input });
    assert.equal(selected(), null);
    document.activeElement = input;
    lines.dispatch("focusin", { target: input });
    assert.equal(selected(), "0");
    modal.dispatch("pointerdown", { target: element("play") });
    assert.equal(selected(), null);
  });
});
