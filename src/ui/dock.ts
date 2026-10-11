import { createIcon } from "../assets/icons/index";
import { formatDuration } from "../lib/format";
import {
  addTracksToPlaylist,
  currentTrack,
  getState,
  player,
  setVolume,
  subscribe,
  toggleLikeTrack,
  toggleQueue,
} from "../lib/state";
import { openMenu } from "./menu";

export function mountDock(): void {
  const dock = element("dock");
  const fill = element("dock-fill");
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
  const position = element("dock-position");

  if (
    !dock || !fill || !timeNow || !timeTotal || !like || !shuffle || !previous ||
    !play || !next || !repeat || !queueToggle || !volume || !position
  ) {
    return;
  }

  // The dock background is the seek bar: pressing anywhere on it jumps to that
  // point and dragging scrubs. Buttons keep their own clicks.
  let scrubbing = false;

  const seekTo = (clientX: number): void => {
    const rect = dock.getBoundingClientRect();
    if (rect.width > 0) {
      player.seekFraction((clientX - rect.left) / rect.width);
    }
  };

  dock.addEventListener("pointerdown", (event) => {
    if ((event.target as HTMLElement).closest("button, input")) {
      return;
    }
    scrubbing = true;
    dock.classList.add("is-scrubbing");
    dock.setPointerCapture(event.pointerId);
    seekTo(event.clientX);
  });

  dock.addEventListener("pointermove", (event) => {
    if (scrubbing) {
      seekTo(event.clientX);
    }
  });

  const stopScrub = (event: PointerEvent): void => {
    if (!scrubbing) {
      return;
    }
    scrubbing = false;
    dock.classList.remove("is-scrubbing");
    if (dock.hasPointerCapture(event.pointerId)) {
      dock.releasePointerCapture(event.pointerId);
    }
  };

  dock.addEventListener("pointerup", stopScrub);
  dock.addEventListener("pointercancel", stopScrub);

  play.addEventListener("click", () => player.toggle());
  previous.addEventListener("click", () => player.previous());
  next.addEventListener("click", () => player.next());
  shuffle.addEventListener("click", () => player.setShuffle(!player.snapshot().shuffle));
  repeat.addEventListener("click", () => player.cycleRepeat());
  queueToggle.addEventListener("click", () => toggleQueue());

  volume.addEventListener("input", () => setVolume(Number(volume.value)));

  like.addEventListener("click", () => {
    const track = currentTrack();
    if (track) {
      void toggleLikeTrack(track.id);
    }
  });

  like.addEventListener("contextmenu", (event) => {
    const track = currentTrack();
    if (!track) {
      return;
    }
    event.preventDefault();
    openMenu(like, [
      { label: "Play next", action: () => player.insertAfterCurrent(track.id) },
      { label: "Add to queue", action: () => player.appendToQueue(track.id) },
      ...getState().playlists.map((playlist) => ({
        label: `Add to ${playlist.name}`,
        action: () => void addTracksToPlaylist(playlist.id, [track.id]),
      })),
    ]);
  });

  const paintProgress = (positionMs: number, durationMs: number): void => {
    const fraction = durationMs > 0 ? Math.min(positionMs / durationMs, 1) : 0;
    fill.style.width = `${fraction * 100}%`;
    timeNow.textContent = formatDuration(positionMs);
  };

  let lastPlaying: boolean | null = null;
  let lastLiked: boolean | null = null;

  const renderTransport = (): void => {
    const snapshot = player.snapshot();
    const track = currentTrack();
    const idle = !track;

    if (snapshot.playing !== lastPlaying) {
      lastPlaying = snapshot.playing;
      play.replaceChildren(createIcon(snapshot.playing ? "pause" : "play"));
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

    volume.value = String(snapshot.volume);
    volume.disabled = idle;

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
