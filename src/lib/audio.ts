import { convertFileSrc } from "@tauri-apps/api/core";

import { FADE_MS, smoothstep } from "./fade";

export interface AudioEngineHandlers {
  /** The track ran to its end. */
  onEnded?: () => void;
  /** Metadata arrived, so the duration and the seekable range are known. */
  onLoaded?: () => void;
  /** The file could not be read or decoded. */
  onError?: () => void;
}

export interface LoadOptions {
  /** Start as soon as there is enough buffered to play. */
  autoplay?: boolean;
  /** Where the playhead should sit, in milliseconds. */
  positionMs?: number;
}

export class AudioEngine {
  private el: HTMLAudioElement;
  private readonly handlers: AudioEngineHandlers;

  private requestedMs: number | null = null;

  constructor(handlers: AudioEngineHandlers = {}) {
    this.handlers = handlers;
    this.el = this.create();
  }

  /** The media clock, which is what everything on screen is timed against. */
  get positionMs(): number {
    if (this.el.readyState < HTMLMediaElement.HAVE_METADATA && this.requestedMs !== null) {
      return this.requestedMs;
    }
    const seconds = this.el.currentTime;
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  }

  /** The decoded length, or `0` until it is known. */
  get durationMs(): number {
    const seconds = this.el.duration;
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  }

  get isPlaying(): boolean {
    return !this.el.paused && !this.el.ended;
  }

  /** Points the element at a file, crossing over from whatever was playing. */
  load(path: string, options: LoadOptions = {}): void {
    const { autoplay = false, positionMs = 0 } = options;

    this.requestedMs = null;
    this.swap();
    // `preload` is read when the load starts, so it has to be set first.
    this.el.preload = autoplay ? "auto" : "metadata";
    this.el.src = sourceUrl(path);

    this.seek(positionMs);
    if (autoplay) {
      void this.play();
    }
  }

  /** Releases the file, so the window does not hold a handle to it. */
  unload(): void {
    this.requestedMs = null;
    this.retire(this.el);
    this.el = this.create();
  }

  play(): Promise<void> {
    return this.el.play().catch(() => {
      // A load that interrupted an earlier `play()` rejects; a file that truly
      // cannot be played reports through `onError` instead.
    });
  }

  pause(): void {
    this.el.pause();
  }

  /** Moves the playhead, now or as soon as the element can be moved. */
  seek(positionMs: number): void {
    const ms = Math.max(positionMs, 0);
    if (this.el.readyState >= HTMLMediaElement.HAVE_METADATA) {
      this.el.currentTime = ms / 1000;
      this.requestedMs = null;
      return;
    }
    this.requestedMs = ms;
  }

  /** `0` to `1`, straight onto the element. */
  setVolume(level: number): void {
    this.el.volume = Math.min(Math.max(level, 0), 1);
  }

  /** A fresh, silent element, already listening. */
  private create(): HTMLAudioElement {
    const el = new Audio();
    el.preload = "metadata";
    el.volume = 0;

    el.addEventListener("ended", this.handleEnded);
    el.addEventListener("loadedmetadata", this.handleMetadata);
    el.addEventListener("durationchange", this.handleDuration);
    el.addEventListener("error", this.handleError);

    return el;
  }

  /** Takes a silent element, handing an audible one over to the cross-fade. */
  private swap(): void {
    if (!this.el.paused) {
      this.retire(this.el);
      this.el = this.create();
      return;
    }
    this.el.volume = 0;
  }

  /** Fades an element out, then lets go of the file behind it. */
  private retire(el: HTMLAudioElement): void {
    this.forget(el);

    const from = el.volume;
    if (el.paused || from <= 0) {
      this.release(el);
      return;
    }

    const startedAt = performance.now();
    const step = (now: number): void => {
      const progress = Math.min((now - startedAt) / FADE_MS, 1);
      el.volume = from * (1 - smoothstep(progress));

      if (progress < 1) {
        requestAnimationFrame(step);
        return;
      }
      this.release(el);
    };
    requestAnimationFrame(step);
  }

  /** Stops listening to an element that is on its way out. */
  private forget(el: HTMLAudioElement): void {
    el.removeEventListener("ended", this.handleEnded);
    el.removeEventListener("loadedmetadata", this.handleMetadata);
    el.removeEventListener("durationchange", this.handleDuration);
    el.removeEventListener("error", this.handleError);
  }

  private release(el: HTMLAudioElement): void {
    el.pause();
    el.removeAttribute("src");
    el.load();
  }

  private readonly handleMetadata = (): void => {
    const requested = this.requestedMs;
    this.requestedMs = null;
    if (requested !== null && requested > 0) {
      this.el.currentTime = requested / 1000;
    }
    this.handlers.onLoaded?.();
  };

  private readonly handleDuration = (): void => {
    this.handlers.onLoaded?.();
  };

  private readonly handleEnded = (): void => {
    this.handlers.onEnded?.();
  };

  private readonly handleError = (): void => {
    this.handlers.onError?.();
  };
}

/** The asset URL for a library file, or the bare path outside Tauri. */
function sourceUrl(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    // `npm run dev` in a plain browser has no asset protocol.
    return path;
  }
}
