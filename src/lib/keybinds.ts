export interface Keybind {
  keys: string;
  action: string;
}

export interface KeybindGroup {
  title: string;
  note?: string;
  binds: Keybind[];
}

export const KEYBIND_GROUPS: KeybindGroup[] = [
  {
    title: "Global",
    note: "Ignored while a text field has focus. Arrow steps are capped at a backlog of three. Hold m and tap 1-4 to put the mini player in a corner: 1 top left, 2 top right, 3 bottom left, 4 bottom right.",
    binds: [
      { keys: "Space", action: "Play or pause" },
      { keys: "ArrowRight", action: "Next track" },
      { keys: "ArrowLeft", action: "Previous track" },
      { keys: "ArrowUp", action: "Volume up" },
      { keys: "ArrowDown", action: "Volume down" },
      { keys: "o", action: "Open search" },
      { keys: "s", action: "Toggle shuffle" },
      { keys: "r", action: "Toggle repeat" },
      { keys: "q", action: "Toggle queue" },
      { keys: "i", action: "Open the import dialog" },
      { keys: "p", action: "Open settings" },
      { keys: "t", action: "Toggle always on top" },
      { keys: "m", action: "Toggle the mini player, in the bottom right corner" },
      { keys: "m + 1..4", action: "Toggle the mini player there, or move it there" },
      { keys: "Ctrl+Shift+1..9", action: "Run the action assigned to that slot" },
    ],
  },
  {
    title: "Contextual",
    binds: [
      { keys: "Escape", action: "Close the theme, settings or import dialog, close a menu, clear search, clear a song selection, cancel a playlist create or rename" },
      { keys: "Enter", action: "Commit a playlist create or rename" },
      { keys: "Shift + click close", action: "Close and forget the saved window geometry" },
    ],
  },
  {
    title: "Pointer",
    note: "Selecting songs works in every collection. Moving them only means something in a playlist you made.",
    binds: [
      { keys: "Click a song", action: "Select it; click it again to play it" },
      { keys: "Ctrl + click a song", action: "Add it to the selection, or take it out" },
      { keys: "Shift + click a song", action: "Select the run of songs between it and the last one picked" },
      { keys: "Right-click a song", action: "Like, add to a playlist, remove from the playlist or delete, for the whole selection" },
      { keys: "Wheel over the queue", action: "Previous or next track" },
      { keys: "Drag the dock", action: "Scrub the current track" },
      { keys: "Drag the queue", action: "Browse the queue" },
      { keys: "Drag a track row", action: "Reorder a playlist, carrying the selection when one is picked" },
    ],
  },
];

export interface SlotAction {
  id: string;
  label: string;
}

/** Offered for each of the nine `Ctrl+Shift+1..9` slots. */
export const SLOT_ACTIONS: SlotAction[] = [
  { id: "snap-window", label: "Snap to saved window size and position" },
  { id: "snap-window-size", label: "Snap to saved window size" },
  { id: "snap-window-position", label: "Snap to saved window position" },
  { id: "toggle-maximise", label: "Toggle maximise" },
  { id: "minimise", label: "Minimise" },
  { id: "toggle-always-on-top", label: "Toggle always on top" },
  { id: "toggle-mini-player", label: "Toggle mini-player" },
  { id: "play-pause", label: "Play or pause" },
  { id: "next", label: "Next track" },
  { id: "previous", label: "Previous track" },
  { id: "toggle-shuffle", label: "Toggle shuffle" },
  { id: "toggle-repeat", label: "Toggle repeat" },
  { id: "mute", label: "Mute" },
  { id: "toggle-queue", label: "Toggle queue" },
  { id: "focus-search", label: "Focus search" },
  { id: "cycle-accent", label: "Cycle accent" },
];

/** How many `Ctrl+Shift+<digit>` slots the app offers. */
export const SLOT_COUNT = 9;

/** `Ctrl+Shift+1` and friends, as they are shown in the panel. */
export function slotLabel(slot: number): string {
  return `Ctrl+Shift+${slot}`;
}
