import { listen } from "@tauri-apps/api/event";

import type { ApiCommand, PlayerReport } from "../types";
import { reportApiState } from "./ipc";
import {
  collectionById,
  openCollection,
  playCollection,
  player,
  playTrackInContext,
  setVolume,
  stepTrack,
} from "./state";

/** Sent by the backend when the local API asks for something. */
const COMMAND_EVENT = "api-command";

/** How often the position is reported while a song plays. */
const POSITION_INTERVAL_MS = 1000;

/** How far one rewind or fast forward step moves when the API sends no distance. */
const SEEK_STEP_MS = 10_000;

/** Keeps the local API in step with the player, in both directions. */
export function mountApi(): void {
  player.onChange(() => report(null));
  // A song playing on its own moves without a change, so the position is pushed
  // on a timer rather than only when something happens.
  window.setInterval(() => {
    if (player.snapshot().playing) {
      report(null);
    }
  }, POSITION_INTERVAL_MS);

  void listen<ApiCommand>(COMMAND_EVENT, (event) => {
    apply(event.payload);
    // The reply carries the id, so the request waiting on it can be answered.
    report(event.payload.id);
  }).catch(() => {
    // Not running inside Tauri, for example `npm run dev` in a browser.
  });
}

/** Sends the player as it stands, answering `command` when one was just applied. */
function report(command: string | null): void {
  const snapshot = player.snapshot();
  const payload: PlayerReport = {
    command,
    currentId: snapshot.currentId,
    sourceId: snapshot.sourceId,
    sourceName: snapshot.sourceName,
    order: snapshot.order,
    sourceOrder: snapshot.sourceOrder,
    cursor: snapshot.cursor,
    positionMs: Math.round(snapshot.positionMs),
    durationMs: Math.round(snapshot.durationMs),
    playing: snapshot.playing,
    shuffle: snapshot.shuffle,
    repeat: snapshot.repeat,
    volume: snapshot.volume,
    muted: snapshot.muted,
  };
  void reportApiState(payload).catch(() => {
    // Not running inside Tauri, or the backend is no longer there.
  });
}

/** Runs whatever the local API asked for, against what the window already has. */
function apply(command: ApiCommand): void {
  switch (command.action) {
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
    case "seek":
      player.seek(command.value ?? 0);
      return;
    case "seekBy":
      player.seek(player.snapshot().positionMs + (command.value ?? SEEK_STEP_MS));
      return;
    case "volume":
      setVolume(command.value ?? player.snapshot().volume);
      return;
    case "mute":
      if (command.flag !== null && command.flag !== player.snapshot().muted) {
        player.toggleMute();
      }
      return;
    case "shuffle":
      if (command.flag !== null) {
        player.setShuffle(command.flag);
      }
      return;
    case "repeat":
      player.setRepeat(command.text === "all" ? "all" : "off");
      return;
    case "playTrack":
      if (command.trackId) {
        playTrackInContext(command.trackId);
      }
      return;
    case "playCollection": {
      const collection = collectionById(command.sourceId ?? "");
      if (collection) {
        playCollection(collection.id);
      }
      return;
    }
    case "openCollection": {
      const collection = collectionById(command.sourceId ?? "");
      if (collection) {
        openCollection(collection.id);
      }
      return;
    }
    case "queue":
      player.setQueue(
        command.sourceId ?? "",
        command.sourceName ?? "",
        command.trackIds,
        command.startTrackId ?? undefined,
      );
      return;
    case "queueAppend":
      if (command.trackId) {
        player.appendToQueue(command.trackId);
      }
      return;
    case "queueNext":
      if (command.trackId) {
        player.insertAfterCurrent(command.trackId);
      }
      return;
    case "queueRemove":
      if (command.trackId) {
        player.removeFromQueue(command.trackId);
      }
      return;
  }
}
