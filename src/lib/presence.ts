import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { MediaControl, NowPlaying } from "../types";
import { setNowPlaying, showMainWindow } from "./ipc";
import { currentTrack, getState, player, setVolume, stepTrack, subscribe } from "./state";

/** Sent by the backend when the system's own controls ask for something. */
const CONTROL_EVENT = "media-control";

/** How often the position is sent while a song plays. */
const POSITION_INTERVAL_MS = 1000;

/** How far the position has to move before it is worth sending again. */
const POSITION_STEP_MS = 900;

/** How far one fast forward or rewind step moves. */
const SEEK_STEP_MS = 10_000;

/** Keeps the system's own media controls, and Discord, in step with the player. */
export function mountPresence(): void {
  /** What was last sent, so a song that has not moved is not sent again. */
  let sent: NowPlaying | null = null;

  const push = (): void => {
    if (!showing()) {
      // Nothing is watching, so nothing is sent. Whatever comes next, or
      // whichever switch is turned back on, starts from nothing.
      sent = null;
      return;
    }

    const song = nowPlaying();
    if (!worthSending(song, sent)) {
      return;
    }
    sent = song;
    void setNowPlaying(song).catch(() => {
      // Not running inside Tauri, or the backend is no longer there.
    });
  };

  player.onChange(push);
  // A switch turned on mid-song has nothing to show until the next update.
  subscribe(push);
  window.setInterval(() => {
    if (player.snapshot().playing) {
      push();
    }
  }, POSITION_INTERVAL_MS);

  void listen<MediaControl>(CONTROL_EVENT, (event) => apply(event.payload)).catch(() => {
    // Not running inside Tauri, for example `npm run dev` in a browser.
  });
}

/** True while either surface is switched on. */
function showing(): boolean {
  const { systemMediaControls, discordPresence } = getState().settings;
  return systemMediaControls || discordPresence;
}

/** The song as the two surfaces want it, or `null` when nothing is loaded. */
function nowPlaying(): NowPlaying | null {
  const track = currentTrack();
  if (!track) {
    return null;
  }

  const snapshot = player.snapshot();
  return {
    title: track.title,
    artist: track.artist ?? "",
    album: track.album ?? "",
    durationMs: Math.round(snapshot.durationMs),
    positionMs: Math.round(snapshot.positionMs),
    playing: snapshot.playing,
    artwork: track.artworkPath ?? "",
  };
}

/** True when the surfaces would be showing something other than what they hold. */
function worthSending(next: NowPlaying | null, last: NowPlaying | null): boolean {
  if (!next || !last) {
    return next !== last;
  }

  if (
    next.title !== last.title ||
    next.artist !== last.artist ||
    next.album !== last.album ||
    next.artwork !== last.artwork ||
    next.durationMs !== last.durationMs ||
    next.playing !== last.playing
  ) {
    return true;
  }

  return Math.abs(next.positionMs - last.positionMs) >= POSITION_STEP_MS;
}

/** Runs whatever the system's own controls asked for. */
function apply(control: MediaControl): void {
  const position = player.snapshot().positionMs;

  switch (control.action) {
    case "play":
      player.play();
      return;
    case "pause":
      player.pause();
      return;
    case "toggle":
      player.toggle();
      return;
    case "next":
      stepTrack(1);
      return;
    case "previous":
      stepTrack(-1);
      return;
    case "stop":
      player.pause();
      player.seek(0);
      return;
    case "seekBy":
      player.seek(position + (control.value ?? SEEK_STEP_MS));
      return;
    case "seekTo":
      player.seek(control.value ?? 0);
      return;
    case "volume":
      setVolume(Math.round(control.value ?? 0));
      return;
    case "raise":
      raise();
      return;
  }
}

/** Brings the window up, for a click on the desktop's own media widget. */
function raise(): void {
  void showMainWindow().catch(() => {
    // Not running inside Tauri.
  });

  try {
    void getCurrentWindow().setFocus().catch(() => {
      // The window refused the focus, which is not worth reporting.
    });
  } catch {
    // Not running inside Tauri.
  }
}
