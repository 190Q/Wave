import { getCurrentWindow } from "@tauri-apps/api/window";

import { applyWindowSlot } from "../lib/ipc";
import {
  cycleAccent,
  player,
  setNotice,
  toggleAlwaysOnTop,
  toggleMiniPlayer,
  toggleQueue,
} from "../lib/state";
import type { SnapPart } from "../types";
import { focusSearch } from "./topbar";

type AppWindow = ReturnType<typeof getCurrentWindow>;

async function withWindow(run: (window: AppWindow) => Promise<void>): Promise<void> {
  let window: AppWindow;
  try {
    window = getCurrentWindow();
  } catch {
    return;
  }

  try {
    await run(window);
  } catch {
    // Denied, or not running inside Tauri.
  }
}

/** Puts the window back where a slot remembers it, in whole or in part. */
async function snapWindow(slot: number, part: SnapPart): Promise<void> {
  try {
    await applyWindowSlot(slot, part);
  } catch {
    setNotice("No window frame is saved for that slot yet.");
  }
}

/** Runs the action a `Ctrl+Shift+<slot>` is bound to. */
export async function runSlotAction(action: string, slot: number): Promise<void> {
  switch (action) {
    case "snap-window":
      await snapWindow(slot, "frame");
      return;
    case "snap-window-size":
      await snapWindow(slot, "size");
      return;
    case "snap-window-position":
      await snapWindow(slot, "position");
      return;
    case "toggle-maximise":
      await withWindow((window) => window.toggleMaximize());
      return;
    case "minimise":
      await withWindow((window) => window.minimize());
      return;
    case "toggle-always-on-top":
      await toggleAlwaysOnTop();
      return;
    case "toggle-mini-player":
      await toggleMiniPlayer();
      return;
    case "play-pause":
      player.toggle();
      return;
    case "next":
      player.next();
      return;
    case "previous":
      player.previous();
      return;
    case "toggle-shuffle":
      player.setShuffle(!player.snapshot().shuffle);
      return;
    case "toggle-repeat":
      player.cycleRepeat();
      return;
    case "mute":
      player.toggleMute();
      return;
    case "toggle-queue":
      toggleQueue();
      return;
    case "focus-search":
      focusSearch();
      return;
    case "cycle-accent":
      cycleAccent();
      return;
    default:
      return;
  }
}
