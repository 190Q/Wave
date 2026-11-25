import "../styles/song-editor.css";
import { assetUrl, prepareDirectAudio } from "../lib/audio";
import { device } from "../lib/device";
import { EditHistory } from "../lib/edit-history";
import { escapeHtml } from "../lib/format";
import * as ipc from "../lib/ipc";
import { reduceMotionActive } from "../lib/motion";
import {
  editedTime, formatEditTime, parseEditTime, readEditableLyrics, sourceCutRanges, sourceTime,
  validateCuts, writeEditableLyrics,
  type EditableLyric, type EditableLyrics,
} from "../lib/song-edit";
import {
  connectPreviewAudio, getState, player, previewAudioPath, previewStagedAudioPath, saveEditedSong,
} from "../lib/state";
import type { AudioCut, Track } from "../types";
import { confirmDialog } from "./confirm";
import { fillIcons } from "./icons";
import { closeMenu, openMenu, type MenuItem } from "./menu";
import { claimPopup, claimPopupIfFree, isOtherPopupShowing, releasePopup } from "./popups";
import { createSongEditor } from "./song-editor-markup";

interface EditorSnapshot {
  lyrics: EditorLyrics;
  cuts: EditorCut[];
  stagedAudio: string | null;
  cutAudio: string | null;
  sourceDuration: number;
  source: string;
}

interface EditorLyric extends EditableLyric {
  id: number;
}

interface EditorLyrics extends EditableLyrics {
  lines: EditorLyric[];
}

interface EditorCut extends AudioCut {
  ranges: AudioCut[];
  lyricRanges: AudioCut[];
  withLyrics: boolean;
  removedLyrics: { line: EditorLyric; sourceMs: number }[];
}

let openEditor: ((id: string) => void) | null = null;

export function openSongEditor(id: string): void {
  if (device() !== "desktop") return;
  if (!openEditor) mountSongEditor();
  openEditor?.(id);
}

function mountSongEditor(): void {
  const modal = createSongEditor();
  fillIcons(modal);
  const byId = <T extends HTMLElement = HTMLElement>(id: string): T =>
    modal.querySelector<T>(`#song-editor-${id}`)!;
  const panel = modal.querySelector<HTMLElement>(".song-editor-panel")!;
  const body = modal.querySelector<HTMLElement>(".song-editor-body")!;
  const title = byId("song");
  const source = byId("source");
  const error = byId("error");
  const save = byId<HTMLButtonElement>("save");
  const undo = byId<HTMLButtonElement>("undo");
  const redo = byId<HTMLButtonElement>("redo");
  const play = byId<HTMLButtonElement>("play");
  const position = byId("position");
  const durationLabel = byId("duration");
  const viewport = byId("viewport");
  const inner = byId("timeline-inner");
  const ruler = byId("ruler");
  const waveTrack = byId("wave-track");
  const wave = byId<HTMLCanvasElement>("wave");
  const waveStatus = byId("wave-status");
  const selection = byId("selection");
  const lyricTrack = byId("lyric-track");
  const playhead = byId("playhead");
  const start = byId<HTMLInputElement>("cut-start");
  const end = byId<HTMLInputElement>("cut-end");
  const audioOnly = byId<HTMLButtonElement>("cut-audio-only");
  const audioLyrics = byId<HTMLButtonElement>("cut-audio-lyrics");
  const cutModeHint = byId("cut-mode-hint");
  const cutsList = byId("cuts");
  const lines = byId("lines");
  const linesContent = byId("lines-content");
  const lyricFile = byId<HTMLInputElement>("lyrics-file");
  const shiftFromBack = byId<HTMLButtonElement>("shift-from-back");
  const shiftFromForward = byId<HTMLButtonElement>("shift-from-forward");
  let audio: HTMLAudioElement;
  let disconnectPreview: (() => void) | null = null;
  let cancelPreviewReplacement: (() => void) | null = null;
  let wantsPlayback = false;
  let pendingSeek: number | null = null;

  let track: Track | null = null;
  let originalLyrics: string | null = null;
  let initialLyrics = "";
  let lyrics: EditorLyrics = { metadata: [], lines: [] };
  let lyricSerial = 0;
  let cutWithLyrics = false;
  let cuts: EditorCut[] = [];
  let stagedAudio: string | null = null;
  let cutAudio: string | null = null;
  let sourceDuration = 0;
  let history: EditHistory<EditorSnapshot> | null = null;
  let stages = new Set<string>();
  let waveTasks = new Map<string, Promise<number[]>>();
  let peaks: number[] = [];
  let busy = false;
  let loaded = false;
  let confirming = false;
  let editorMenuOpen = false;
  let generation = 0;
  let waveGeneration = 0;
  let frame: number | null = null;
  let closeTimer: number | null = null;
  let pixelsPerSecond = 10;
  let timelineWidth = 0;
  let timelineDuration = 0;
  let followPlayback = true;
  let selectedLine: number | null = null;
  let selectedRange: AudioCut | null = null;
  let activeLine: number | null = null;
  let activeRow: HTMLElement | null = null;

  const showError = (message: string): void => {
    error.textContent = message;
    error.hidden = !message;
  };
  const describe = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason);
  const cutRanges = (items: EditorCut[] = cuts): AudioCut[] => items.flatMap((cut) => cut.ranges);
  // Audio-only cuts do not change the lyric timeline.
  const lyricCutRanges = (items: EditorCut[] = cuts): AudioCut[] => items.flatMap((cut) => cut.lyricRanges);
  const duration = (): number => Number.isFinite(audio.duration) && audio.duration > 0
    ? Math.floor(audio.duration * 1000)
    : Math.max(0, sourceDuration - cutRanges().reduce((total, cut) => total + cut.endMs - cut.startMs, 0));
  const current = (): number => pendingSeek ?? Math.round((Number.isFinite(audio.currentTime) ? audio.currentTime : 0) * 1000);
  const snapshot = (): EditorSnapshot => ({
    lyrics, cuts, stagedAudio, cutAudio, sourceDuration, source: source.textContent ?? "",
  });
  const lyricContent = (): EditableLyrics => ({
    metadata: lyrics.metadata, lines: lyrics.lines.map(({ timeMs, text }) => ({ timeMs, text })),
  });
  const numberLyrics = (value: EditableLyrics): EditorLyrics => ({
    ...value, lines: value.lines.map((line) => ({ ...line, id: lyricSerial++ })),
  });
  const lyricsChanged = (): boolean => JSON.stringify(lyricContent()) !== initialLyrics;
  const dirty = (): boolean => lyricsChanged() || cuts.length > 0 || stagedAudio !== null
    || lines.querySelector("input:invalid") !== null;
  const updateShiftFrom = (): void => {
    shiftFromBack.disabled = shiftFromForward.disabled = busy || !loaded || selectedLine === null;
  };
  const updateSave = (): void => {
    save.disabled = busy || !loaded || !dirty();
    undo.disabled = busy || !loaded || !history?.canUndo;
    redo.disabled = busy || !loaded || !history?.canRedo;
    body.inert = busy || !loaded;
    updateShiftFrom();
  };
  const record = (group: string | null = null): void => {
    history?.record(snapshot(), group);
    updateSave();
  };
  const setCutMode = (withLyrics: boolean): void => {
    cutWithLyrics = withLyrics;
    audioOnly.classList.toggle("is-on", !withLyrics);
    audioLyrics.classList.toggle("is-on", withLyrics);
    audioOnly.setAttribute("aria-pressed", String(!withLyrics));
    audioLyrics.setAttribute("aria-pressed", String(withLyrics));
    cutModeHint.textContent = withLyrics
      ? "Timed lines in the cut are removed; later lines move with the audio."
      : "Lyrics keep their times from the start.";
  };
  const clearAudio = (): void => {
    if (!audio) return;
    cancelPreviewReplacement?.();
    cancelPreviewReplacement = null;
    wantsPlayback = false;
    pendingSeek = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    disconnectPreview?.();
    disconnectPreview = null;
  };
  const discardStage = (path: string): void => {
    const task = waveTasks.get(path);
    void (task ? task.catch(() => []) : Promise.resolve([]))
      .then(() => ipc.discardEditorAudio(path)).catch(() => {});
  };
  const finishClose = (): void => {
    closeTimer = null;
    modal.hidden = true;
    releasePopup(dismissEditor);
  };
  const forceClose = (): void => {
    if (modal.hidden || busy) return;
    if (editorMenuOpen) closeMenu();
    generation += 1;
    waveGeneration += 1;
    clearAudio();
    for (const path of stages) discardStage(path);
    stages = new Set();
    stagedAudio = null;
    cutAudio = null;
    track = null;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (reduceMotionActive()) {
      finishClose();
    } else {
      modal.classList.add("is-closed");
      closeTimer = window.setTimeout(finishClose, 300);
    }
  };
  const dismissEditor = (): void => {
    if (!dirty()) forceClose();
  };
  const requestClose = (): void => {
    if (busy || modal.hidden || confirming) return;
    if (dirty()) {
      confirming = true;
      const currentGeneration = generation;
      releasePopup(dismissEditor);
      void confirmDialog({
        title: "Discard unsaved changes?",
        message: "Your changes to the audio and lyrics will be lost.",
        confirmLabel: "Discard",
        danger: true,
      }).then((confirmed) => {
        confirming = false;
        if (currentGeneration !== generation || modal.hidden) return;
        if (confirmed) forceClose();
        else claimPopupIfFree(dismissEditor);
      });
    } else {
      forceClose();
    }
  };

  const xAt = (ms: number): number => timelineDuration > 0 ? ms / timelineDuration * timelineWidth : 0;
  const timeAt = (clientX: number): number => {
    const x = clientX - inner.getBoundingClientRect().left;
    return Math.round(Math.min(duration(), Math.max(0, x / Math.max(1, timelineWidth) * timelineDuration)));
  };
  const seekTo = (ms: number): void => {
    if (duration() <= 0) return;
    followPlayback = true;
    const target = Math.min(duration(), Math.max(0, ms));
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      pendingSeek = null;
      audio.currentTime = target / 1000;
    } else {
      pendingSeek = target;
    }
    paintClock();
    followPlayhead();
  };

  const paintWave = (): void => {
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, waveTrack.clientHeight);
    const ratio = window.devicePixelRatio || 1;
    wave.width = Math.round(width * ratio);
    wave.height = Math.round(height * ratio);
    wave.style.width = `${width}px`;
    const ctx = wave.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
    const audioWidth = xAt(duration());
    if (!peaks.length || !audioWidth) return;
    for (let x = 0; x < width; x += 3) {
      const at = viewport.scrollLeft + x;
      if (at >= audioWidth) break;
      const from = Math.floor(at / audioWidth * peaks.length);
      const to = Math.min(peaks.length, Math.max(from + 1, Math.ceil((at + 3) / audioWidth * peaks.length)));
      let peak = 0;
      for (let index = from; index < to; index += 1) peak = Math.max(peak, peaks[index] ?? 0);
      const bar = Math.max(2, Math.min(1, peak) * height * 0.9);
      ctx.fillRect(x, (height - bar) / 2, 2, bar);
    }
  };

  const paintRuler = (): void => {
    const length = timelineDuration;
    if (!length || !timelineWidth) { ruler.innerHTML = ""; return; }
    const intervals = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000];
    const step = intervals.find((value) => xAt(value) >= 70) ?? 3600000;
    const first = Math.max(0, Math.floor(viewport.scrollLeft / timelineWidth * length / step) * step);
    const last = Math.min(length, (viewport.scrollLeft + viewport.clientWidth) / timelineWidth * length + step);
    let html = "";
    for (let ms = first; ms <= last; ms += step) {
      html += `<span class="song-editor-tick" style="left:${xAt(ms)}px">${formatEditTime(ms).replace(/\.\d{3}$/, "")}</span>`;
    }
    ruler.innerHTML = html;
  };

  const paintSelection = (): void => {
    selection.hidden = !selectedRange;
    if (!selectedRange) return;
    selection.style.left = `${xAt(selectedRange.startMs)}px`;
    selection.style.width = `${xAt(selectedRange.endMs - selectedRange.startMs)}px`;
  };

  const syncSelection = (): void => {
    const startMs = parseEditTime(start.value);
    const endMs = parseEditTime(end.value);
    selectedRange = startMs !== null && endMs !== null && startMs < endMs && endMs <= duration()
      ? { startMs, endMs } : null;
    paintSelection();
  };

  const paintCuts = (): void => {
    cutsList.innerHTML = cuts.length ? cuts.map((cut, index) => `
      <div class="song-editor-cut">
        <span>${formatEditTime(cut.startMs)} - ${formatEditTime(cut.endMs)} when cut (${cut.withLyrics ? "audio &amp; lyrics" : "audio only"})</span>
        <button class="pill" type="button" data-remove-cut="${index}" aria-label="Restore cut ${index + 1}">Restore</button>
      </div>`).join("") : `<p class="settings-hint">No cuts added.</p>`;
    updateSave();
  };

  const paintChips = (): void => {
    updateShiftFrom();
    for (const row of lines.querySelectorAll<HTMLElement>("[data-line]")) {
      row.classList.toggle("is-selected", Number(row.dataset.line) === selectedLine);
    }
    const timed = lyrics.lines.map((line, index) => ({ line, index }))
      .filter((entry): entry is { line: EditorLyric & { timeMs: number }; index: number } => entry.line.timeMs !== null)
      .sort((a, b) => a.line.timeMs - b.line.timeMs);
    lyricTrack.innerHTML = timed.map(({ line, index }, at) => {
      const ms = line.timeMs;
      const next = timed[at + 1]?.line.timeMs ?? timelineDuration;
      return `<button type="button" class="song-editor-chip${index === selectedLine ? " is-selected" : ""}"
        data-chip="${index}" style="left:${xAt(ms)}px;width:${Math.max(32, xAt(next - ms) - 2)}px"
        title="${escapeHtml(line.text)}">${escapeHtml(line.text || "(empty)")}</button>`;
    }).join("");
  };

  const paintLines = (): void => {
    activeLine = null;
    linesContent.innerHTML = lyrics.lines.length ? lyrics.lines.map((line, index) => `
      <div class="song-editor-line${index === selectedLine ? " is-selected" : ""}" data-line="${index}">
        <input data-lyric-time="${index}" aria-label="Time for line ${index + 1}" placeholder="mm:ss.ms" value="${line.timeMs === null ? "" : formatEditTime(line.timeMs)}" />
        <input data-lyric-text="${index}" aria-label="Text for line ${index + 1}" value="${escapeHtml(line.text)}" />
        <button class="pill" type="button" data-lyric-seek="${index}" title="Seek to this line" aria-label="Seek to line ${index + 1}">Go</button>
        <button class="pill" type="button" data-lyric-mark="${index}" title="Set to playhead" aria-label="Set line ${index + 1} to playhead">Set</button>
        <button class="pill icon-only" type="button" data-lyric-remove="${index}" title="Remove line" aria-label="Remove line ${index + 1}"><span class="btn-icon" data-icon="close"></span></button>
      </div>`).join("") : `<p class="song-editor-empty">No lyrics yet. Import a file or add a line.</p>`;
    fillIcons(linesContent);
  };

  const paintHighlight = (row: HTMLElement | null): void => {
    if (!row) {
      linesContent.classList.remove("is-highlighted");
      linesContent.style.removeProperty("--lyric-highlight-top");
      linesContent.style.removeProperty("--lyric-highlight-height");
      return;
    }
    linesContent.style.setProperty("--lyric-highlight-top", `${row.offsetTop}px`);
    linesContent.style.setProperty("--lyric-highlight-height", `${row.offsetHeight}px`);
    if (!linesContent.classList.contains("is-highlighted")) {
      void linesContent.offsetWidth;
      linesContent.classList.add("is-highlighted");
    }
  };

  const paintClock = (): void => {
    const ms = current();
    position.textContent = formatEditTime(ms);
    durationLabel.textContent = formatEditTime(duration());
    play.textContent = audio.paused ? "Play" : "Pause";
    playhead.style.left = `${xAt(ms)}px`;
    let active = -1;
    let latest = -1;
    lyrics.lines.forEach((line, index) => {
      if (line.timeMs !== null && line.timeMs <= ms && line.timeMs >= latest) {
        active = index;
        latest = line.timeMs;
      }
    });
    let nextRow: HTMLElement | null = null;
    for (const row of lines.querySelectorAll<HTMLElement>("[data-line]")) {
      const on = Number(row.dataset.line) === active;
      row.classList.toggle("is-active", on);
      if (on) nextRow = row;
    }
    if (active !== activeLine) {
      activeLine = active;
      activeRow = nextRow;
      paintHighlight(activeRow);
      if (activeRow) {
        const bounds = lines.getBoundingClientRect();
        const row = activeRow.getBoundingClientRect();
        const scale = bounds.height / (parseFloat(getComputedStyle(lines).height) || 1) || 1;
        const offset = row.top < bounds.top ? row.top - bounds.top
          : row.bottom > bounds.bottom ? row.bottom - bounds.bottom : 0;
        lines.scrollTo({
          top: lines.scrollTop + offset / scale,
          behavior: reduceMotionActive() ? "instant" : "smooth",
        });
      } else {
        lines.scrollTo({ top: lines.scrollTop, behavior: "instant" });
      }
    }
    for (const chip of lyricTrack.querySelectorAll<HTMLElement>("[data-chip]")) {
      chip.classList.toggle("is-active", Number(chip.dataset.chip) === active);
    }
  };

  const paintTimeline = (): void => {
    const lastLyric = lyrics.lines.reduce((last, line) => Math.max(last, line.timeMs ?? -1), -1);
    timelineDuration = Math.max(duration(), lastLyric >= duration() ? lastLyric + 3200 : lastLyric);
    timelineWidth = Math.max(viewport.clientWidth, Math.min(2_000_000, timelineDuration / 1000 * pixelsPerSecond));
    inner.style.width = `${timelineWidth}px`;
    paintRuler();
    paintWave();
    paintCuts();
    paintSelection();
    paintChips();
    paintClock();
  };

  const loadWave = (song: Track, staged: string | null): void => {
    const request = ++waveGeneration;
    const key = staged ?? song.path;
    peaks = [];
    waveStatus.textContent = "Loading waveform...";
    let task = waveTasks.get(key);
    if (!task) {
      task = ipc.editorWaveform(song.id, staged);
      waveTasks.set(key, task);
    }
    void task.then((result) => {
      if (request !== waveGeneration) return;
      peaks = result;
      waveStatus.textContent = "";
      paintWave();
    }).catch((reason: unknown) => {
      if (request !== waveGeneration) return;
      waveStatus.textContent = `Waveform unavailable: ${describe(reason)}`;
      waveTasks.delete(key);
      paintWave();
    });
  };

  const playAudio = (): void => {
    const element = audio;
    wantsPlayback = true;
    void element.play().catch((reason: unknown) => {
      if (audio === element && wantsPlayback && !element.error) showError(describe(reason));
    });
  };

  const createAudio = (cors: boolean, replacement?: HTMLAudioElement): void => {
    clearAudio();
    const element = replacement ?? new Audio();
    audio = element;
    element.preload = "metadata";
    if (!replacement) element.crossOrigin = cors ? "anonymous" : null;
    disconnectPreview = connectPreviewAudio(
      element, track!.id, () => stagedAudio === null && cutAudio === null,
      (wanted) => {
        if (!wanted) {
          cancelPreviewReplacement?.();
          cancelPreviewReplacement = null;
          return;
        }
        if (cancelPreviewReplacement || audio !== element) return;
        cancelPreviewReplacement = prepareDirectAudio(element, () => current() / 1000, () => audio === element,
          (next) => {
            cancelPreviewReplacement = null;
            const playing = wantsPlayback;
            createAudio(cors, next);
            wantsPlayback = playing;
            if (!next.paused && frame === null) frame = requestAnimationFrame(tick);
          },
          () => { cancelPreviewReplacement = null; },
        );
      },
    );
    const metadata = (): void => {
      if (audio !== element) return;
      if (!cutAudio && Number.isFinite(element.duration) && element.duration > 0) {
        sourceDuration = Math.floor(element.duration * 1000);
      }
      if (pendingSeek !== null) {
        element.currentTime = Math.min(duration(), pendingSeek) / 1000;
        pendingSeek = null;
      }
      if (!cors) {
        showError("The equaliser cannot read this audio, so it is unavailable for this preview.");
      }
      if (!selectedRange) end.value = formatEditTime(duration());
      paintTimeline();
    };
    element.addEventListener("loadedmetadata", metadata);
    element.addEventListener("timeupdate", () => { if (audio === element) paintClock(); });
    element.addEventListener("pause", () => { if (audio === element) paintClock(); });
    element.addEventListener("ended", () => { if (audio === element) wantsPlayback = false; });
    element.addEventListener("play", () => {
      if (audio !== element) return;
      if (frame === null) frame = requestAnimationFrame(tick);
      paintClock();
    });
    element.addEventListener("error", () => {
      if (audio !== element || !element.getAttribute("src")) return;
      if (cors && element.readyState < HTMLMediaElement.HAVE_METADATA) {
        const path = element.src;
        const position = current();
        const playing = wantsPlayback || !element.paused;
        createAudio(false);
        pendingSeek = position;
        audio.src = path;
        audio.load();
        if (playing) playAudio();
        return;
      }
      showError("This audio could not be previewed on this device.");
    });
    if (replacement && element.readyState >= HTMLMediaElement.HAVE_METADATA) metadata();
  };

  const updateAudio = (positionMs = 0, playing = false): void => {
    if (!track) return;
    createAudio(true);
    pendingSeek = positionMs;
    const preview = cutAudio ?? stagedAudio;
    audio.src = assetUrl(preview ? previewStagedAudioPath(preview) : previewAudioPath(track));
    audio.load();
    loadWave(track, preview);
    paintTimeline();
    if (playing) playAudio();
  };

  const restore = (value: EditorSnapshot | null): void => {
    if (!value) return;
    const audioChanged = stagedAudio !== value.stagedAudio || cutAudio !== value.cutAudio;
    const sameSource = stagedAudio === value.stagedAudio;
    const position = sameSource ? editedTime(sourceTime(current(), cutRanges()), cutRanges(value.cuts)) : 0;
    const playing = wantsPlayback || !audio.paused;
    lyrics = value.lyrics;
    cuts = value.cuts;
    stagedAudio = value.stagedAudio;
    cutAudio = value.cutAudio;
    sourceDuration = value.sourceDuration;
    source.textContent = value.source;
    selectedLine = null;
    selectedRange = null;
    showError("");
    paintLines();
    if (audioChanged) updateAudio(position, sameSource && playing);
    else paintTimeline();
    updateSave();
  };

  const followPlayhead = (): void => {
    if (!followPlayback) return;
    const x = xAt(current());
    if (x > viewport.scrollLeft + viewport.clientWidth * 0.85 || x < viewport.scrollLeft) {
      viewport.scrollLeft = Math.max(0, x - viewport.clientWidth * 0.2);
    }
  };
  const tick = (): void => {
    frame = null;
    if (!audio.paused) {
      paintClock();
      followPlayhead();
      frame = requestAnimationFrame(tick);
    }
  };
  const togglePlay = (): void => {
    if (audio.paused) {
      player.pause();
      player.finishTransitions();
      if (audio.ended) seekTo(0);
      playAudio();
    } else {
      wantsPlayback = false;
      audio.pause();
    }
  };

  openEditor = (id) => {
    const next = getState().tracksById.get(id);
    if (!next || busy) return;
    if (!modal.hidden) {
      if (dirty()) { requestClose(); return; }
      forceClose();
    }
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    const currentGeneration = ++generation;
    track = next;
    lyrics = { metadata: [], lines: [] };
    initialLyrics = JSON.stringify(lyricContent());
    originalLyrics = null;
    cuts = [];
    stagedAudio = null;
    cutAudio = null;
    sourceDuration = next.durationMs;
    history = null;
    stages = new Set();
    waveTasks = new Map();
    selectedLine = null;
    selectedRange = null;
    setCutMode(false);
    pixelsPerSecond = 10;
    followPlayback = true;
    loaded = false;
    showError("");
    title.textContent = [next.title, next.artist].filter(Boolean).join(" - ");
    source.textContent = "Library audio";
    start.value = "00:00.000";
    end.value = formatEditTime(next.durationMs);
    lyricFile.value = "";
    player.pause();
    player.finishTransitions();
    claimPopup(dismissEditor);
    modal.hidden = false;
    modal.classList.add("is-closed");
    void panel.offsetWidth;
    modal.classList.remove("is-closed");
    viewport.scrollLeft = 0;
    updateAudio();
    paintLines();
    updateSave();
    byId<HTMLButtonElement>("close").focus();
    void ipc.loadLyrics(id).then((raw) => {
      if (currentGeneration !== generation) return;
      originalLyrics = raw;
      lyrics = numberLyrics(readEditableLyrics(raw ?? ""));
      initialLyrics = JSON.stringify(lyricContent());
      history = new EditHistory(snapshot());
      loaded = true;
      paintLines();
      paintTimeline();
      updateSave();
    }).catch((reason: unknown) => {
      if (currentGeneration !== generation) return;
      showError(`Could not load the lyrics: ${describe(reason)}`);
    });
  };

  byId("close").addEventListener("click", requestClose);
  undo.addEventListener("click", () => restore(history?.undo() ?? null));
  redo.addEventListener("click", () => restore(history?.redo() ?? null));
  modal.addEventListener("pointerdown", (event) => {
    if (selectedLine === null) return;
    const target = event.target as Element;
    if (target.closest("#song-editor-close, [data-shift-from]")) return;
    const input = target.closest<HTMLInputElement>("[data-lyric-time], [data-lyric-text]");
    if ((input?.dataset.lyricTime ?? input?.dataset.lyricText) === String(selectedLine)) return;
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && lines.contains(active)) active.blur();
    if (target.closest("[data-chip]")) return;
    selectedLine = null;
    paintChips();
  }, true);
  window.addEventListener("keydown", (event) => {
    if (modal.hidden || confirming) return;
    const target = event.target as HTMLElement | null;
    const textInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement || target?.isContentEditable === true;
    if (editorMenuOpen) {
      if (textInput) return;
      if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && !event.repeat
        && (event.key.toLowerCase() === "x" || event.key === "Delete" || event.key === "Backspace") && selectedRange) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeMenu();
        cutSelection();
        return;
      }
      if (!["Escape", "ArrowUp", "ArrowDown", "Enter", "Tab"].includes(event.key)) {
        event.stopImmediatePropagation();
      }
      return;
    }
    if (isOtherPopupShowing(dismissEditor)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      requestClose();
      return;
    }
    if (busy || !loaded) { event.stopPropagation(); return; }
    const lyricInput = target instanceof HTMLInputElement && target.closest(".song-editor-lines");
    if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) save.click();
      return;
    }
    if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "z"
      && (!textInput || lyricInput)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (busy || !loaded) return;
      if (!event.shiftKey && lyricInput && target instanceof HTMLInputElement && !target.validity.valid) {
        const line = lyrics.lines[Number(target.dataset.lyricTime)];
        target.value = line?.timeMs === null || line?.timeMs === undefined ? "" : formatEditTime(line.timeMs);
        target.setCustomValidity("");
        history?.endGroup();
        updateSave();
        return;
      }
      const selector = lyricInput && target instanceof HTMLInputElement
        ? target.dataset.lyricText !== undefined ? `[data-lyric-text="${target.dataset.lyricText}"]`
          : `[data-lyric-time="${target.dataset.lyricTime}"]`
        : null;
      const caret = target instanceof HTMLInputElement ? target.selectionStart : null;
      restore(event.shiftKey ? history?.redo() ?? null : history?.undo() ?? null);
      if (selector) {
        const input = lines.querySelector<HTMLInputElement>(selector);
        input?.focus();
        if (input && caret !== null) input.setSelectionRange(Math.min(caret, input.value.length), Math.min(caret, input.value.length));
      }
      return;
    }
    if (!textInput && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const shiftButton = target instanceof HTMLButtonElement && target.hasAttribute("data-lyric-shift");
      if ((event.code === "Space" && shiftButton) || (event.code === "Enter" && target instanceof HTMLButtonElement)) {
        event.preventDefault();
        if (!target.disabled && !(event.code === "Space" && event.repeat)) {
          if (shiftButton && event.shiftKey) {
            target.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
          } else target.click();
        }
      }
      else if (event.code === "Space") {
        event.preventDefault();
        if (!busy && loaded) togglePlay();
      }
      else if (!event.shiftKey && !event.repeat && (event.key.toLowerCase() === "x" || event.key === "Delete" || event.key === "Backspace")) {
        if (selectedRange) { event.preventDefault(); cutSelection(); }
      }
      else if (!event.shiftKey && !event.repeat && event.key.toLowerCase() === "i") {
        event.preventDefault(); setStart(current());
      }
      else if (!event.shiftKey && !event.repeat && event.key.toLowerCase() === "o") {
        event.preventDefault(); setEnd(current());
      }
      else if (!event.shiftKey && event.key === "Home") { event.preventDefault(); seekTo(0); }
      else if (!event.shiftKey && event.key === "End") { event.preventDefault(); seekTo(duration()); }
      else if (event.code === "ArrowLeft") { event.preventDefault(); seekTo(current() - (event.shiftKey ? 100 : 2000)); }
      else if (event.code === "ArrowRight") { event.preventDefault(); seekTo(current() + (event.shiftKey ? 100 : 2000)); }
    }
    if (!textInput) event.stopPropagation();
  }, true);

  play.addEventListener("click", togglePlay);
  viewport.addEventListener("scroll", () => { paintRuler(); paintWave(); });
  viewport.addEventListener("pointerdown", (event) => {
    if (event.button === 1) followPlayback = false;
  });
  viewport.addEventListener("wheel", (event) => {
    if (event.ctrlKey || event.shiftKey || event.deltaX !== 0) followPlayback = false;
    if (event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      const length = timelineDuration;
      if (!length) return;
      const cursor = event.clientX - viewport.getBoundingClientRect().left;
      const anchor = (viewport.scrollLeft + cursor) / Math.max(1, timelineWidth) * length;
      const fit = viewport.clientWidth * 1000 / length;
      pixelsPerSecond = Math.max(fit, Math.min(Math.max(200, fit * 40), Math.max(pixelsPerSecond, fit) * Math.exp(-event.deltaY * 0.002)));
      paintTimeline();
      viewport.scrollLeft = xAt(anchor) - cursor;
      paintRuler();
      paintWave();
    } else if (event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      viewport.scrollLeft += event.deltaY || event.deltaX;
    }
  }, { passive: false });
  window.addEventListener("resize", () => {
    if (!modal.hidden) {
      paintTimeline();
      paintHighlight(activeRow);
    }
  });
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      if (activeRow) paintHighlight(activeRow);
    }).observe(linesContent);
  }
  ruler.addEventListener("pointerdown", (event) => { if (event.button === 0) seekTo(timeAt(event.clientX)); });
  waveTrack.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !duration()) return;
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    const anchor = timeAt(event.clientX);
    const x = event.clientX;
    let moved = false;
    const move = (next: PointerEvent): void => {
      if (next.pointerId !== event.pointerId) return;
      if (Math.abs(next.clientX - x) >= 4) moved = true;
      if (!moved) return;
      const at = timeAt(next.clientX);
      selectedRange = { startMs: Math.min(anchor, at), endMs: Math.max(anchor, at) };
      start.value = formatEditTime(selectedRange.startMs);
      end.value = formatEditTime(selectedRange.endMs);
      paintSelection();
    };
    const up = (next: PointerEvent): void => {
      if (next.pointerId !== event.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!moved) { selectedRange = null; paintSelection(); seekTo(anchor); }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
  lyricTrack.addEventListener("pointerdown", (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>("[data-chip]");
    if (!chip || event.button !== 0 || !duration()) return;
    const index = Number(chip.dataset.chip);
    const line = lyrics.lines[index];
    if (!line || line.timeMs === null) return;
    event.preventDefault();
    const x = event.clientX;
    const at = line.timeMs;
    const scale = timelineDuration / Math.max(1, timelineWidth);
    selectedLine = index;
    paintChips();
    paintClock();
    let moved = false;
    const move = (next: PointerEvent): void => {
      if (next.pointerId !== event.pointerId) return;
      if (Math.abs(next.clientX - x) >= 3) moved = true;
      if (!moved) return;
      line.timeMs = Math.round(Math.min(timelineDuration, Math.max(0, at + (next.clientX - x) * scale)));
      paintChips();
      paintClock();
    };
    const up = (next: PointerEvent): void => {
      if (next.pointerId !== event.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (moved) { paintLines(); record(); }
      paintClock();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });

  const setStart = (ms: number): void => { start.value = formatEditTime(ms); syncSelection(); };
  const setEnd = (ms: number): void => { end.value = formatEditTime(Math.min(ms, duration())); syncSelection(); };
  audioOnly.addEventListener("click", () => setCutMode(false));
  audioLyrics.addEventListener("click", () => setCutMode(true));
  byId("mark-start").addEventListener("click", () => setStart(current()));
  byId("mark-end").addEventListener("click", () => setEnd(current()));
  start.addEventListener("input", syncSelection);
  end.addEventListener("input", syncSelection);
  const changeCuts = (next: EditorCut[], nextLyrics: EditorLyrics = lyrics): void => {
    if (!track || busy || !loaded) return;
    const ranges = cutRanges(next);
    if (ranges.length > 100) { showError("A song cannot have more than 100 cut ranges."); return; }
    const position = editedTime(sourceTime(current(), cutRanges()), ranges);
    const playing = wantsPlayback || !audio.paused;
    wantsPlayback = false;
    audio.pause();
    busy = true;
    updateSave();
    showError("");
    waveGeneration += 1;
    waveStatus.textContent = "Cutting audio...";
    void (async () => {
      const rendered = ranges.length ? await ipc.renderEditorCuts(track!.id, stagedAudio, ranges) : null;
      if (rendered) stages.add(rendered);
      cuts = next;
      cutAudio = rendered;
      selectedRange = null;
      if (nextLyrics !== lyrics) {
        lyrics = nextLyrics;
        selectedLine = null;
        paintLines();
      }
      record();
      updateAudio(position, playing);
    })().catch((reason: unknown) => {
      loadWave(track!, cutAudio ?? stagedAudio);
      showError(describe(reason));
      if (playing) playAudio();
    }).finally(() => {
      busy = false;
      updateSave();
    });
  };
  const applyCut = (range: AudioCut): void => {
    if (busy || !loaded) return;
    const problem = validateCuts([range], duration());
    if (problem) { showError(problem); return; }
    const previousRanges = cutRanges();
    const previousLyricRanges = lyricCutRanges();
    const removedLyrics: EditorCut["removedLyrics"] = [];
    let nextLyrics = lyrics;
    if (cutWithLyrics) {
      const invalid = lines.querySelector<HTMLInputElement>("input:invalid");
      if (invalid) { invalid.reportValidity(); return; }
      nextLyrics = {
        ...lyrics,
        lines: lyrics.lines.flatMap((line) => {
          if (line.timeMs === null) return [line];
          if (line.timeMs >= range.startMs && line.timeMs < range.endMs) {
            removedLyrics.push({ line, sourceMs: sourceTime(line.timeMs, previousLyricRanges) });
            return [];
          }
          return [{ ...line, timeMs: editedTime(line.timeMs, [range]) }];
        }),
      };
    }
    const next = [...cuts, {
      ...range, ranges: sourceCutRanges(range, previousRanges),
      lyricRanges: cutWithLyrics ? sourceCutRanges(range, previousLyricRanges) : [],
      withLyrics: cutWithLyrics, removedLyrics,
    }];
    changeCuts(next, nextLyrics);
  };
  const cutSelection = (): void => {
    if (selectedRange) applyCut(selectedRange);
  };
  byId("add-cut").addEventListener("click", () => {
    const startMs = parseEditTime(start.value);
    const endMs = parseEditTime(end.value);
    if (startMs === null || endMs === null) { showError("Enter cut times as mm:ss or mm:ss.mmm."); return; }
    applyCut({ startMs, endMs });
  });
  cutsList.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-remove-cut]");
    if (!button) return;
    const index = Number(button.dataset.removeCut);
    if (index < 0 || index >= cuts.length) return;
    const cut = cuts[index];
    const next = cuts.filter((_, at) => at !== index);
    let nextLyrics = lyrics;
    if (cut.withLyrics) {
      const invalid = lines.querySelector<HTMLInputElement>("input:invalid");
      if (invalid) { invalid.reportValidity(); return; }
      const before = lyricCutRanges();
      const after = lyricCutRanges(next);
      const kept = lyrics.lines.map((line) => line.timeMs === null ? line : {
        ...line, timeMs: editedTime(sourceTime(line.timeMs, before), after),
      });
      const restored = cut.removedLyrics.map(({ line, sourceMs }) => ({
        ...line, timeMs: editedTime(sourceMs, after),
      }));
      nextLyrics = { ...lyrics, lines: [...kept, ...restored].sort((a, b) => a.id - b.id) };
    }
    changeCuts(next, nextLyrics);
  });

  modal.addEventListener("contextmenu", (event) => {
    if (busy || !loaded || confirming || (isOtherPopupShowing(dismissEditor) && !editorMenuOpen)) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable]")) return;
    event.preventDefault();
    if (editorMenuOpen) closeMenu();
    const items: MenuItem[] = [
      { label: cutWithLyrics ? "Cut selected audio and lyrics" : "Cut selected audio",
        disabled: !selectedRange || !!validateCuts([selectedRange], duration()), action: cutSelection },
      { label: "Undo", disabled: !history?.canUndo, action: () => restore(history?.undo() ?? null) },
      { label: "Redo", disabled: !history?.canRedo, action: () => restore(history?.redo() ?? null) },
      {
        label: "Clear selection", disabled: !selectedRange,
        action: () => { selectedRange = null; paintSelection(); },
      },
    ];
    if (viewport.contains(target)) {
      const at = timeAt(event.clientX);
      items.push(
        { label: "Seek here", action: () => seekTo(at) },
        { label: "Set cut start here", action: () => setStart(at) },
        { label: "Set cut end here", action: () => setEnd(at) },
      );
    }
    releasePopup(dismissEditor);
    editorMenuOpen = true;
    openMenu(modal, items, { x: event.clientX, y: event.clientY }, {
      onClose: () => {
        editorMenuOpen = false;
        if (!modal.hidden && !confirming) claimPopupIfFree(dismissEditor);
      },
    });
  });

  byId("import-audio").addEventListener("click", () => {
    if (busy) return;
    busy = true;
    updateSave();
    void (async () => {
      const path = await ipc.pickEditorAudio();
      if (!path) return;
      const staged = await ipc.stageEditorAudio(path);
      stages.add(staged);
      stagedAudio = staged;
      cuts = [];
      cutAudio = null;
      sourceDuration = 0;
      selectedRange = null;
      source.textContent = `Replacement: ${path.split(/[\\/]/).pop() ?? path}`;
      showError("");
      record();
      updateAudio();
    })().catch((reason: unknown) => showError(describe(reason))).finally(() => {
      busy = false;
      updateSave();
    });
  });
  byId("import-lyrics").addEventListener("click", () => lyricFile.click());
  lyricFile.addEventListener("change", () => {
    const file = lyricFile.files?.[0];
    if (!file || busy) return;
    const currentGeneration = generation;
    busy = true;
    updateSave();
    void file.text().then((text) => {
      if (currentGeneration !== generation) return;
      lyrics = numberLyrics(readEditableLyrics(text));
      cuts = cuts.map((cut) => ({ ...cut, removedLyrics: [] }));
      selectedLine = null;
      showError("");
      record();
      paintLines();
      paintTimeline();
    }).catch((reason: unknown) => showError(describe(reason))).finally(() => {
      lyricFile.value = "";
      busy = false;
      updateSave();
    });
  });
  byId("add-line").addEventListener("click", () => {
    lyrics.lines.push({ timeMs: current(), text: "", id: lyricSerial++ });
    selectedLine = lyrics.lines.length - 1;
    record();
    paintLines();
    paintTimeline();
    lines.querySelector<HTMLInputElement>(`[data-lyric-text="${selectedLine}"]`)?.focus();
  });
  const shift = (amount: number, from = 0): void => {
    const invalid = lines.querySelector<HTMLInputElement>("input:invalid");
    if (invalid) { invalid.reportValidity(); return; }
    for (const line of lyrics.lines.slice(from)) {
      if (line.timeMs !== null) line.timeMs = Math.max(0, line.timeMs + amount);
    }
    record();
    paintLines();
    paintTimeline();
  };
  byId("shift-back").addEventListener("click", (e) => shift(e.shiftKey ? -500 : -100));
  byId("shift-forward").addEventListener("click", (e) => shift(e.shiftKey ? 500 : 100));
  shiftFromBack.addEventListener("click", (e) => {
    if (selectedLine !== null) shift(e.shiftKey ? -500 : -100, selectedLine);
  });
  shiftFromForward.addEventListener("click", (e) => {
    if (selectedLine !== null) shift(e.shiftKey ? 500 : 100, selectedLine);
  });
  lines.addEventListener("focusin", (event) => {
    const input = event.target as HTMLInputElement;
    const index = input.dataset.lyricTime ?? input.dataset.lyricText;
    if (index !== undefined) {
      selectedLine = Number(index);
      history?.endGroup();
      paintChips();
      paintClock();
    }
  });
  lines.addEventListener("focusout", () => history?.endGroup());
  lines.addEventListener("input", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.lyricTime !== undefined) {
      const line = lyrics.lines[Number(input.dataset.lyricTime)];
      const value = input.value.trim();
      const time = value ? parseEditTime(value) : null;
      input.setCustomValidity(value && time === null ? "Enter a time as mm:ss or mm:ss.mmm." : "");
      if (line && (!value || time !== null)) {
        line.timeMs = time;
        record(`time-${input.dataset.lyricTime}`);
      }
    } else if (input.dataset.lyricText !== undefined) {
      const line = lyrics.lines[Number(input.dataset.lyricText)];
      if (line) {
        line.text = input.value;
        record(`text-${input.dataset.lyricText}`);
      }
    }
    paintTimeline();
    updateSave();
  });
  lines.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("button");
    if (!button) return;
    if (button.dataset.lyricSeek !== undefined) {
      const time = lyrics.lines[Number(button.dataset.lyricSeek)]?.timeMs;
      if (time !== null && time !== undefined) seekTo(time);
    } else if (button.dataset.lyricMark !== undefined) {
      const line = lyrics.lines[Number(button.dataset.lyricMark)];
      if (line) line.timeMs = current();
      record();
      paintLines();
      paintTimeline();
    } else if (button.dataset.lyricRemove !== undefined) {
      lyrics.lines.splice(Number(button.dataset.lyricRemove), 1);
      selectedLine = null;
      record();
      paintLines();
      paintTimeline();
    }
  });

  save.addEventListener("click", () => {
    if (!track || busy || !loaded || !dirty()) return;
    const invalid = lines.querySelector<HTMLInputElement>("input:invalid");
    if (invalid) { invalid.reportValidity(); return; }
    const song = track;
    const raw = lyricsChanged() ? writeEditableLyrics(lyrics) : null;
    clearAudio();
    busy = true;
    updateSave();
    showError("");
    save.textContent = "Saving...";
    void saveEditedSong(song.id, song.path, originalLyrics, raw, cutAudio ?? stagedAudio, [])
      .then(() => {
        busy = false;
        forceClose();
      }).catch((reason: unknown) => {
        showError(describe(reason));
        updateAudio();
      }).finally(() => {
        busy = false;
        save.textContent = "Save changes";
        updateSave();
      });
  });
}
