import type { Playback } from "../types";
import { AudioEngine, type AudioEngineHandlers, type LoadOptions } from "./audio";

export interface NativeSnapshot {
  type: string;
  available: boolean;
  live: boolean;
  currentId: string | null;
  path: string | null;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  playback: Playback;
  eqActive?: boolean;
  eqPreampDb?: number;
}

declare global {
  interface Window {
    waveNativePlayback?: {
      postMessage(message: string): void;
      onmessage: ((event: MessageEvent<string>) => void) | null;
    };
  }
}

export class AndroidAudioEngine extends AudioEngine {
  private current: NativeSnapshot | null = null;
  private receivedAt = 0;
  private readonly nativeTimeListeners = new Set<() => void>();
  private readonly nativeReleaseListeners = new Set<() => void>();
  private readonly stateListeners = new Set<(state: NativeSnapshot) => void>();
  private connected: Promise<NativeSnapshot | null> | null = null;

  constructor(
    private readonly nativeHandlers: AudioEngineHandlers,
    private readonly onNativeEnded: () => void,
  ) {
    super();
  }

  connect(): Promise<NativeSnapshot | null> {
    if (this.connected) return this.connected;
    this.connected = new Promise((resolve) => {
      const bridge = window.waveNativePlayback;
      if (!bridge) {
        resolve(null);
        return;
      }
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }, 5000);
      bridge.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as NativeSnapshot;
          if (message.type === "error") {
            this.nativeHandlers.onError?.();
            return;
          }
          if (message.type === "ended") {
            this.onNativeEnded();
            return;
          }
          if (message.type !== "snapshot" && message.type !== "state") return;
          this.current = message;
          this.receivedAt = performance.now();
          if (message.type === "snapshot" && !settled) {
            settled = true;
            window.clearTimeout(timeout);
            resolve(message);
          }
          for (const listener of this.nativeTimeListeners) listener();
          if (message.type === "state") {
            for (const listener of this.stateListeners) listener(message);
          }
        } catch {
          // Ignore malformed messages from a disconnected bridge.
        }
      };
      this.send({ type: "connect" });
    });
    return this.connected;
  }

  onState(listener: (state: NativeSnapshot) => void): void {
    this.stateListeners.add(listener);
  }

  send(message: object): void {
    window.waveNativePlayback?.postMessage(JSON.stringify(message));
  }

  override uses(path: string): boolean {
    return this.current?.path === path;
  }

  override onRelease(listener: () => void): () => void {
    this.nativeReleaseListeners.add(listener);
    return () => this.nativeReleaseListeners.delete(listener);
  }

  override get positionMs(): number {
    if (!this.current) return 0;
    const elapsed = this.current.playing ? Math.max(0, performance.now() - this.receivedAt) : 0;
    const position = this.current.positionMs + elapsed;
    return this.current.durationMs > 0 ? Math.min(position, this.current.durationMs) : position;
  }

  override get durationMs(): number {
    return this.current?.durationMs ?? 0;
  }

  override get isPlaying(): boolean {
    return this.current?.playing ?? false;
  }

  override onTimeUpdate(listener: () => void): () => void {
    this.nativeTimeListeners.add(listener);
    return () => this.nativeTimeListeners.delete(listener);
  }

  override load(path: string, options: LoadOptions = {}): void {
    this.nativeHandlers.onBeforeLoad?.();
    if (options.autoplay) this.send({ type: "volume", volume: 0 });
    this.send({
      type: "load",
      path,
      positionMs: Math.round(options.positionMs ?? 0),
      autoplay: options.autoplay ?? false,
    });
    for (const listener of this.nativeReleaseListeners) listener();
  }

  override reload(autoplay: boolean, positionMs: number): void {
    if (!autoplay) {
      this.pause();
      if (this.current?.path) this.seek(positionMs);
      return;
    }
    if (this.current?.path) this.load(this.current.path, { autoplay, positionMs });
  }

  override unload(): void {
    this.send({ type: "clear" });
    this.current = null;
    for (const listener of this.nativeReleaseListeners) listener();
  }

  override play(): Promise<void> {
    this.send({ type: "play" });
    return Promise.resolve();
  }

  override pause(): void {
    this.send({ type: "pause" });
  }

  override seek(positionMs: number): void {
    this.send({ type: "seek", positionMs: Math.round(Math.max(0, positionMs)) });
  }

  override setVolume(level: number): void {
    if (this.current) this.send({ type: "volume", volume: Math.min(Math.max(level, 0), 1) });
  }

  override finishTransitions(): void {}
  override enableCors(): void {}
  override disableCors(): void {}
  override bypass(): void {}
  override cancelBypass(): void {}
}
