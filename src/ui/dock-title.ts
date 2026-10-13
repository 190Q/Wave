import { reduceMotionActive, subscribeMotion } from "../lib/motion";
import { currentTrack, player, subscribe } from "../lib/state";

const WIDTH_SHARE = 1.5;
const HOLD_MS = 1600;
const SPEED_PX_PER_S = 60;
const MIN_RUN_MS = 1200;
const OVERFLOW_SLACK_PX = 1;
const SETTLE_MS = 250;

export function mountDockTitle(): void {
  const viewport = document.getElementById("dock-title");
  const strip = document.getElementById("dock-title-text");
  const buttons = document.getElementById("dock-buttons");
  const hero = document.getElementById("hero");

  if (!viewport || !strip || !buttons || !hero) {
    return;
  }

  let timer: number | null = null;
  let settleTimer: number | null = null;
  let runningSpan: number | null = null;
  let shown = false;
  let renderedText: string | null = null;

  const clearTimer = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  const setFades = (left: boolean, right: boolean): void => {
    viewport.classList.toggle("is-fade-left", left);
    viewport.classList.toggle("is-fade-right", right);
  };

  const overflow = (): number => Math.max(0, strip.scrollWidth - viewport.clientWidth);

  const wanted = (): boolean =>
    document.documentElement.classList.contains("is-title-folded") &&
    (currentTrack()?.title ?? "").length > 0;

  const moveTo = (offset: number, durationMs: number): void => {
    strip.style.transition = `transform ${durationMs}ms linear`;
    strip.style.transform = `translateX(${-offset}px)`;
  };

  /** Stops the run and parks the title back at its head. */
  const stop = (): void => {
    clearTimer();
    runningSpan = null;
    strip.style.transition = "none";
    strip.style.transform = "";
    setFades(false, false);
  };

  const cycle = (): void => {
    const span = overflow();
    runningSpan = span;

    if (span <= OVERFLOW_SLACK_PX) {
      stop();
      return;
    }

    const durationMs = Math.max(MIN_RUN_MS, (span / SPEED_PX_PER_S) * 1000);

    // At the head the title is cut on the right, so only that edge fades.
    setFades(false, true);

    timer = window.setTimeout(() => {
      // Under way, both edges are cuts.
      setFades(true, true);
      moveTo(span, durationMs);

      timer = window.setTimeout(() => {
        setFades(true, false);

        timer = window.setTimeout(() => {
          setFades(true, true);
          moveTo(0, durationMs);

          timer = window.setTimeout(cycle, durationMs);
        }, HOLD_MS);
      }, durationMs);
    }, HOLD_MS);
  };

  const update = (): void => {
    const span = overflow();

    if (reduceMotionActive() || span <= OVERFLOW_SLACK_PX) {
      if (runningSpan !== null) {
        stop();
      }
      // A title that cannot move still shows where it was cut off.
      setFades(false, span > OVERFLOW_SLACK_PX);
      return;
    }

    if (runningSpan === span) {
      return;
    }

    stop();
    // Flush the reset so the first run animates out of the head.
    void strip.offsetWidth;
    runningSpan = span;
    cycle();
  };

  const cancelSettle = (): void => {
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer);
      settleTimer = null;
    }
  };

  const conceal = (): void => {
    cancelSettle();
    if (!shown) {
      return;
    }
    shown = false;
    viewport.classList.remove("is-shown");
    stop();
  };

  const reveal = (): void => {
    settleTimer = null;
    if (!wanted()) {
      return;
    }
    shown = true;
    viewport.classList.add("is-shown");
    update();
  };

  /** The cap is a share of the controls' width, so the two stay in step. */
  const capWidth = (): void => {
    const width = buttons.getBoundingClientRect().width * WIDTH_SHARE;
    if (width > 0) {
      viewport.style.setProperty("--dock-title-max", `${width}px`);
    }
  };

  const fit = (): void => {
    capWidth();

    const text = currentTrack()?.title ?? "";
    if (text !== renderedText) {
      renderedText = text;
      strip.textContent = text;
    }

    if (!wanted()) {
      conceal();
      return;
    }

    if (!shown) {
      if (settleTimer === null) {
        settleTimer = window.setTimeout(reveal, SETTLE_MS);
      }
      return;
    }

    update();
  };

  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(fit);
    // The hero's size decides the fold; the controls' size decides the cap.
    observer.observe(hero);
    observer.observe(buttons);
    observer.observe(viewport);
    observer.observe(strip);
  }
  subscribe(fit);
  subscribeMotion(fit);
  player.onChange(fit);
  void document.fonts?.ready.then(fit);
  fit();
}
