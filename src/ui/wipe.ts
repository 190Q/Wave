import { reduceMotionActive } from "../lib/motion";
import { isWebKitGtk } from "../lib/platform";

const WIPE_MS = 600;

const WIPE_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

interface Sweep {
  ready: Promise<void>;
  finished: Promise<void>;
}

interface SweepingDocument {
  startViewTransition?: (update: () => void) => Sweep;
}

function wipeShape(progress: number): string {
  const p = -0.05 + progress * 1.1;
  const leading = `calc(${p} * (100vw + 24vh))`;
  const trailing = `calc(${p} * (100vw + 24vh) - 24vh)`;
  return `polygon(-100vh -10vh, ${leading} -10vh, ${trailing} 110vh, -100vh 110vh)`;
}
function canSweep(start: unknown): start is (update: () => void) => Sweep {
  if (isWebKitGtk) {
    return false;
  }
  return typeof start === "function" && !reduceMotionActive();
}

export function themeWipe(update: () => void): Promise<void> {
  const api = document as unknown as SweepingDocument;
  const start = api.startViewTransition;

  if (!canSweep(start)) {
    update();
    return Promise.resolve();
  }

  const transition = start.call(api, update);

  const sweep = transition.ready
    .then(() => {
      const options = {
        duration: WIPE_MS,
        easing: WIPE_EASE,
        fill: "forwards",
        pseudoElement: "::view-transition-new(root)",
      } as KeyframeAnimationOptions;

      return document.documentElement.animate(
        { clipPath: [wipeShape(0), wipeShape(1)] },
        options,
      ).finished;
    })
    .catch(() => undefined);

  return Promise.all([sweep, transition.finished.catch(() => undefined)]).then(
    () => undefined,
  );
}

export interface CoverSwap {
  body: HTMLElement;
  style: string;
}

const CARD_LEAN = 0.25;

function cardShape(lead: number): string {
  const edge = lead * 100;
  const trail = (lead - CARD_LEAN) * 100;
  return `polygon(-200% -20%, ${edge}% -20%, ${trail}% 120%, -200% 120%)`;
}

/** Paints the covers straight away, for when the sweep cannot run. */
function settle(swaps: CoverSwap[]): void {
  for (const swap of swaps) {
    swap.body.setAttribute("style", swap.style);
  }
}

export function coverWipe(swaps: CoverSwap[]): void {
  if (swaps.length === 0) {
    return;
  }

  if (reduceMotionActive()) {
    settle(swaps);
    return;
  }

  const boxes = swaps.map((swap) => swap.body.getBoundingClientRect());
  // Untransformed, because the clip is drawn in the card's own coordinates.
  const widths = swaps.map((swap) => swap.body.offsetWidth);
  const left = Math.min(...boxes.map((box) => box.left));
  const span = Math.max(...boxes.map((box) => box.right)) - left;
  const cover = (1 + CARD_LEAN) * Math.max(...widths);
  const speed = (span + cover) / WIPE_MS;

  if (!(speed > 0)) {
    settle(swaps);
    return;
  }

  swaps.forEach((swap, index) => {
    const overlay = document.createElement("div");
    overlay.className = "card-wipe";
    overlay.setAttribute("style", swap.style);
    // Clipped shut before it lands, so a card waiting its turn shows its colour.
    overlay.style.clipPath = cardShape(0);
    swap.body.prepend(overlay);

    const animation = overlay.animate(
      { clipPath: [cardShape(0), cardShape(1 + CARD_LEAN)] },
      {
        // Cards further along the row join the same edge a beat later.
        delay: (boxes[index].left - left) / speed,
        duration: ((1 + CARD_LEAN) * widths[index]) / speed,
        easing: "linear",
        fill: "forwards",
      },
    );

    void animation.finished
      .then(() => {
        swap.body.setAttribute("style", swap.style);
        overlay.remove();
      })
      .catch(() => undefined);
  });
}
