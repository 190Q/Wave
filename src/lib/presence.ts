import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { MediaControl, NowPlaying } from "../types";
import { isAndroidPlatform } from "./device";
import { reportPlaybackActivity, setNowPlaying, setQueue, showMainWindow } from "./ipc";
import {
  colourFor,
  currentTrack,
  getState,
  player,
  setVolume,
  stepTrack,
  subscribe,
  trackById,
} from "./state";

/** Sent by the backend when the system's own controls ask for something. */
const CONTROL_EVENT = "media-control";

/** How often the position is sent while a song plays. */
const POSITION_INTERVAL_MS = 1000;

/** How far the position has to move before it is worth sending again. */
const POSITION_STEP_MS = 900;

/** How far one fast forward or rewind step moves. */
const SEEK_STEP_MS = 10_000;

/** How many songs of the play order are handed to the system's controls. */
const QUEUE_LIMIT = 50;

declare global {
  interface Window {
    wavePlayback?: { postMessage(message: string): void };
  }
}

function sendAndroidUpdate(update: object): boolean {
  if (!isAndroidPlatform || !window.wavePlayback) return false;
  try {
    window.wavePlayback.postMessage(JSON.stringify(update));
    return true;
  } catch {
    return false;
  }
}

/** Keeps the system's own media controls, and Discord, in step with the player. */
export function mountPresence(): void {
  /** What was last sent, so a song that has not moved is not sent again. */
  let sent: NowPlaying | null | undefined;
  let pending: { song: NowPlaying | null } | null = null;
  let sending = false;
  let retryNeeded = false;
  let timer: number | null = null;
  let lastPlaying: boolean | undefined;
  let playbackRetry = false;
  let playbackWrites = Promise.resolve();

  const syncTimer = (): void => {
    const needed = showing() && (player.snapshot().playing || retryNeeded || playbackRetry);
    if (needed && timer === null) {
      timer = window.setInterval(() => {
        if (retryNeeded) {
          sent = undefined;
          retryNeeded = false;
        }
        sync();
      }, POSITION_INTERVAL_MS);
    } else if (!needed && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };

  const send = async (): Promise<void> => {
    sending = true;
    while (pending !== null) {
      const { song } = pending;
      pending = null;
      try {
        if (!sendAndroidUpdate({ type: "song", song })) {
          await setNowPlaying(song);
        }
      } catch {
        if (pending === null && sent === song) {
          retryNeeded = true;
          syncTimer();
        }
      }
    }
    sending = false;
  };

  const push = (): void => {
    if (!showing()) {
      // Nothing is watching, so nothing is sent. Whatever comes next, or
      // whichever switch is turned back on, starts from nothing.
      sent = null;
      pending = null;
      retryNeeded = false;
      return;
    }

    const song = nowPlaying();
    if (sent !== undefined && !worthSending(song, sent)) {
      return;
    }
    sent = song;
    retryNeeded = false;
    pending = { song };
    if (!sending) {
      void send();
    }
  };

  /** The queue revision last handed over, so an order that has not moved is left alone. */
  let sentQueue = -1;

  const pushQueue = (): void => {
    if (!showing()) {
      sentQueue = -1;
      return;
    }

    const snapshot = player.snapshot();
    if (snapshot.queueRevision === sentQueue) {
      return;
    }
    sentQueue = snapshot.queueRevision;

    const tracks = snapshot.order.slice(0, QUEUE_LIMIT).flatMap((id) => {
      const track = trackById(id);
      return track
        ? [
            {
              id: track.id,
              title: track.title,
              artist: track.artist ?? "",
              durationMs: track.durationMs,
            },
          ]
        : [];
    });

    if (!sendAndroidUpdate({ type: "queue", tracks })) {
      void setQueue(tracks).catch(() => {
        // Not running inside Tauri, or the backend is no longer there.
      });
    }
  };

  const sync = (): void => {
    if (isAndroidPlatform) {
      const playing = player.snapshot().playing;
      if (playing !== lastPlaying) {
        lastPlaying = playing;
        playbackRetry = false;
        playbackWrites = playbackWrites.then(() => reportPlaybackActivity(playing)).catch(() => {
          if (lastPlaying === playing) {
            lastPlaying = undefined;
            playbackRetry = true;
            syncTimer();
          }
        });
      }
    }
    push();
    syncTimer();
  };

  player.onChange(sync);
  player.onChange(pushQueue);
  player.onSeek(sync);
  subscribe(sync);
  subscribe(pushQueue);

  if (isAndroidPlatform) {
    window.addEventListener("wave:media-control", (event) => {
      apply((event as CustomEvent<MediaControl>).detail);
    });
  } else {
    void listen<MediaControl>(CONTROL_EVENT, (event) => apply(event.payload)).catch(() => {
      // Not running inside Tauri, for example `npm run dev` in a browser.
    });
  }
}

/** Android also needs playback updates for its foreground service. */
function showing(): boolean {
  const { systemMediaControls, discordPresence } = getState().settings;
  return isAndroidPlatform || systemMediaControls || discordPresence === true;
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
    colour: colourFor(track),
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
    next.colour !== last.colour ||
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
    case "skipToQueueItem": {
      const order = player.snapshot().order;
      const id = order[Math.round(control.value ?? -1)];
      if (id !== undefined) {
        player.playTrack(id);
      }
      return;
    }
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
