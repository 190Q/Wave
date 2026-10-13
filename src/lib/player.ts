import type { Playback, RepeatMode } from "../types";

const TICK_MS = 250;

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

type ChangeListener = (snapshot: PlayerSnapshot) => void;
type ProgressListener = (positionMs: number, durationMs: number) => void;

export class Player {
  private readonly durationOf: (trackId: string) => number;

  /** The collection as it was handed to us, before shuffling. */
  private sourceOrder: string[] = [];
  private sourceId: string | null = null;
  private sourceName = "";

  /** The order tracks are actually played in. */
  private order: string[] = [];
  private cursor = 0;

  private travel = 0;

  private positionMs = 0;
  private playing = false;
  private shuffle = false;
  private repeat: RepeatMode = "off";
  private volume = 70;
  private muted = false;
  private timer: number | null = null;

  private readonly changeListeners = new Set<ChangeListener>();
  private readonly progressListeners = new Set<ProgressListener>();

  constructor(durationOf: (trackId: string) => number) {
    this.durationOf = durationOf;
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
    const id = this.currentId;
    return id ? this.durationOf(id) : 0;
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
      volume: this.volume,
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
    this.positionMs = 0;

    if (this.playing && keep) {
      this.startTimer();
    }
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
    this.positionMs = Math.max(playback.positionMs, 0);
    this.shuffle = playback.shuffle;
    this.repeat = playback.repeat === "all" ? "all" : "off";
    this.muted = playback.muted;
    this.playing = false;
    this.stopTimer();
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
    this.positionMs = 0;
    this.emitChange();
    this.emitProgress();
  }

  play(): void {
    if (!this.hasQueue) {
      return;
    }
    this.playing = true;
    this.startTimer();
    this.emitChange();
  }

  pause(): void {
    this.playing = false;
    this.stopTimer();
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
    this.positionMs = Math.min(Math.max(positionMs, 0), limit);
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
    this.volume = Math.min(Math.max(Math.round(volume), 0), 100);
    if (this.volume > 0) {
      this.muted = false;
    }
    this.emitChange();
  }

  toggleMute(): void {
    this.muted = !this.muted;
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
      this.positionMs = 0;
      this.playing = false;
      this.stopTimer();
    } else if (index < this.cursor) {
      this.cursor -= 1;
    } else if (wasCurrent) {
      this.cursor = Math.min(this.cursor, this.order.length - 1);
      this.positionMs = 0;
    }
    this.emitChange();
    this.emitProgress();
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

  private startCurrent(): void {
    this.positionMs = 0;
    this.playing = true;
    this.startTimer();
    this.emitChange();
    this.emitProgress();
  }

  private finish(): void {
    this.positionMs = this.currentDurationMs;
    this.playing = false;
    this.stopTimer();
    this.emitChange();
    this.emitProgress();
  }

  private startTimer(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = window.setInterval(this.tick, TICK_MS);
  }

  private stopTimer(): void {
    if (this.timer === null) {
      return;
    }
    window.clearInterval(this.timer);
    this.timer = null;
  }

  private readonly tick = (): void => {
    if (!this.playing) {
      return;
    }

    const duration = this.currentDurationMs;
    this.positionMs += TICK_MS;

    if (duration > 0 && this.positionMs >= duration) {
      if (this.cursor + 1 < this.order.length || this.repeat === "all") {
        this.next();
      } else {
        this.finish();
      }
      return;
    }

    this.emitProgress();
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
