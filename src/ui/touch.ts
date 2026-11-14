import { isTouch } from "../lib/device";

/** How long a finger rests on a row before the app's menu is asked for. */
const LONG_PRESS_MS = 550;

/** How far the finger may wander before the press stops being a press. */
const LONG_PRESS_SLOP_PX = 10;

let waiting: { row: HTMLElement; x: number; y: number } | null = null;
let timer: number | null = null;
let lifted: HTMLElement | null = null;
/** Set when the platform raised its own menu for this press. */
let nativeMenu = false;
/** Set while the tap that ends a long press is still to come. */
let swallowClick = false;

/**
 * What a finger needs from the layout, and from the rows it presses. The flag
 * is on `<html>` for the stylesheets, which keep every hover-only control on
 * show and every hit target finger sized while it is there.
 */
export function mountTouch(): void {
  if (!isTouch()) {
    return;
  }

  document.documentElement.dataset.touch = "true";
  mountLongPress();
}

/**
 * A touch screen has no right-click, so a finger resting on a library row asks
 * for the same menu one would have opened. The row is made undraggable for the
 * length of the press, because the WebView starts a native drag on a long press
 * of a draggable row and never lets the menu through.
 */
function mountLongPress(): void {
  const rowAt = (node: EventTarget | null): HTMLElement | null => {
    const row = node instanceof Element ? node.closest<HTMLElement>("[data-track]") : null;
    return row && row.closest(".sheet") ? row : null;
  };

  /** Stops waiting, and gives the row its drag back, whichever way it ended. */
  const stopWaiting = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    waiting = null;
    if (lifted) {
      lifted.setAttribute("draggable", "true");
      lifted = null;
    }
  };

  const openMenu = (): void => {
    timer = null;
    const pressed = waiting;
    if (!pressed) {
      return;
    }
    // The tap that ends a long press belongs to the menu, not to the row.
    swallowClick = true;
    if (nativeMenu) {
      return;
    }
    pressed.row.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: pressed.x,
        clientY: pressed.y,
      }),
    );
  };

  document.addEventListener(
    "pointerdown",
    (event) => {
      stopWaiting();
      swallowClick = false;

      if (event.pointerType !== "touch" || event.button !== 0) {
        return;
      }

      const row = rowAt(event.target);
      if (!row) {
        return;
      }

      const movable = row.closest<HTMLElement>("[draggable='true']");
      if (movable) {
        movable.removeAttribute("draggable");
        lifted = movable;
      }

      waiting = { row, x: event.clientX, y: event.clientY };
      nativeMenu = false;
      timer = window.setTimeout(openMenu, LONG_PRESS_MS);
    },
    true,
  );

  document.addEventListener(
    "pointermove",
    (event) => {
      if (!waiting) {
        return;
      }
      const moved = Math.hypot(event.clientX - waiting.x, event.clientY - waiting.y);
      if (moved > LONG_PRESS_SLOP_PX) {
        stopWaiting();
      }
    },
    true,
  );

  document.addEventListener("contextmenu", () => (nativeMenu = true), true);

  document.addEventListener("pointerup", stopWaiting, true);
  document.addEventListener("pointercancel", stopWaiting, true);

  document.addEventListener(
    "click",
    (event) => {
      if (!swallowClick) {
        return;
      }
      swallowClick = false;
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );
}
