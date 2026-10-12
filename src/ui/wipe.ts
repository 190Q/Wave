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
  return (
    typeof start === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
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
