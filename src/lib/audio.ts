import { convertFileSrc } from "@tauri-apps/api/core";

import { subscribeActivity, uiActive } from "./activity";
import { FADE_MS, smoothstep } from "./fade";

export interface AudioEngineHandlers {
  /** The track ran to its end. */
  onEnded?: () => void;
  onBeforeLoad?: () => void;
  /** Metadata arrived, so the duration and the seekable range are known. */
  onLoaded?: () => void;
  /** The file could not be read or decoded. */
  onError?: () => void;
  onCorsRefused?: () => void;
  /** A fresh element, or one on its way out, for the equaliser to follow. */
  onElement?: (element: HTMLAudioElement, phase: "created" | "retired") => void;
  shouldReplace?: (element: HTMLAudioElement) => boolean;
  onBuffering?: (durationMs: number, element: HTMLAudioElement) => void;
  onPlaying?: () => void;
  onPause?: () => void;
}

const REPORT_BUFFERING_MS = 250;

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

  /** The file the element is holding, so a reload can ask for it again. */
  private loadedPath: string | null = null;

  private cors = true;

  /** Whether the element in hand got as far as reporting its metadata. */
  private elementLoaded = false;
  private elementPlayed = false;
  private waitingAt: number | null = null;

  private readonly retiring = new Map<HTMLAudioElement, number>();
  private readonly timeListeners = new Set<() => void>();
  private cancelReplacement: (() => void) | null = null;
  private incoming: { element: HTMLAudioElement; frame: number; factor: number } | null = null;
  private volume = 0;

  constructor(handlers: AudioEngineHandlers = {}) {
    this.handlers = handlers;
    this.el = this.create();
    document.addEventListener("visibilitychange", this.releaseIfHidden);
    subscribeActivity(this.releaseIfHidden);
  }

  private readonly releaseIfHidden = (): void => {
    if (!uiActive()) {
      this.finishTransitions();
    }
  };

  /** Whether a file is loaded, so a reload has something to ask for again. */
  get hasFile(): boolean {
    return this.loadedPath !== null;
  }

  /** Asks for files in a way the equaliser can read. */
  enableCors(): void {
    this.cors = true;
  }

  /** Stops asking for files in a way the equaliser can read. */
  disableCors(): void {
    this.cors = false;
  }

  /** The media clock, which is what everything on screen is timed against. */
  get positionMs(): number {
    if (this.requestedMs !== null) {
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

  /** The element in hand, for a report when the sound goes missing. */
  get element(): HTMLAudioElement {
    return this.el;
  }

  onTimeUpdate(listener: () => void): () => void {
    this.timeListeners.add(listener);
    return () => this.timeListeners.delete(listener);
  }

  /** Points the element at a file, crossing over from whatever was playing. */
  load(path: string, options: LoadOptions = {}): void {
    const { autoplay = false, positionMs = 0 } = options;

    this.cancelBypass();
    this.finishIncoming();
    this.handlers.onBeforeLoad?.();
    this.requestedMs = null;
    this.loadedPath = path;
    this.swap();
    this.elementLoaded = false;
    this.elementPlayed = false;
    this.waitingAt = null;
    // `preload` is read when the load starts, so it has to be set first.
    this.el.preload = autoplay ? "auto" : "metadata";
    const crossOrigin = this.cors ? "anonymous" : null;
    if (this.el.crossOrigin !== crossOrigin) {
      this.el.crossOrigin = crossOrigin;
    }
    this.el.src = sourceUrl(path);

    this.seek(positionMs);
    if (autoplay) {
      void this.play();
    }
  }

  /**
   * Loads the same file again on a brand new element. The cross-origin mode is
   * read when a load starts, so changing it only takes effect this way.
   */
  reload(autoplay: boolean, positionMs: number): void {
    const path = this.loadedPath;
    if (path === null) {
      return;
    }

    this.cancelBypass();
    this.finishIncoming();
    this.requestedMs = null;
    this.forget(this.el);
    this.release(this.el);
    this.el = this.create();
    this.el.preload = autoplay ? "auto" : "metadata";
    this.el.src = sourceUrl(path);

    this.seek(positionMs);
    if (autoplay) {
      void this.play();
    }
  }

  /** Releases the file, so the window does not hold a handle to it. */
  unload(): void {
    this.cancelBypass();
    this.finishIncoming();
    this.requestedMs = null;
    this.loadedPath = null;
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

  finishTransitions(): void {
    this.finishIncoming();
    for (const [el, frame] of this.retiring) {
      window.cancelAnimationFrame(frame);
      this.release(el);
    }
    this.retiring.clear();
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
    this.volume = Math.min(Math.max(level, 0), 1);
    this.el.volume = this.volume * (this.incoming?.factor ?? 1);
  }

  bypass(): void {
    if (this.cancelReplacement) return;
    const old = this.el;
    this.cancelReplacement = prepareDirectAudio(old, () => this.positionMs / 1000, () => {
      return this.el === old;
    }, (next) => {
      this.cancelReplacement = null;
      this.finishIncoming();
      const playing = !old.paused;
      const wasLoaded = this.elementLoaded;
      this.retire(old);
      this.el = next;
      this.listen(next);
      this.requestedMs = null;
      this.elementLoaded = next.readyState >= HTMLMediaElement.HAVE_METADATA;
      this.elementPlayed = playing;
      this.waitingAt = null;
      this.handlers.onElement?.(next, "created");
      if (playing && uiActive() && this.volume > 0) {
        const startedAt = performance.now();
        const incoming = { element: next, frame: 0, factor: 0 };
        this.incoming = incoming;
        const step = (now: number): void => {
          if (this.incoming !== incoming) return;
          incoming.factor = smoothstep(Math.min((now - startedAt) / FADE_MS, 1));
          next.volume = this.volume * incoming.factor;
          if (incoming.factor < 1) {
            incoming.frame = requestAnimationFrame(step);
          } else {
            this.incoming = null;
          }
        };
        incoming.frame = requestAnimationFrame(step);
      } else {
        next.volume = this.volume;
      }
      if (!wasLoaded && this.elementLoaded) this.handlers.onLoaded?.();
    }, () => { this.cancelReplacement = null; });
  }

  cancelBypass(): void {
    this.cancelReplacement?.();
    this.cancelReplacement = null;
  }

  private finishIncoming(): void {
    const incoming = this.incoming;
    if (!incoming) return;
    window.cancelAnimationFrame(incoming.frame);
    incoming.element.volume = this.volume;
    this.incoming = null;
  }

  /** A fresh, silent element, already listening. */
  private create(): HTMLAudioElement {
    const el = new Audio();
    el.preload = "metadata";
    el.volume = 0;
    el.crossOrigin = this.cors ? "anonymous" : null;

    this.listen(el);

    this.elementLoaded = false;
    this.elementPlayed = false;
    this.waitingAt = null;
    this.handlers.onElement?.(el, "created");
    return el;
  }

  private listen(el: HTMLAudioElement): void {
    el.addEventListener("ended", this.handleEnded);
    el.addEventListener("loadedmetadata", this.handleMetadata);
    el.addEventListener("durationchange", this.handleDuration);
    el.addEventListener("error", this.handleError);
    el.addEventListener("waiting", this.handleWaiting);
    el.addEventListener("playing", this.handlePlaying);
    el.addEventListener("pause", this.handlePause);
    el.addEventListener("seeking", this.handleInterrupted);
    el.addEventListener("timeupdate", this.handleTimeUpdate);
  }

  /** Takes a silent element, handing an audible one over to the cross-fade. */
  private swap(): void {
    if (!this.el.paused || this.handlers.shouldReplace?.(this.el)) {
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
    if (el.paused || from <= 0 || !uiActive()) {
      this.release(el);
      return;
    }

    const startedAt = performance.now();
    const step = (now: number): void => {
      const progress = Math.min((now - startedAt) / FADE_MS, 1);
      el.volume = from * (1 - smoothstep(progress));

      if (progress < 1) {
        this.retiring.set(el, requestAnimationFrame(step));
        return;
      }
      this.retiring.delete(el);
      this.release(el);
    };
    this.retiring.set(el, requestAnimationFrame(step));
  }

  /** Stops listening to an element that is on its way out. */
  private forget(el: HTMLAudioElement): void {
    el.removeEventListener("ended", this.handleEnded);
    el.removeEventListener("loadedmetadata", this.handleMetadata);
    el.removeEventListener("durationchange", this.handleDuration);
    el.removeEventListener("error", this.handleError);
    el.removeEventListener("waiting", this.handleWaiting);
    el.removeEventListener("playing", this.handlePlaying);
    el.removeEventListener("pause", this.handlePause);
    el.removeEventListener("seeking", this.handleInterrupted);
    el.removeEventListener("timeupdate", this.handleTimeUpdate);
  }

  private release(el: HTMLAudioElement): void {
    this.handlers.onElement?.(el, "retired");
    el.pause();
    el.removeAttribute("src");
    el.load();
  }

  private readonly handleMetadata = (): void => {
    this.elementLoaded = true;
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

  private readonly handleWaiting = (): void => {
    if (this.elementPlayed && !this.el.paused && !this.el.seeking && this.waitingAt === null) {
      this.waitingAt = performance.now();
    }
  };

  private readonly handlePlaying = (): void => {
    const waitingAt = this.waitingAt;
    this.waitingAt = null;
    this.elementPlayed = true;
    this.handlers.onPlaying?.();
    if (waitingAt !== null) {
      const elapsed = performance.now() - waitingAt;
      if (elapsed >= REPORT_BUFFERING_MS) {
        this.handlers.onBuffering?.(elapsed, this.el);
      }
    }
  };

  private readonly handleInterrupted = (): void => {
    this.waitingAt = null;
  };

  private readonly handlePause = (): void => {
    this.handleInterrupted();
    this.handlers.onPause?.();
  };

  private readonly handleTimeUpdate = (): void => {
    for (const listener of this.timeListeners) {
      listener();
    }
  };

  private readonly handleError = (): void => {
    if (this.cors && !this.elementLoaded) {
      this.handlers.onCorsRefused?.();
      return;
    }
    this.handlers.onError?.();
  };
}

/** Prepares a separate element while the original continues to play. */
export function prepareDirectAudio(
  original: HTMLAudioElement,
  position: () => number,
  valid: () => boolean,
  ready: (element: HTMLAudioElement) => void,
  failed: () => void,
): () => void {
  const element = new Audio();
  const controller = new AbortController();
  let finished = false;
  element.preload = "auto";
  element.crossOrigin = original.crossOrigin;
  element.volume = 0;

  const release = (): void => {
    element.pause();
    element.removeAttribute("src");
    element.load();
  };
  const cancel = (): void => {
    if (finished) return;
    finished = true;
    controller.abort();
    release();
  };
  const wait = (event: string): Promise<void> => new Promise((resolve, reject) => {
    const cleanup = (): void => {
      element.removeEventListener(event, success);
      element.removeEventListener("error", failure);
      controller.signal.removeEventListener("abort", failure);
    };
    const success = (): void => { cleanup(); resolve(); };
    const failure = (): void => { cleanup(); reject(new Error("Audio replacement cancelled")); };
    element.addEventListener(event, success);
    element.addEventListener("error", failure);
    controller.signal.addEventListener("abort", failure);
    if (controller.signal.aborted) failure();
  });
  const seek = async (): Promise<void> => {
    const seconds = Math.max(0, position());
    if (Number.isFinite(seconds) && Math.abs(element.currentTime - seconds) > 0.01) {
      element.currentTime = seconds;
      if (element.seeking) await wait("seeked");
    }
  };
  const run = async (): Promise<void> => {
    await Promise.resolve();
    if (finished || !valid()) throw new Error("Audio replacement cancelled");
    const source = original.currentSrc || original.src;
    if (source) {
      element.src = source;
      if (element.readyState < HTMLMediaElement.HAVE_METADATA) await wait("loadedmetadata");
      await seek();
      if (!original.paused && !original.ended) {
        await element.play();
        await seek();
      }
    }
    if (finished || !valid()) throw new Error("Audio replacement cancelled");
    if (original.paused && !element.paused) element.pause();
    if (!original.paused && element.paused && source) {
      await element.play();
      await seek();
    }
    if (finished || !valid()) throw new Error("Audio replacement cancelled");
    finished = true;
    ready(element);
  };
  void run().catch(() => {
    if (finished) return;
    cancel();
    failed();
  });
  return cancel;
}

/** The asset URL for a library file, for anything outside the engine. */
export function assetUrl(path: string): string {
  return sourceUrl(path);
}

export function trackAudioPath(path: string, id: string, streamBase: string | null): string {
  return streamBase ? `${streamBase}/${encodeURIComponent(id)}` : path;
}

/** The asset URL for a library file, or the bare path outside Tauri. */
function sourceUrl(path: string): string {
  if (path.startsWith("http://127.0.0.1:")) {
    return path;
  }
  try {
    return convertFileSrc(path);
  } catch {
    // `npm run dev` in a plain browser has no asset protocol.
    return path;
  }
}
