import { getState, subscribe } from "./state";
import { subscribeActivity, uiActive } from "./activity";
import { isAndroidPlatform } from "./device";

const query = window.matchMedia("(prefers-reduced-motion: reduce)");

const listeners = new Set<() => void>();
let suspended = false;

/**
 * Whether animations should be suppressed. The setting wins when it is set to
 * `on` or `off`; `system` follows the OS preference.
 */
export function reduceMotionActive(): boolean {
  return suspended || configuredReducedMotion();
}

function configuredReducedMotion(): boolean {
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
export function subscribeMotion(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function mountMotion(): void {
  let active = false;
  let resumeFrame: number | null = null;

  const paint = (force = false): void => {
    const next = reduceMotionActive();
    document.documentElement.classList.toggle("is-reduced-motion", configuredReducedMotion());
    if (next === active && !force) {
      return;
    }
    active = next;
    for (const listener of listeners) {
      listener();
    }
  };

  const suspend = (): void => {
    if (resumeFrame !== null) {
      window.cancelAnimationFrame(resumeFrame);
      resumeFrame = null;
    }
    if (suspended) {
      return;
    }
    suspended = true;
    document.documentElement.classList.add("is-resuming");
    paint(true);
    for (const animation of document.getAnimations?.() ?? []) {
      try {
        animation.finish();
      } catch {
        animation.cancel();
      }
    }
  };

  const finishResume = (): void => {
    void document.documentElement.offsetWidth;
    suspended = false;
    document.documentElement.classList.remove("is-resuming");
    paint();
  };

  const resume = (): void => {
    if (!suspended || resumeFrame !== null || !uiActive() || (isAndroidPlatform && !document.hasFocus())) {
      return;
    }
    resumeFrame = requestAnimationFrame(() => {
      resumeFrame = requestAnimationFrame(() => {
        resumeFrame = null;
        if (!uiActive() || (isAndroidPlatform && !document.hasFocus())) {
          return;
        }
        finishResume();
      });
    });
  };

  const resumeOnInput = (): void => {
    if (!suspended || !uiActive()) {
      return;
    }
    if (resumeFrame !== null) {
      window.cancelAnimationFrame(resumeFrame);
      resumeFrame = null;
    }
    finishResume();
  };

  subscribe(() => paint());
  subscribeActivity(() => {
    if (uiActive()) resume();
    else suspend();
  });
  query.addEventListener("change", () => paint());
  document.addEventListener("visibilitychange", () => {
    if (uiActive()) resume();
    else suspend();
  });
  if (isAndroidPlatform) {
    window.addEventListener("blur", suspend);
    window.addEventListener("focus", resume);
    window.addEventListener("pointerdown", resumeOnInput, true);
    window.addEventListener("keydown", resumeOnInput, true);
  }
  if (!uiActive() || (isAndroidPlatform && !document.hasFocus())) {
    suspend();
  }
  paint();
}
