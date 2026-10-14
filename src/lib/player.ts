import type { Playback, RepeatMode } from "../types";
import type { AudioEngine } from "./audio";
import { FADE_MS, smoothstep } from "./fade";

export interface PlayerSnapshot {
  sourceId: string | null;
  sourceName: string;
  sourceOrder: string[];
  order: string[];
  cursor: number;
  travel: number;
  currentId: string | null;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
  muted: boolean;
}

/** What the player needs to know about a track to play it. */
export interface PlayerSource {
  path: string;
  durationMs: number;
  /** The loudness gain, `1` for a song that has not been measured. */
  gain: number;
}

type ChangeListener = (snapshot: PlayerSnapshot) => void;
type ProgressListener = (positionMs: number, durationMs: number) => void;

export const MIN_VOLUME = 0;
export const MAX_VOLUME = 100;
export const MAX_GAIN = 1.2;

/** How close to the end counts as the end, for restarting a finished track. */
const END_SLACK_MS = 200;

export class Player {
  private readonly engine: AudioEngine;
  private readonly sourceOf: (trackId: string) => PlayerSource | undefined;

  /** The collection as it was handed to us, before shuffling. */
  private sourceOrder: string[] = [];
  private sourceId: string | null = null;
  private sourceName = "";

  /** The order tracks are actually played in. */
  private order: string[] = [];
  private cursor = 0;

  private travel = 0;

  /** The track the element is holding, so it is only loaded once. */
  private loadedId: string | null = null;

  private playing = false;
  private shuffle = false;
  private repeat: RepeatMode = "off";

  /** What the user asked for, `0` to `100`. */
  private volume = 70;
  private muted = false;
  /** What the element is actually at, `0` to `1`, while the transport fades. */
  private level = 0;

  private fade: { from: number; to: number; startedAt: number; durationMs: number } | null = null;
  private fadeFrame: number | null = null;
  private clockFrame: number | null = null;

  private readonly changeListeners = new Set<ChangeListener>();
  private readonly progressListeners = new Set<ProgressListener>();

  constructor(engine: AudioEngine, sourceOf: (trackId: string) => PlayerSource | undefined) {
    this.engine = engine;
    this.sourceOf = sourceOf;
    this.applyLevel();
  }

  onChange(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  onProgress(listener: ProgressListener): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  get currentId(): string | null {
    return this.order[this.cursor] ?? null;
  }

  get currentDurationMs(): number {
    const measured = this.engine.durationMs;
    if (measured > 0) {
      return measured;
    }
    const id = this.currentId;
    return id ? (this.sourceOf(id)?.durationMs ?? 0) : 0;
  }

  get positionMs(): number {
    return this.currentId ? this.engine.positionMs : 0;
  }

  get hasQueue(): boolean {
    return this.order.length > 0;
  }

  snapshot(): PlayerSnapshot {
    return {
      sourceId: this.sourceId,
      sourceName: this.sourceName,
      sourceOrder: [...this.sourceOrder],
      order: [...this.order],
      cursor: this.cursor,
      travel: this.travel,
      currentId: this.currentId,
      positionMs: this.positionMs,
      durationMs: this.currentDurationMs,
      playing: this.playing,
      shuffle: this.shuffle,
      repeat: this.repeat,
      volume: Math.round(this.volume),
      muted: this.muted,
    };
  }

  /** Replaces the queue. Keeps playing if something was already playing. */
  setQueue(sourceId: string, sourceName: string, trackIds: string[], startTrackId?: string): void {
    this.sourceId = sourceId;
    this.sourceName = sourceName;
    this.sourceOrder = [...trackIds];

    const keep = startTrackId && trackIds.includes(startTrackId) ? startTrackId : (trackIds[0] ?? null);
    this.rebuildOrder(keep);

    this.loadCurrent(this.playing);
    this.emitChange();
    this.emitProgress();
  }

  restore(playback: Playback): void {
    const order = playback.order.length > 0 ? playback.order : playback.sourceOrder;
    if (order.length === 0) {
      return;
    }

    this.sourceId = playback.sourceId;
    this.sourceName = playback.sourceName;
    this.sourceOrder = [...playback.sourceOrder];
    this.order = [...order];
    this.cursor = Math.min(Math.max(playback.cursor, 0), order.length - 1);
    this.shuffle = playback.shuffle;
    this.repeat = playback.repeat === "all" ? "all" : "off";
    this.muted = playback.muted;
    this.playing = false;
    this.level = 0;
    this.applyLevel();
    this.stopFade();
    this.stopClock();
    this.loadCurrent(false, Math.max(playback.positionMs, 0));
    this.emitChange();
    this.emitProgress();
  }

  /** Jumps to a track that is already in the queue and starts playing it. */
  playTrack(trackId: string): void {
    const index = this.order.indexOf(trackId);
    if (index < 0) {
      return;
    }
    this.cursor = index;
    this.startCurrent();
  }

  moveTo(trackId: string): void {
    const index = this.order.indexOf(trackId);
    if (index < 0) {
      return;
    }
    this.cursor = index;
    this.loadCurrent(this.playing, 0);
    this.emitChange();
    this.emitProgress();
  }

  play(): void {
    if (!this.hasQueue || this.playing) {
      return;
    }
    this.playing = true;

    if (this.loadedId !== this.currentId) {
      this.loadCurrent(true);
    } else {
      if (this.atEnd()) {
        this.engine.seek(0);
      }
      void this.engine.play();
      this.startClock();
      this.startFade(this.targetLevel());
    }

    this.emitChange();
  }

  pause(): void {
    if (!this.playing) {
      return;
    }
    this.playing = false;
    this.startFade(0);
    this.emitChange();
  }

  toggle(): void {
    if (this.playing) {
      this.pause();
    } else {
      this.play();
    }
  }

  next(): void {
    if (!this.hasQueue) {
      return;
    }
    if (this.cursor + 1 < this.order.length) {
      this.cursor += 1;
      this.travel += 1;
      this.startCurrent();
    } else if (this.repeat === "all") {
      this.cursor = 0;
      this.travel += 1;
      this.startCurrent();
    }
  }

  previous(): void {
    if (!this.hasQueue) {
      return;
    }
    if (this.cursor > 0) {
      this.cursor -= 1;
      this.travel -= 1;
      this.startCurrent();
    } else if (this.repeat === "all") {
      this.cursor = this.order.length - 1;
      this.travel -= 1;
      this.startCurrent();
    }
  }

  seek(positionMs: number): void {
    const duration = this.currentDurationMs;
    const limit = duration > 0 ? duration : positionMs;
    this.engine.seek(Math.min(Math.max(positionMs, 0), limit));
    this.emitProgress();
  }

  seekFraction(fraction: number): void {
    const duration = this.currentDurationMs;
    if (duration <= 0) {
      return;
    }
    this.seek(duration * Math.min(Math.max(fraction, 0), 1));
  }

  setShuffle(on: boolean): void {
    if (this.shuffle === on) {
      return;
    }
    const keep = this.currentId;
    this.shuffle = on;
    this.rebuildOrder(keep);
    this.emitChange();
  }

  cycleRepeat(): void {
    this.repeat = this.repeat === "off" ? "all" : "off";
    this.emitChange();
  }

  setVolume(volume: number): void {
    this.volume = Math.min(Math.max(volume, MIN_VOLUME), MAX_VOLUME);
    if (this.volume > 0) {
      this.muted = false;
    }
    this.retarget();
    this.emitChange();
  }

  /** Re-reads the current song's gain, for a reading that arrived mid-song. */
  refreshGain(): void {
    this.retarget();
  }

  toggleMute(): void {
    this.muted = !this.muted;
    this.startFade(this.targetLevel());
    this.emitChange();
  }

  /** Adds a track to the end of the queue, e.g. "play next" from a card menu. */
  appendToQueue(trackId: string): void {
    if (this.order.includes(trackId)) {
      return;
    }
    this.order.push(trackId);
    this.sourceOrder.push(trackId);
    this.emitChange();
  }

  /** Inserts directly after the current track. */
  insertAfterCurrent(trackId: string): void {
    if (this.order.includes(trackId)) {
      return;
    }
    this.order.splice(this.cursor + 1, 0, trackId);
    this.sourceOrder.push(trackId);
    this.emitChange();
  }

  removeFromQueue(trackId: string): void {
    const index = this.order.indexOf(trackId);
    if (index < 0) {
      return;
    }
    const wasCurrent = index === this.cursor;
    this.order.splice(index, 1);
    this.sourceOrder = this.sourceOrder.filter((id) => id !== trackId);

    if (this.order.length === 0) {
      this.cursor = 0;
      this.playing = false;
      this.stopClock();
      this.loadCurrent(false);
    } else if (index < this.cursor) {
      this.cursor -= 1;
    } else if (wasCurrent) {
      this.cursor = Math.min(this.cursor, this.order.length - 1);
      this.loadCurrent(this.playing);
    }
    this.emitChange();
    this.emitProgress();
  }

  /** The track ran out: move on, or stop at the end of the queue. */
  handleEnded(): void {
    if (this.cursor + 1 < this.order.length || this.repeat === "all") {
      this.next();
    } else {
      this.finish();
    }
  }

  /** Metadata arrived, so the duration and the seeked position are real now. */
  handleLoaded(): void {
    this.emitChange();
    this.emitProgress();
  }

  /** The current track could not be played. */
  handleError(): void {
    this.stopFade();
    this.playing = false;
    this.level = 0;
    this.applyLevel();
    this.stopClock();
    this.loadedId = null;
    this.emitChange();
  }

  private rebuildOrder(keepId: string | null): void {
    if (this.shuffle) {
      const rest = this.sourceOrder.filter((id) => id !== keepId);
      shuffleInPlace(rest);
      this.order = keepId ? [keepId, ...rest] : rest;
    } else {
      this.order = [...this.sourceOrder];
    }

    const found = keepId ? this.order.indexOf(keepId) : 0;
    this.cursor = found >= 0 ? found : 0;
  }

  private loadCurrent(autoplay: boolean, positionMs = 0): void {
    const id = this.currentId;
    const source = id ? this.sourceOf(id) : undefined;

    this.stopFade();
    this.level = 0;

    if (!id || !source) {
      this.loadedId = null;
      this.playing = false;
      this.stopClock();
      this.engine.unload();
      return;
    }

    this.loadedId = id;
    this.engine.load(source.path, { autoplay, positionMs });

    if (autoplay) {
      this.startClock();
      this.startFade(this.targetLevel());
    } else {
      this.stopClock();
    }
  }

  /** Starts the current track from its head, keeping the playing state. */
  private startCurrent(): void {
    this.playing = true;
    this.loadCurrent(true);
    this.emitChange();
    this.emitProgress();
  }

  private finish(): void {
    this.stopFade();
    this.playing = false;
    this.level = 0;
    this.applyLevel();
    this.engine.pause();
    this.stopClock();
    this.emitChange();
    this.emitProgress();
  }

  private atEnd(): boolean {
    const duration = this.currentDurationMs;
    return duration > 0 && this.engine.positionMs >= duration - END_SLACK_MS;
  }

  /** The level the element settles at: silent while paused or muted. */
  private targetLevel(): number {
    if (this.muted || !this.playing) {
      return 0;
    }
    const id = this.currentId;
    const gain = id ? (this.sourceOf(id)?.gain ?? 1) : 1;
    return (this.volume / MAX_VOLUME) * MAX_GAIN * gain;
  }

  /** Moves the level to whatever the current song and settings call for. */
  private retarget(): void {
    if (this.fade !== null) {
      this.startFade(this.targetLevel());
      return;
    }
    this.level = this.targetLevel();
    this.applyLevel();
  }

  private applyLevel(): void {
    this.engine.setVolume(this.level);
  }

  /** Moves the level to its target over a moment, rather than in one step. */
  private startFade(to: number): void {
    const from = this.level;
    if (from === to) {
      this.stopFade();
      this.settleFade();
      return;
    }

    this.fade = {
      from,
      to,
      startedAt: performance.now(),
      durationMs: FADE_MS,
    };
    if (this.fadeFrame === null) {
      this.fadeFrame = requestAnimationFrame(this.stepFade);
    }
  }

  private readonly stepFade = (now: number): void => {
    this.fadeFrame = null;
    const fade = this.fade;
    if (!fade) {
      return;
    }

    const progress = Math.min((now - fade.startedAt) / fade.durationMs, 1);
    this.level = fade.from + (fade.to - fade.from) * smoothstep(progress);
    this.applyLevel();

    if (progress < 1) {
      this.fadeFrame = requestAnimationFrame(this.stepFade);
      return;
    }

    this.fade = null;
    this.settleFade();
  };

  /** Lets go of a fade without stopping the element. */
  private stopFade(): void {
    this.fade = null;
    if (this.fadeFrame !== null) {
      window.cancelAnimationFrame(this.fadeFrame);
      this.fadeFrame = null;
    }
  }

  /** A pause is only complete once the fade has taken the sound away. */
  private settleFade(): void {
    if (!this.playing && this.engine.isPlaying) {
      this.engine.pause();
      this.stopClock();
      this.emitProgress();
    }
  }

  private startClock(): void {
    if (this.clockFrame === null) {
      this.clockFrame = requestAnimationFrame(this.tick);
    }
  }

  private stopClock(): void {
    if (this.clockFrame !== null) {
      window.cancelAnimationFrame(this.clockFrame);
      this.clockFrame = null;
    }
  }

  /** Reads the media clock every frame, so the UI follows the sound. */
  private readonly tick = (): void => {
    this.clockFrame = null;
    if (!this.playing) {
      return;
    }
    this.emitProgress();
    this.clockFrame = requestAnimationFrame(this.tick);
  };

  private emitChange(): void {
    const snapshot = this.snapshot();
    for (const listener of this.changeListeners) {
      listener(snapshot);
    }
  }

  private emitProgress(): void {
    const duration = this.currentDurationMs;
    for (const listener of this.progressListeners) {
      listener(this.positionMs, duration);
    }
  }
}

/** Fisher-Yates, in place. */
function shuffleInPlace(items: string[]): void {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [items[index], items[swap]] = [items[swap], items[index]];
  }
}

/** Quick off the mark, gentle into the finish, which suits a volume step. */
export function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}
