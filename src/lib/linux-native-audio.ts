import { listen } from "@tauri-apps/api/event";

import type { ApiCommand, LinuxNativePlaybackStatus, LinuxNativePlaybackSync, NativePlaybackTrack } from "../types";
import * as ipc from "./ipc";
import { AudioEngine, type AudioEngineHandlers, type LoadOptions } from "./audio";

const STATE_EVENT = "linux-native-playback-state";

/** Uses GStreamer when active and WebKit as a compatibility fallback. */
export class LinuxNativeAudioEngine extends AudioEngine {
  private readonly nativeTimeListeners = new Set<() => void>();
  private readonly stateListeners = new Set<(status: LinuxNativePlaybackStatus) => void>();
  private readonly paths = new Map<string, string>();
  private writes: Promise<void> = Promise.resolve();
  private current: LinuxNativePlaybackStatus | null = null;
  private receivedAt = 0;
  private revision = -1;
  private connected = false;
  private suppressFallbackEvents = false;
  private commandId = 0;
  private activationPending = false;
  private pendingPositionMs: number | null = null;

  constructor(handlers: AudioEngineHandlers = {}) {
    let engine: LinuxNativeAudioEngine | null = null;
    super({
      ...handlers,
      onPause: () => {
        if (!engine?.suppressFallbackEvents) {
          handlers.onPause?.();
        }
      },
      onPlaying: () => {
        if (!engine?.suppressFallbackEvents) {
          handlers.onPlaying?.();
        }
      },
    });
    engine = this;
  }

  get active(): boolean {
    return this.current?.active === true;
  }

  get pending(): boolean {
    return this.activationPending;
  }

  get status(): LinuxNativePlaybackStatus | null {
    return this.current;
  }

  connect(): Promise<LinuxNativePlaybackStatus | null> {
    if (this.connected) {
      return Promise.resolve(this.current);
    }
    this.connected = true;
    return listen<LinuxNativePlaybackStatus>(STATE_EVENT, (event) => this.accept(event.payload))
      .catch(() => undefined)
      .then(() => ipc.linuxNativePlaybackState())
      .then((status) => {
        this.accept(status);
        return this.current;
      })
      .catch(() => this.current);
  }

  onState(listener: (status: LinuxNativePlaybackStatus) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  rememberTracks(tracks: readonly NativePlaybackTrack[]): void {
    for (const track of tracks) {
      this.paths.set(track.id, track.path);
    }
  }

  prepareNative(): void {
    if (this.active || this.activationPending) {
      return;
    }
    this.pendingPositionMs = super.positionMs;
    this.activationPending = true;
    this.releaseFallback();
  }

  abortNative(): void {
    this.activationPending = false;
    this.pendingPositionMs = null;
  }

  private releaseFallback(): void {
    this.suppressFallbackEvents = true;
    super.finishTransitions();
    super.pause();
    super.unload();
    this.suppressFallbackEvents = false;
  }

  sync(sync: LinuxNativePlaybackSync): Promise<LinuxNativePlaybackStatus> {
    this.rememberTracks(sync.tracks);
    return this.enqueue(() => ipc.linuxNativePlaybackSync(sync));
  }

  command(command: ApiCommand): Promise<LinuxNativePlaybackStatus> {
    return this.enqueue(() => ipc.linuxNativePlaybackCommand(command));
  }

  override uses(path: string): boolean {
    const currentPath = this.current?.report.currentId
      ? this.paths.get(this.current.report.currentId)
      : undefined;
    return currentPath === path || super.uses(path);
  }

  override get positionMs(): number {
    if (this.activationPending && this.pendingPositionMs !== null) {
      return this.pendingPositionMs;
    }
    if (!this.active || !this.current) {
      return super.positionMs;
    }
    const report = this.current.report;
    const elapsed = report.playing ? Math.max(0, performance.now() - this.receivedAt) : 0;
    const position = report.positionMs + elapsed;
    return report.durationMs > 0 ? Math.min(position, report.durationMs) : position;
  }

  override get durationMs(): number {
    return this.active ? this.current?.report.durationMs ?? 0 : super.durationMs;
  }

  override get isPlaying(): boolean {
    return this.active ? this.current?.report.playing === true : super.isPlaying;
  }

  override onTimeUpdate(listener: () => void): () => void {
    this.nativeTimeListeners.add(listener);
    const stopFallback = super.onTimeUpdate(listener);
    return () => {
      this.nativeTimeListeners.delete(listener);
      stopFallback();
    };
  }

  override load(path: string, options: LoadOptions = {}): void {
    if (!this.nativeControlled()) {
      super.load(path, options);
    }
  }

  override reload(autoplay: boolean, positionMs: number): void {
    if (!this.nativeControlled()) {
      super.reload(autoplay, positionMs);
    }
  }

  override unload(): void {
    if (!this.nativeControlled()) {
      super.unload();
    }
  }

  override play(): Promise<void> {
    return this.nativeControlled() ? Promise.resolve() : super.play();
  }

  override pause(): void {
    if (!this.nativeControlled()) {
      super.pause();
    }
  }

  override seek(positionMs: number): void {
    if (this.active) {
      void this.command({
        id: `linux-native-engine-${++this.commandId}`,
        action: "seek",
        value: Math.round(Math.max(positionMs, 0)),
        trackId: null,
        trackIds: [],
        sourceId: null,
        sourceName: null,
        startTrackId: null,
        text: null,
        flag: null,
      }).catch(() => {});
    } else if (this.activationPending) {
      this.pendingPositionMs = Math.max(positionMs, 0);
    } else {
      super.seek(positionMs);
    }
  }

  override setVolume(level: number): void {
    if (!this.nativeControlled()) {
      super.setVolume(level);
    }
  }

  override finishTransitions(): void {
    if (!this.nativeControlled()) {
      super.finishTransitions();
    }
  }

  override enableCors(): void {
    if (!this.nativeControlled()) {
      super.enableCors();
    }
  }

  override disableCors(): void {
    if (!this.nativeControlled()) {
      super.disableCors();
    }
  }

  override bypass(): void {
    if (!this.nativeControlled()) {
      super.bypass();
    }
  }

  override cancelBypass(): void {
    if (!this.nativeControlled()) {
      super.cancelBypass();
    }
  }

  private enqueue(operation: () => Promise<LinuxNativePlaybackStatus>): Promise<LinuxNativePlaybackStatus> {
    const queued = this.writes.then(operation);
    this.writes = queued.then(
      (status) => {
        this.accept(status);
      },
      () => {},
    );
    return queued;
  }

  private accept(status: LinuxNativePlaybackStatus): void {
    if (status.revision <= this.revision) {
      return;
    }
    const wasNativeControlled = this.nativeControlled();
    if (status.active && !wasNativeControlled) {
      this.releaseFallback();
    }
    this.current = status;
    this.revision = status.revision;
    this.activationPending = false;
    this.pendingPositionMs = null;
    this.receivedAt = performance.now();
    for (const listener of this.nativeTimeListeners) {
      listener();
    }
    for (const listener of this.stateListeners) {
      listener(status);
    }
  }

  private nativeControlled(): boolean {
    return this.active || this.activationPending;
  }
}
