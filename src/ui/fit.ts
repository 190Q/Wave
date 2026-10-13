/** The room a dialog keeps off the top and bottom of the window, in rem. */
const EDGE_REM = 1;

/**
 * The window height a panel needs before it is worth opening as a modal at all,
 * in rem: the height the panels cap themselves at (34rem, in their
 * stylesheets), plus the edge they keep off the window.
 *
 * It is the one threshold the three panels share, so they turn over into their
 * compact drops together rather than each at its own size.
 */
const MIN_PANEL_REM = 36;

/**
 * True when a dialog can open as a modal rather than giving way to its compact
 * drop.
 *
 * A dialog that scrolls its body holds more than any window can show, and stays
 * usable at any height, so `body` is all it has to say. One that clips has to
 * fit its whole content, however tall the window is.
 */
export function dialogFits(dialog: HTMLDialogElement, body?: HTMLElement | null): boolean {
  const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  if (window.innerHeight < MIN_PANEL_REM * rootPx) {
    return false;
  }
  if (body) {
    return true;
  }
  return contentHeight(dialog) <= window.innerHeight - 2 * EDGE_REM * rootPx;
}

/**
 * The height the dialog would need if nothing were capped.
 *
 * An open dialog is read as it stands, so measuring never disturbs the scroll
 * position inside it. A closed one has no layout at all, so it is measured off
 * screen, which costs nothing because there is no scroll to lose.
 */
function contentHeight(dialog: HTMLDialogElement): number {
  if (dialog.open) {
    return dialog.scrollHeight;
  }

  dialog.classList.add("is-measuring");
  const height = dialog.scrollHeight;
  dialog.classList.remove("is-measuring");
  return height;
}
