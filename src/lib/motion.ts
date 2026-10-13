import { getState, subscribe } from "./state";

const query = window.matchMedia("(prefers-reduced-motion: reduce)");

const listeners = new Set<() => void>();

/**
 * Whether animations should be suppressed. The setting wins when it is set to
 * `on` or `off`; `system` follows the OS preference.
 */
export function reduceMotionActive(): boolean {
  const { reduceMotion } = getState().settings;
  if (reduceMotion === "on") {
    return true;
  }
  if (reduceMotion === "off") {
    return false;
  }
  return query.matches;
}

const BOUNCE_MS = 420;

export function bounce(element: Element | null): void {
  if (!element || reduceMotionActive()) {
    return;
  }

  element.animate(
    [
      { transform: "scale(1)" },
      { transform: "scale(1.3)", offset: 0.3 },
      { transform: "scale(0.9)", offset: 0.55 },
      { transform: "scale(1.08)", offset: 0.78 },
      { transform: "scale(1)" },
    ],
    { duration: BOUNCE_MS, easing: "ease-out" },
  );
}

/** Runs `listener` when the setting or the OS preference changes the answer. */
export function subscribeMotion(listener: () => void): void {
  listeners.add(listener);
}

export function mountMotion(): void {
  let active = false;

  const paint = (): void => {
    const next = reduceMotionActive();
    document.documentElement.classList.toggle("is-reduced-motion", next);
    if (next === active) {
      return;
    }
    active = next;
    for (const listener of listeners) {
      listener();
    }
  };

  subscribe(paint);
  query.addEventListener("change", paint);
  paint();
}
