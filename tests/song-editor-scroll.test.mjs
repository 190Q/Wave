import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const mocks = {
  "../lib/audio": "export const assetUrl = (path) => path;",
  "../lib/device": 'export const device = () => "desktop";',
  "../lib/ipc": `
    export const loadLyrics = async () => globalThis.__songEditorTest.lyrics ?? null;
    export const editorWaveform = async (id, path) => {
      globalThis.__songEditorTest.waveforms.push([id, path]);
      return globalThis.__songEditorTest.wavePeaks ?? [];
    };
    export const pickEditorAudio = async () => "replacement.wav";
    export const stageEditorAudio = async () => "staged.wav";
    export const discardEditorAudio = async (path) => globalThis.__songEditorTest.discarded.push(path);
    export const renderEditorCuts = async (id, path, cuts) => {
      const state = globalThis.__songEditorTest;
      state.renders.push(structuredClone([id, path, cuts]));
      if (state.renderGate) await state.renderGate;
      if (state.renderFailure) throw new Error(state.renderFailure);
      const output = "cut-" + ++state.renderSerial + ".flac";
      state.durations.set(output, (state.durations.get(path ?? "audio") ?? 120)
        - cuts.reduce((total, cut) => total + (cut.endMs - cut.startMs) / 1000, 0));
      return output;
    };
  `,
  "../lib/motion": "export const reduceMotionActive = () => globalThis.__songEditorTest.reducedMotion ?? true;",
  "../lib/state": `
    export const getState = () => globalThis.__songEditorTest.state;
    export const player = { pause() {}, finishTransitions() {} };
    export const connectPreviewAudio = () => () => {};
    export const previewAudioPath = () => "audio";
    export const previewStagedAudioPath = (path) => path;
    export const saveEditedSong = async (...args) => globalThis.__songEditorTest.saves.push(structuredClone(args));
  `,
  "./icons": "export const fillIcons = () => {};",
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
const { mountConfirm } = await vite.ssrLoadModule("/src/ui/confirm.ts");
const { claimPopup, dismissPopup, releasePopup } = await vite.ssrLoadModule("/src/ui/popups.ts");

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
    this.open = false;
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
  showModal() { this.open = true; }
  close() { this.open = false; }
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

  set src(path) {
    this.path = path;
    this.actualDuration = globalThis.__songEditorTest.durations.get(path) ?? 120;
    this.duration = globalThis.__songEditorTest.deferMetadata ? NaN : this.actualDuration;
    this.readyState = globalThis.__songEditorTest.deferMetadata ? 0 : 1;
  }

  get src() { return this.path; }
  getAttribute(name) { return name === "src" ? this.path : null; }
  load() { if (this.path && !globalThis.__songEditorTest.deferMetadata) this.dispatch("loadedmetadata"); }
  finishMetadata() {
    this.duration = this.actualDuration;
    this.readyState = 1;
    this.dispatch("loadedmetadata");
  }
  removeAttribute(name) { if (name === "src") this.path = ""; }
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
  globalThis.__songEditorTest = {
    modal, discarded: [], saves: [], renders: [], waveforms: [], renderSerial: 0,
    durations: new Map([["audio", 120], ["staged.wav", 120]]),
    state: { tracksById: new Map([[track.id, track]]) },
  };
  globalThis.Audio = Audio;
  globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
  globalThis.HTMLInputElement = class extends Element {
    blur() { globalThis.document.activeElement = null; }
  };
  globalThis.HTMLTextAreaElement = class extends Element {};
  globalThis.HTMLButtonElement = class extends Element {
    hasAttribute(name) { return name === "data-lyric-shift"; }
    dispatchEvent(event) { this.dispatch(event.type, { shiftKey: event.shiftKey }); }
    click() { if (!this.disabled) this.dispatch("click"); }
  };
  globalThis.MouseEvent = class {
    constructor(type, options) { this.type = type; Object.assign(this, options); }
  };
  for (const id of ["shift-from-back", "shift-from-forward"]) {
    elements.set(id, new HTMLButtonElement());
  }
  const confirmElements = Object.fromEntries([
    "confirm-dialog", "confirm-title", "confirm-message", "confirm-cancel", "confirm-accept",
  ].map((id) => [id, new Element()]));
  globalThis.document = {
    activeElement: null,
    getElementById: (id) => confirmElements[id] ?? null,
  };
  const windowEvents = new Element();
  let timerId = 0;
  const timers = new Map();
  globalThis.window = {
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    devicePixelRatio: 1,
  };
  const flushTimers = (delay) => {
    for (const [id, timer] of [...timers]) {
      if (timer.delay !== delay) continue;
      timers.delete(id);
      timer.callback();
    }
  };
  const settle = () => new Promise(setImmediate);
  mountConfirm();

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
    const close = element("close");
    close.closest = (selector) => selector === "#song-editor-close, [data-shift-from]" ? close : null;
    modal.dispatch("pointerdown", { target: close });
    assert.equal(selected(), "0");
    assert.equal(document.activeElement, input);
    modal.dispatch("pointerdown", { target: element("play") });
    assert.equal(selected(), null);
  });

  await t.test("discard confirmation preserves edits until explicitly accepted", async () => {
    element("undo").dispatch("click");
    globalThis.__songEditorTest.lyrics = "[00:01.000]Original";
    openSongEditor(track.id);
    await settle();

    const input = new HTMLInputElement();
    input.dataset.lyricText = "0";
    input.value = "Edited";
    element("lines").dispatch("input", { target: input });
    element("add-line").dispatch("click");
    element("import-audio").dispatch("click");
    await settle();
    assert.equal(element("save").disabled, false);
    assert.equal(element("source").textContent, "Replacement: replacement.wav");
    assert.match(element("lines-content").innerHTML, /Edited/);

    const dialog = confirmElements["confirm-dialog"];
    const cancel = confirmElements["confirm-cancel"];
    const accept = confirmElements["confirm-accept"];
    let audio = globalThis.__songEditorTest.audio;
    element("play").dispatch("click");
    let lines = element("lines-content").innerHTML;
    const assertUnchanged = () => {
      assert.equal(modal.hidden, false);
      assert.equal(element("lines-content").innerHTML, lines);
      assert.equal(element("source").textContent, "Replacement: replacement.wav");
      assert.equal(element("save").disabled, false);
      assert.equal(globalThis.__songEditorTest.audio, audio);
      assert.equal(audio.paused, false);
      assert.deepEqual(globalThis.__songEditorTest.discarded, []);
    };
    const finishDialog = async () => {
      flushTimers(220);
      await settle();
    };

    element("close").dispatch("click");
    assert.equal(dialog.open, true);
    assert.equal(confirmElements["confirm-title"].textContent, "Discard unsaved changes?");
    assert.equal(cancel.textContent, "Cancel");
    assert.equal(accept.textContent, "Discard");
    assert.equal(accept.classList.contains("pill-danger"), true);
    assertUnchanged();
    element("close").dispatch("click");
    cancel.dispatch("click");
    await finishDialog();
    assert.equal(dialog.open, false);
    assertUnchanged();

    let prevented = false;
    windowEvents.dispatch("keydown", {
      key: "Escape", preventDefault() { prevented = true; }, stopImmediatePropagation() {},
    });
    assert.equal(prevented, true);
    assert.equal(dialog.open, true);
    prevented = false;
    windowEvents.dispatch("keydown", {
      key: "Escape", preventDefault() { prevented = true; }, stopImmediatePropagation() {},
    });
    assert.equal(prevented, false);
    dialog.dispatch("cancel", { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    await finishDialog();
    assertUnchanged();

    element("close").dispatch("click");
    let stopped = false;
    dialog.dispatch("keydown", { stopPropagation() { stopped = true; } });
    assert.equal(stopped, true);
    dialog.dispatch("click");
    await finishDialog();
    assertUnchanged();

    openSongEditor(track.id);
    assert.equal(dialog.open, true);
    cancel.dispatch("click");
    await finishDialog();
    assertUnchanged();

    element("undo").dispatch("click");
    assert.equal(element("source").textContent, "Library audio");
    element("redo").dispatch("click");
    audio = globalThis.__songEditorTest.audio;
    element("play").dispatch("click");
    lines = element("lines-content").innerHTML;
    assertUnchanged();

    let otherDismissals = 0;
    const otherPopup = () => { otherDismissals += 1; };
    claimPopup(otherPopup);
    assertUnchanged();
    prevented = false;
    windowEvents.dispatch("keydown", {
      key: "Escape", preventDefault() { prevented = true; }, stopImmediatePropagation() {},
    });
    assert.equal(prevented, false);
    assert.equal(dialog.open, false);
    releasePopup(otherPopup);

    element("close").dispatch("click");
    claimPopup(otherPopup);
    await finishDialog();
    assert.equal(otherDismissals, 0);
    assertUnchanged();
    dismissPopup();
    assert.equal(otherDismissals, 1);
    releasePopup(otherPopup);

    element("close").dispatch("click");
    accept.dispatch("click");
    assertUnchanged();
    await finishDialog();
    await settle();
    assert.equal(modal.hidden, true);
    assert.equal(audio.paused, true);
    assert.deepEqual(globalThis.__songEditorTest.discarded, ["staged.wav"]);

    openSongEditor(track.id);
    await settle();
    element("close").dispatch("click");
    assert.equal(modal.hidden, true);
    assert.equal(dialog.open, false);
  });

  await t.test("shift from the selected line leaves earlier lyrics unchanged", async () => {
    globalThis.__songEditorTest.lyrics = "[00:01.000]Before\n[00:02.000]Selected\nUntimed\n[00:03.000]After\n[00:00.050]Low";
    openSongEditor(track.id);
    await settle();

    const lines = element("lines");
    const back = element("shift-from-back");
    const forward = element("shift-from-forward");
    const times = () => [...element("lines-content").innerHTML.matchAll(/data-lyric-time="\d+"[^>]*value="([^"]*)"/g)]
      .map((match) => match[1]);
    const original = ["00:01.000", "00:02.000", "", "00:03.000", "00:00.050"];
    assert.deepEqual(times(), original);
    assert.equal(back.disabled, true);
    assert.equal(forward.disabled, true);
    back.dispatch("click");
    assert.deepEqual(times(), original);

    const rows = original.map((_, index) => {
      const row = new Element();
      row.dataset.line = String(index);
      row.offsetTop = index * 40;
      row.offsetHeight = 40;
      row.getBoundingClientRect = () => ({ top: index * 40, bottom: index * 40 + 40 });
      return row;
    });
    lines.querySelectorAll = (selector) => selector === "[data-line]" ? rows : [];
    const input = new HTMLInputElement();
    input.dataset.lyricText = "1";
    lines.dispatch("focusin", { target: input });
    assert.equal(back.disabled, false);
    assert.equal(forward.disabled, false);
    assert.equal(rows[1].classList.contains("is-selected"), true);
    assert.equal(rows[0].classList.contains("is-selected"), false);

    back.closest = (selector) => selector === "#song-editor-close, [data-shift-from]" ? back : null;
    modal.dispatch("pointerdown", { target: back });
    back.dispatch("click");
    assert.deepEqual(times(), ["00:01.000", "00:01.900", "", "00:02.900", "00:00.000"]);
    assert.match(element("lines-content").innerHTML, /song-editor-line is-selected" data-line="1"/);
    assert.equal(back.disabled, false);

    forward.dispatch("click", { shiftKey: true });
    assert.deepEqual(times(), ["00:01.000", "00:02.400", "", "00:03.400", "00:00.500"]);
    let prevented = false;
    windowEvents.dispatch("keydown", {
      target: back, key: "Enter", code: "Enter", shiftKey: true,
      preventDefault() { prevented = true; },
    });
    assert.equal(prevented, true);
    assert.deepEqual(times(), ["00:01.000", "00:01.900", "", "00:02.900", "00:00.000"]);
    windowEvents.dispatch("keydown", { target: forward, key: " ", code: "Space", shiftKey: true });
    assert.deepEqual(times(), ["00:01.000", "00:02.400", "", "00:03.400", "00:00.500"]);
    windowEvents.dispatch("keydown", { target: back, key: " ", code: "Space", shiftKey: true });
    assert.deepEqual(times(), ["00:01.000", "00:01.900", "", "00:02.900", "00:00.000"]);
    windowEvents.dispatch("keydown", { target: back, key: " ", code: "Space", shiftKey: true, repeat: true });
    assert.deepEqual(times(), ["00:01.000", "00:01.900", "", "00:02.900", "00:00.000"]);
    forward.dispatch("click");
    assert.deepEqual(times(), ["00:01.000", "00:02.000", "", "00:03.000", "00:00.100"]);

    let reported = false;
    lines.querySelector = (selector) => selector === "input:invalid"
      ? { reportValidity() { reported = true; } } : null;
    back.dispatch("click");
    assert.equal(reported, true);
    assert.deepEqual(times(), ["00:01.000", "00:02.000", "", "00:03.000", "00:00.100"]);
    lines.querySelector = () => null;

    element("undo").dispatch("click");
    assert.deepEqual(times(), ["00:01.000", "00:01.900", "", "00:02.900", "00:00.000"]);
    assert.equal(back.disabled, true);
    element("redo").dispatch("click");
    assert.deepEqual(times(), ["00:01.000", "00:02.000", "", "00:03.000", "00:00.100"]);

    const chip = new Element();
    chip.dataset.chip = "3";
    chip.closest = (selector) => selector === "[data-chip]" ? chip : null;
    element("lyric-track").dispatch("pointerdown", { target: chip, pointerId: 1 });
    windowEvents.dispatch("pointerup", { pointerId: 1 });
    assert.equal(back.disabled, false);
    back.dispatch("click", { shiftKey: true });
    assert.deepEqual(times(), ["00:01.000", "00:02.000", "", "00:02.500", "00:00.000"]);

    input.dataset.lyricText = "2";
    lines.dispatch("focusin", { target: input });
    forward.dispatch("click");
    assert.deepEqual(times(), ["00:01.000", "00:02.000", "", "00:02.600", "00:00.100"]);
    input.dataset.lyricText = "4";
    lines.dispatch("focusin", { target: input });
    back.dispatch("click");
    assert.deepEqual(times(), ["00:01.000", "00:02.000", "", "00:02.600", "00:00.000"]);

    modal.dispatch("pointerdown", { target: element("play") });
    assert.equal(back.disabled, true);
    assert.equal(forward.disabled, true);
    lines.querySelectorAll = () => [];
  });

  await t.test("audio cuts leave existing lyrics untouched and retain explicit lyric edits", async () => {
    element("close").dispatch("click");
    confirmElements["confirm-accept"].dispatch("click");
    flushTimers(220);
    await settle();
    assert.equal(modal.hidden, true);

    const addCut = async (start, end) => {
      element("cut-start").value = start;
      element("cut-end").value = end;
      element("add-cut").dispatch("click");
      await settle();
    };
    const original = "[ar:Singer]\r\n[offset:250]\r\n[00:01.25]Before\r\n[00:03.25][00:08.25]Repeated\r\n";
    globalThis.__songEditorTest.lyrics = original;
    openSongEditor(track.id);
    await settle();
    const before = element("lines-content").innerHTML;
    const chipPositions = () => [...element("lyric-track").innerHTML.matchAll(/data-chip="\d+" style="left:([\d.]+)px/g)]
      .map((match) => Number(match[1]));
    const chips = chipPositions();
    await addCut("00:02.000", "00:04.000");
    await addCut("00:06.000", "00:07.000");
    assert.equal(element("lines-content").innerHTML, before);
    chipPositions().forEach((position, index) => assert.ok(Math.abs(position - chips[index]) < 0.001));
    const cutAudio = globalThis.__songEditorTest.audio.src;
    element("save").dispatch("click");
    await settle();
    assert.deepEqual(globalThis.__songEditorTest.saves.pop(), [
      track.id, track.path, original, null, cutAudio, [],
    ]);
    assert.equal(modal.hidden, true);

    const lyrics = "[00:01.000]Before\n[00:03.000]Inside\n[00:08.000]After\nUntimed\n";
    globalThis.__songEditorTest.lyrics = lyrics;
    openSongEditor(track.id);
    await settle();
    const input = new HTMLInputElement();
    input.dataset.lyricText = "1";
    input.value = "Edited";
    element("lines").dispatch("input", { target: input });
    element("shift-forward").dispatch("click");
    element("import-audio").dispatch("click");
    await settle();
    await addCut("00:02.000", "00:04.000");
    await addCut("00:06.000", "00:07.000");
    const replacementCutAudio = globalThis.__songEditorTest.audio.src;
    assert.deepEqual(globalThis.__songEditorTest.renders.slice(-2).map((render) => render[1]), ["staged.wav", "staged.wav"]);
    element("save").dispatch("click");
    await settle();
    assert.deepEqual(globalThis.__songEditorTest.saves.pop(), [
      track.id, track.path, lyrics,
      "[00:01.100]Before\n[00:03.100]Edited\n[00:08.100]After\nUntimed\n",
      replacementCutAudio, [],
    ]);
    assert.equal(modal.hidden, true);

    globalThis.__songEditorTest.lyrics = null;
    openSongEditor(track.id);
    await settle();
    await addCut("00:02.000", "00:04.000");
    const cutWithoutLyrics = globalThis.__songEditorTest.audio.src;
    element("save").dispatch("click");
    await settle();
    assert.deepEqual(globalThis.__songEditorTest.saves.pop(), [
      track.id, track.path, null, null, cutWithoutLyrics, [],
    ]);
    assert.equal(modal.hidden, true);
  });

  await t.test("cuts change playback and waveform immediately and can be restored independently", async () => {
    const state = globalThis.__songEditorTest;
    state.discarded = [];
    state.renders = [];
    state.waveforms = [];
    state.wavePeaks = [0.5, 0.8];
    state.lyrics = "[00:03.000]Early\n[01:59.000]Late";
    openSongEditor(track.id);
    await settle();

    const addCut = async (start, end) => {
      element("cut-start").value = start;
      element("cut-end").value = end;
      element("add-cut").dispatch("click");
      await settle();
    };
    const restoreCut = async (index) => {
      const button = new Element();
      button.dataset.removeCut = String(index);
      button.closest = () => button;
      element("cuts").dispatch("click", { target: button });
      await settle();
    };
    const before = element("lines-content").innerHTML;
    let releaseRender;
    state.renderGate = new Promise((resolve) => { releaseRender = resolve; });
    const originalAudio = state.audio;
    originalAudio.currentTime = 10;
    element("play").dispatch("click");
    element("cut-start").value = "00:02.000";
    element("cut-end").value = "00:04.000";
    element("add-cut").dispatch("click");
    await Promise.resolve();
    assert.equal(element("save").disabled, true);
    assert.equal(element("wave-status").textContent, "Cutting audio...");
    element("close").dispatch("click");
    assert.equal(modal.hidden, false);
    state.deferMetadata = true;
    releaseRender();
    await settle();
    state.renderGate = null;
    state.deferMetadata = false;

    const first = state.audio.src;
    assert.notEqual(first, "audio");
    assert.equal(element("duration").textContent, "01:58.000");
    assert.equal(element("position").textContent, "00:08.000");
    state.deferMetadata = true;
    state.audio.dispatch("error");
    state.deferMetadata = false;
    assert.equal(state.audio.src, first);
    assert.equal(state.audio.crossOrigin, null);
    assert.equal(element("position").textContent, "00:08.000");
    element("ruler").dispatch("pointerdown", { clientX: 70 });
    assert.equal(element("position").textContent, "00:07.000");
    state.audio.finishMetadata();
    assert.equal(state.audio.currentTime, 7);
    assert.equal(state.audio.paused, false);
    assert.equal(element("duration").textContent, "01:58.000");
    assert.deepEqual(state.waveforms.at(-1), [track.id, first]);
    assert.deepEqual(state.renders[0], [track.id, null, [{ startMs: 2000, endMs: 4000 }]]);
    assert.equal(element("lines-content").innerHTML, before);
    assert.match(element("lyric-track").innerHTML, /data-chip="1" style="left:1190px/);
    const bars = [];
    element("wave").getContext = () => ({
      setTransform() {}, clearRect() { bars.length = 0; },
      fillRect(x) { bars.push(x); },
    });
    viewport.scrollLeft = 1160;
    viewport.dispatch("scroll");
    assert.ok(bars.length > 0);
    assert.ok(bars.every((x) => x < 20));
    viewport.scrollLeft = 0;
    state.audio.currentTime = 2.5;
    advance();
    assert.equal(state.audio.currentTime, 2.5);

    state.renderFailure = "Rendering failed";
    await addCut("00:10.000", "00:11.000");
    assert.equal(element("error").textContent, "Rendering failed");
    assert.equal(state.audio.src, first);
    assert.equal(state.audio.paused, false);
    assert.equal(element("duration").textContent, "01:58.000");
    state.renderFailure = null;

    await addCut("00:01.000", "00:03.000");
    const second = state.audio.src;
    assert.equal(element("duration").textContent, "01:56.000");
    assert.deepEqual(state.renders.at(-1), [track.id, null, [
      { startMs: 2000, endMs: 4000 },
      { startMs: 1000, endMs: 2000 },
      { startMs: 4000, endMs: 5000 },
    ]]);
    assert.equal(element("lines-content").innerHTML, before);

    await restoreCut(0);
    const restored = state.audio.src;
    assert.equal(element("duration").textContent, "01:58.000");
    assert.deepEqual(state.renders.at(-1), [track.id, null, [
      { startMs: 1000, endMs: 2000 }, { startMs: 4000, endMs: 5000 },
    ]]);
    element("undo").dispatch("click");
    assert.equal(state.audio.src, second);
    assert.equal(element("duration").textContent, "01:56.000");
    element("redo").dispatch("click");
    assert.equal(state.audio.src, restored);
    await restoreCut(0);
    assert.equal(state.audio.src, "audio");
    assert.equal(element("duration").textContent, "02:00.000");
    assert.equal(element("save").disabled, true);
    element("close").dispatch("click");
    await settle();
    assert.equal(modal.hidden, true);
    assert.deepEqual(new Set(state.discarded), new Set([first, second, restored]));
    element("wave").getContext = () => null;
    state.wavePeaks = null;
  });
});
