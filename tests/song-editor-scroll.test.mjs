import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const mocks = {
  "../lib/audio": "export const assetUrl = (path) => path;",
  "../lib/device": 'export const device = () => "desktop";',
  "../lib/ipc": "export const loadLyrics = async () => null; export const editorWaveform = async () => [];",
  "../lib/motion": "export const reduceMotionActive = () => true;",
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
    this.style = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.clientWidth = 100;
    this.clientHeight = 100;
    this.scrollLeft = 0;
    this.textContent = "";
    this.hidden = false;
    this.dataset = {};
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) ?? [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
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
  getBoundingClientRect() { return { left: 0 }; }
  getContext() { return null; }
  focus() {}
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

test("manual timeline navigation does not fight playback and seeking restores follow", async () => {
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
  globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };

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
});
