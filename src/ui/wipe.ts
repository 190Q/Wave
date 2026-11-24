import { isWebKitGtk } from "../lib/device";
import { reduceMotionActive, subscribeMotion } from "../lib/motion";

const WIPE_MS = 600;

const WIPE_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

interface Sweep {
  ready: Promise<void>;
  finished: Promise<void>;
  skipTransition?: () => void;
}

interface SweepingDocument {
  startViewTransition?: (update: () => void) => Sweep;
}

const themeTransitions = new Set<Sweep>();
let motionEpoch = 0;

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
  const epoch = motionEpoch;
  themeTransitions.add(transition);

  const sweep = transition.ready
    .then(() => {
      if (epoch !== motionEpoch || reduceMotionActive()) {
        return;
      }
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

  return Promise.all([sweep, transition.finished.catch(() => undefined)]).then(() => {
    themeTransitions.delete(transition);
  });
}

export interface CoverSwap {
  body: HTMLElement;
  style: string;
}

const CARD_LEAN = 0.25;
const coverWipes = new Map<HTMLElement, { animation: Animation; overlay: HTMLElement; style: string }>();

function cardShape(lead: number): string {
  const edge = lead * 100;
  const trail = (lead - CARD_LEAN) * 100;
  return `polygon(-200% -20%, ${edge}% -20%, ${trail}% 120%, -200% 120%)`;
}

/** Paints the covers straight away, for when the sweep cannot run. */
function settle(swaps: CoverSwap[]): void {
  for (const swap of swaps) {
    setCoverStyle(swap.body, swap.style);
  }
}

export function setCoverStyle(body: HTMLElement, style: string): void {
  cancelCoverWipe(body);
  body.setAttribute("style", style);
}

export function finishCoverWipe(body: HTMLElement): void {
  const active = coverWipes.get(body);
  if (active) setCoverStyle(body, active.style);
}

function cancelCoverWipe(body: HTMLElement): void {
  const active = coverWipes.get(body);
  if (!active) {
    return;
  }
  coverWipes.delete(body);
  active.animation.cancel();
  active.overlay.remove();
}

subscribeMotion(() => {
  if (!reduceMotionActive()) {
    return;
  }
  motionEpoch += 1;
  for (const transition of themeTransitions) {
    transition.skipTransition?.();
  }
  for (const [body, active] of coverWipes) {
    cancelCoverWipe(body);
    body.setAttribute("style", active.style);
  }
});

export function coverWipe(swaps: CoverSwap[]): void {
  if (swaps.length === 0) {
    return;
  }

  if (reduceMotionActive() || document.documentElement.classList.contains("is-starting")) {
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
    cancelCoverWipe(swap.body);
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
    const active = { animation, overlay, style: swap.style };
    coverWipes.set(swap.body, active);

    void animation.finished
      .then(() => {
        if (coverWipes.get(swap.body) !== active) {
          return;
        }
        coverWipes.delete(swap.body);
        swap.body.setAttribute("style", swap.style);
        overlay.remove();
      })
      .catch(() => {
        if (coverWipes.get(swap.body) === active) {
          coverWipes.delete(swap.body);
          swap.body.setAttribute("style", swap.style);
          overlay.remove();
        }
      });
  });
}
