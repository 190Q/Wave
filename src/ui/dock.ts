import { createIcon } from "../assets/icons/index";
import { formatDuration } from "../lib/format";
import { bounce, reduceMotionActive } from "../lib/motion";
import { MAX_VOLUME, MIN_VOLUME } from "../lib/player";
import {
  currentTrack,
  getState,
  player,
  setVolume,
  stepVolume,
  subscribe,
  toggleLikeTrack,
  toggleQueue,
} from "../lib/state";


const VOLUME_FILL_MS = 200;

let markVolumeStep: (() => void) | null = null;
    
export function stepVolumeFromKey(direction: number): void {
  markVolumeStep?.();
  stepVolume(direction);
}

export function mountDock(): void {
  const dock = element("dock");
  const timeNow = element("time-now");
  const timeTotal = element("time-total");
  const like = element<HTMLButtonElement>("like");
  const shuffle = element<HTMLButtonElement>("shuffle");
  const previous = element<HTMLButtonElement>("prev");
  const play = element<HTMLButtonElement>("play");
  const next = element<HTMLButtonElement>("next");
  const repeat = element<HTMLButtonElement>("repeat");
  const queueToggle = element<HTMLButtonElement>("queue-toggle");
  const volume = element<HTMLInputElement>("volume");
  const volumeBars = element("volume-bars");
  const position = element("dock-position");

  if (
    !dock || !timeNow || !timeTotal || !like || !shuffle || !previous ||
    !play || !next || !repeat || !queueToggle || !volume || !volumeBars || !position
  ) {
    return;
  }

  // The dock background is the seek bar: pressing anywhere on it shows where
  // the track would land, and letting go takes it there. Buttons keep their own
  // clicks.
  let scrubbing = false;
  let scrubFraction = 0;

  /** How far along the bar is, `0` to `1`; the stylesheet draws the fill and its edge. */
  const setProgress = (fraction: number): void => {
    dock.style.setProperty("--progress", String(fraction));
  };

  const fractionAt = (clientX: number): number => {
    const rect = dock.getBoundingClientRect();
    if (rect.width <= 0) {
      return 0;
    }
    return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
  };

  /** Follows the pointer while the dock is held, without moving the track. */
  const previewSeek = (fraction: number): void => {
    scrubFraction = fraction;
    setProgress(fraction);
    timeNow.textContent = formatDuration(fraction * player.snapshot().durationMs);
  };

  dock.addEventListener("pointerdown", (event) => {
    if ((event.target as HTMLElement).closest("button, input")) {
      return;
    }
    scrubbing = true;
    dock.classList.add("is-scrubbing");
    dock.setPointerCapture(event.pointerId);
    previewSeek(fractionAt(event.clientX));
  });

  dock.addEventListener("pointermove", (event) => {
    if (scrubbing) {
      previewSeek(fractionAt(event.clientX));
    }
  });

  const stopScrub = (event: PointerEvent, commit: boolean): void => {
    if (!scrubbing) {
      return;
    }
    scrubbing = false;
    dock.classList.remove("is-scrubbing");
    if (dock.hasPointerCapture(event.pointerId)) {
      dock.releasePointerCapture(event.pointerId);
    }
    // The song only moves once the pointer is let go.
    if (commit) {
      player.seekFraction(scrubFraction);
    }
    paintProgress(player.snapshot().positionMs, player.snapshot().durationMs);
  };

  dock.addEventListener("pointerup", (event) => stopScrub(event, true));
  dock.addEventListener("pointercancel", (event) => stopScrub(event, false));

  play.addEventListener("click", () => player.toggle());
  previous.addEventListener("click", () => player.previous());
  next.addEventListener("click", () => player.next());
  shuffle.addEventListener("click", () => player.setShuffle(!player.snapshot().shuffle));
  repeat.addEventListener("click", () => player.cycleRepeat());
  queueToggle.addEventListener("click", () => toggleQueue());

  const barCount = 10;
  const bars = Array.from({ length: barCount }, (_, index) => {
    const bar = document.createElement("span");
    bar.className = "volume-bar";
    bar.style.height = `${((7 + index) / 16) * 100}%`;
    bar.style.setProperty("--index", `${index}`);
    return bar;
  });
  volumeBars.replaceChildren(...bars);

  volume.min = String(MIN_VOLUME);
  volume.max = String(MAX_VOLUME);

  const paintVolume = (level: number): void => {
    volumeBars.style.setProperty("--level", `${(level / MAX_VOLUME) * barCount}`);
  };

  let steppingTimer: number | null = null;
  const markStepping = (): void => {
    if (reduceMotionActive()) {
      return;
    }
    volumeBars.classList.add("is-stepping");
    if (steppingTimer !== null) {
      window.clearTimeout(steppingTimer);
    }
    // A little longer than the stylesheet's fill, so it is never cut short.
    steppingTimer = window.setTimeout(() => {
      steppingTimer = null;
      volumeBars.classList.remove("is-stepping");
    }, VOLUME_FILL_MS);
  };
  markVolumeStep = markStepping;

  let draggingVolume = false;

  const commitVolume = (): void => {
    draggingVolume = false;
    setVolume(Number(volume.value));
  };

  volume.addEventListener("pointerdown", () => {
    draggingVolume = true;
  });

  volume.addEventListener("input", () => {
    draggingVolume = true;
    paintVolume(Number(volume.value));
  });

  volume.addEventListener("change", commitVolume);

  volume.addEventListener("pointerup", () => {
    if (draggingVolume) {
      commitVolume();
    }
  });

  volume.addEventListener("pointercancel", () => {
    draggingVolume = false;
  });

  volume.addEventListener("blur", () => {
    draggingVolume = false;
  });

  // The slider's own arrows step by one, so the shortcut takes them over.
  volume.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      stepVolumeFromKey(event.key === "ArrowUp" ? 1 : -1);
    }
  });

  like.addEventListener("click", () => {
    const track = currentTrack();
    if (track) {
      bounce(like);
      void toggleLikeTrack(track.id);
    }
  });

  const paintProgress = (positionMs: number, durationMs: number): void => {
    if (document.documentElement.classList.contains("is-theming") || scrubbing) {
      return;
    }
    const fraction = durationMs > 0 ? Math.min(positionMs / durationMs, 1) : 0;
    setProgress(fraction);
    timeNow.textContent = formatDuration(positionMs);
  };

  let lastPlaying: boolean | null = null;
  let lastLiked: boolean | null = null;

  const swap = document.createElement("span");
  swap.className = "icon-swap";
  swap.append(createIcon("play"), createIcon("pause"));
  play.replaceChildren(swap);

  const renderTransport = (): void => {
    const snapshot = player.snapshot();
    const track = currentTrack();
    const idle = !track;

    if (snapshot.playing !== lastPlaying) {
      lastPlaying = snapshot.playing;
      play.classList.toggle("is-playing", snapshot.playing);
      play.setAttribute("aria-label", snapshot.playing ? "Pause" : "Play");
    }

    const liked = track ? getState().likes.has(track.id) : false;
    if (liked !== lastLiked) {
      lastLiked = liked;
      like.replaceChildren(createIcon(liked ? "like-filled" : "like"));
      like.classList.toggle("is-on", liked);
      like.setAttribute("aria-label", liked ? "Remove from Liked Songs" : "Add to Liked Songs");
    }

    shuffle.classList.toggle("is-on", snapshot.shuffle);
    shuffle.setAttribute("aria-pressed", String(snapshot.shuffle));

    repeat.classList.toggle("is-on", snapshot.repeat !== "off");
    repeat.setAttribute("aria-pressed", String(snapshot.repeat !== "off"));
    repeat.setAttribute("aria-label", snapshot.repeat === "off" ? "Repeat off" : "Repeat all");

    queueToggle.classList.toggle("is-on", getState().queueOpen);

    volume.disabled = idle;
    if (!draggingVolume) {
      volume.value = String(snapshot.volume);
      paintVolume(snapshot.volume);
    }

    timeTotal.textContent = formatDuration(snapshot.durationMs);
    position.textContent = track ? `${snapshot.cursor + 1} / ${snapshot.order.length}` : "";

    for (const control of [previous, play, next, shuffle, repeat]) {
      control.toggleAttribute("disabled", idle);
    }

    paintProgress(snapshot.positionMs, snapshot.durationMs);
  };

  player.onProgress(paintProgress);
  player.onChange(renderTransport);
  subscribe(renderTransport);
  renderTransport();
}

function element<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
