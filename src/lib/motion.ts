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
