import { reduceMotionActive } from "../lib/motion";
import { getState, subscribe } from "../lib/state";

/** How far the finger moves before a press counts as a drag. */
const DRAG_SLOP_PX = 12;

/** How much more upright than sideways the drag has to be. */
const VERTICAL_RATIO = 1.5;

/** How much of the way up the sheet has to be before it stays there. */
const OPEN_SHARE = 0.25;

/** How long a drag may last and still count as a flick rather than a drag. */
const FLICK_MS = 300;

/** How far a flick has to travel before it settles the way it was going. */
const FLICK_DISTANCE_PX = 40;

/** Matches the settle transition in the stylesheet. */
const SETTLE_MS = 340;

export interface LyricsSheet {
  /** Takes a press on the dock, which may or may not turn into the sheet. */
  press(event: PointerEvent): void;
  /** True once the drag belongs to the sheet rather than to the seek bar. */
  owned(): boolean;
  move(event: PointerEvent): void;
  release(): void;
}

/**
 * The lyrics sheet: the dock is dragged upwards to pull it into the frame, and
 * the handle at the top of the sheet is dragged back down to put it away. The
 * dock and the queue are pushed up in front of it, and the sheet fills the frame
 * from under the top bar down.
 */
export function mountLyricsSheet(): LyricsSheet | null {
  const stage = document.querySelector<HTMLElement>(".stage");
  const topbar = document.querySelector<HTMLElement>(".topbar");
  const panel = document.getElementById("lyrics-panel");
  const grab = document.getElementById("lyrics-grab");
  const root = document.documentElement;

  if (!stage || !topbar || !panel || !grab) {
    return null;
  }

  /** How far the stack has been pushed up, in pixels. */
  let travel = 0;
  let open = false;
  /** True while the dock's drag is the sheet's rather than the seek bar's. */
  let owns = false;
  let dragging = false;
  let settleTimer: number | null = null;
  let originX = 0;
  let originY = 0;
  let originTravel = 0;
  /** When the drag in hand began, which is what makes a flick a flick. */
  let startedAt = 0;

  /** The room the sheet has, which is what it takes to push the stack clear. */
  const room = (): number => panel.clientHeight;

  /** The sheet only exists while the current song has lyrics to show. */
  const wanted = (): boolean => getState().lyrics.length > 0;

  const paint = (): void => {
    stage.style.setProperty("--sheet-travel", `${Math.round(travel)}px`);
  };

  const dragTo = (next: number): void => {
    const limit = room();
    travel = Math.min(Math.max(next, 0), limit);
    paint();
  };

  /** Lets the sheet travel over the settle transition rather than the finger. */
  const settleTo = (next: boolean): void => {
    open = next;
    travel = next ? room() : 0;

    if (reduceMotionActive()) {
      paint();
      return;
    }

    stage.classList.add("is-sheet-settling");
    paint();
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer);
    }
    settleTimer = window.setTimeout(() => {
      settleTimer = null;
      stage.classList.remove("is-sheet-settling");
    }, SETTLE_MS);
  };

  /** A drag that lifts the stack also lifts the sheet, so the two stay joined. */
  const travelTo = (clientY: number): void => dragTo(originTravel + (originY - clientY));

  /**
   * Where the sheet settles when the finger comes off: a flick goes the way it
   * was flicked, and anything slower has to have carried the sheet most of the
   * way before it stays there.
   */
  const settle = (): void => {
    const travelled = travel - originTravel;
    const far = Math.abs(travelled) >= room() * OPEN_SHARE;
    const quick = performance.now() - startedAt < FLICK_MS;
    const flicked = quick && Math.abs(travelled) >= FLICK_DISTANCE_PX;
    settleTo(far || flicked ? travelled > 0 : open);
  };

  const press = (event: PointerEvent): void => {
    if (open || !wanted()) {
      return;
    }
    owns = false;
    originX = event.clientX;
    originY = event.clientY;
    originTravel = travel;
    startedAt = performance.now();
  };

  const move = (event: PointerEvent): void => {
    if (owns) {
      travelTo(event.clientY);
      return;
    }
    if (open || !wanted()) {
      return;
    }

    const up = originY - event.clientY;
    const across = Math.abs(event.clientX - originX);
    if (up < DRAG_SLOP_PX || up < across * VERTICAL_RATIO) {
      return;
    }

    owns = true;
    travelTo(event.clientY);
  };

  const release = (): void => {
    if (!owns) {
      return;
    }
    owns = false;
    settle();
  };

  // The handle is the sheet's own, and the only thing left to drag once it is
  // up: the lyrics below it are the scrub, so they cannot move the sheet too.
  grab.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !open || !wanted()) {
      return;
    }
    dragging = true;
    originY = event.clientY;
    originTravel = travel;
    startedAt = performance.now();
    grab.setPointerCapture(event.pointerId);
  });

  grab.addEventListener("pointermove", (event) => {
    if (dragging) {
      travelTo(event.clientY);
    }
  });

  const endGrabDrag = (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    dragging = false;
    if (grab.hasPointerCapture(event.pointerId)) {
      grab.releasePointerCapture(event.pointerId);
    }
    settle();
  };

  grab.addEventListener("pointerup", endGrabDrag);
  grab.addEventListener("pointercancel", endGrabDrag);

  /** The sheet follows the top bar, which moves with the notch and the rotation. */
  const refit = (): void => {
    root.style.setProperty("--phone-topbar", `${topbar.offsetHeight}px`);
    if (dragging || owns) {
      return;
    }
    travel = open ? room() : 0;
    paint();
  };

  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(refit);
    observer.observe(stage);
    observer.observe(topbar);
  }

  subscribe(() => {
    if (open && !wanted()) {
      settleTo(false);
    }
  });

  refit();

  return { press, owned: () => owns, move, release };
}
