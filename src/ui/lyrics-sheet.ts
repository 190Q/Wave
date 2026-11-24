import { createVelocitySampler, springStep } from "../lib/drag-motion";
import { reduceMotionActive, subscribeMotion } from "../lib/motion";
import { currentTrack, getState, player, subscribe } from "../lib/state";
import type { SheetVisibility } from "./sheet-visibility";

/** How far the finger moves before a press counts as a drag. */
const DRAG_SLOP_PX = 12;

/** How much more upright than sideways the drag has to be. */
const VERTICAL_RATIO = 1.5;

/** How much of the way up the sheet has to be before it stays there. */
const OPEN_SHARE = 0.25;

const VELOCITY_WINDOW_MS = 100;
const RELEASE_PROJECTION_SEC = 0.24;
const FLICK_DISTANCE_PX = 40;
const SETTLE_RATE = 14;
const SETTLE_DISTANCE_PX = 0.5;
const SETTLE_SPEED_PX = 5;
const REVERSE_BRAKE_SEC = 0.08;
const EDGE_BRAKE_SHARE = 0.8;

export interface LyricsSheet {
  /** Takes a press on the dock, which may or may not turn into the sheet. */
  press(event: PointerEvent): void;
  /** True once the drag belongs to the sheet rather than to the seek bar. */
  owned(): boolean;
  move(event: PointerEvent): void;
  release(event: PointerEvent): void;
}

/**
 * The lyrics sheet: the dock is dragged upwards to pull it into the frame, and
 * the handle at the top of the sheet is dragged back down to put it away. The
 * dock and the queue are pushed up in front of it, and the sheet fills the frame
 * from under the top bar down.
 */
export function mountLyricsSheet(visibility?: SheetVisibility): LyricsSheet | null {
  const stage = document.querySelector<HTMLElement>(".stage");
  const topbar = document.querySelector<HTMLElement>(".topbar");
  const panel = document.getElementById("lyrics-panel");
  const grab = document.getElementById("lyrics-grab");
  const dockGrab = document.getElementById("dock-grab");
  const dock = document.getElementById("dock");
  const carousel = document.getElementById("carousel");
  const root = document.documentElement;

  if (!stage || !topbar || !panel || !grab || !dockGrab || !dock || !carousel) {
    return null;
  }

  /** How far the stack has been pushed up, in pixels. */
  let travel = 0;
  let paintedTravel = 0;
  let height = 0;
  let open = false;
  let wantedOpen = false;
  /** True while the dock's drag is the sheet's rather than the seek bar's. */
  let owns = false;
  let dragging = false;
  let grabMoved = false;
  let suppressOpenClick = false;
  let suppressCloseClick = false;
  let dragFrame: number | null = null;
  let settleFrame: number | null = null;
  let settleAt = 0;
  let settleVelocity = 0;
  let settleRate = SETTLE_RATE;
  let brakeAcceleration = 0;
  let interrupted = false;
  let originX = 0;
  let originY = 0;
  let originTravel = 0;
  const dragVelocity = createVelocitySampler(VELOCITY_WINDOW_MS);
  /** The room the sheet has, which is what it takes to push the stack clear. */
  const room = (): number => height;
  const measureRoom = (): void => { height = panel.clientHeight; };

  /** The sheet only exists while the current song has lyrics to show. */
  const wanted = (): boolean => getState().lyrics.length > 0;

  const paint = (): void => {
    visibility?.update(travel, height);
    panel.style.transform = `translateY(calc(100% - ${travel}px))`;
    const shift = `translateY(${-travel}px)`;
    dock.style.transform = shift;
    carousel.style.transform = shift;
    const progress = height > 0 ? Math.min(Math.max(travel / height, 0), 1) : 0;
    dockGrab.style.opacity = String(1 - Math.min(progress / 0.2, 1));
    paintedTravel = travel;
  };

  const paintOpen = (): void => {
    panel.inert = !open;
    dockGrab.setAttribute("aria-expanded", String(open));
  };

  const dragTo = (next: number): void => {
    const limit = room();
    const clamped = Math.min(Math.max(next, 0), limit);
    if (clamped === travel) {
      return;
    }
    travel = clamped;
    if (dragFrame === null) {
      dragFrame = requestAnimationFrame(() => {
        dragFrame = null;
        paint();
      });
    }
  };

  const stopDragPaint = (): void => {
    if (dragFrame !== null) {
      window.cancelAnimationFrame(dragFrame);
      dragFrame = null;
    }
  };

  const stopSettle = (): boolean => {
    if (settleFrame === null) {
      return false;
    }
    window.cancelAnimationFrame(settleFrame);
    settleFrame = null;
    return true;
  };

  const finishSettle = (): void => {
    stopSettle();
    travel = open ? room() : 0;
    settleVelocity = 0;
    brakeAcceleration = 0;
    paint();
  };

  const animateSettle = (now: number): void => {
    settleFrame = null;
    if (reduceMotionActive()) {
      finishSettle();
      return;
    }

    let elapsed = Math.max(0, (now - settleAt) / 1000);
    settleAt = now;
    const limit = room();
    const target = open ? limit : 0;

    if (brakeAcceleration !== 0) {
      const brakeTime = Math.abs(settleVelocity / brakeAcceleration);
      const step = Math.min(elapsed, brakeTime);
      travel += settleVelocity * step + brakeAcceleration * step * step / 2;
      settleVelocity += brakeAcceleration * step;
      elapsed -= step;
      if (step >= brakeTime) {
        settleVelocity = 0;
        brakeAcceleration = 0;
      }
    }

    if (brakeAcceleration === 0) {
      const next = springStep(travel, target, settleVelocity, elapsed, settleRate);
      travel = next.position;
      settleVelocity = next.velocity;
    }

    if ((open && travel >= target) || (!open && travel <= target)) {
      finishSettle();
      return;
    }
    if (travel < 0 || travel > limit) {
      travel = Math.min(Math.max(travel, 0), limit);
      settleVelocity = 0;
      brakeAcceleration = 0;
    }
    if (Math.abs(target - travel) < SETTLE_DISTANCE_PX && Math.abs(settleVelocity) < SETTLE_SPEED_PX) {
      finishSettle();
      return;
    }
    paint();
    settleFrame = requestAnimationFrame(animateSettle);
  };

  const settleTo = (next: boolean, velocity = 0, remember = true): void => {
    stopDragPaint();
    stopSettle();
    measureRoom();
    open = next;
    if (remember) {
      wantedOpen = next;
    }
    paintOpen();
    if (reduceMotionActive() || travel === (next ? room() : 0)) {
      finishSettle();
      return;
    }
    settleVelocity = velocity;
    settleRate = SETTLE_RATE;
    brakeAcceleration = 0;
    const target = next ? room() : 0;
    if ((target - travel) * velocity > 0) {
      // Keep the spring from crossing the target at swipe speed.
      settleRate = Math.max(settleRate, Math.abs(velocity) / Math.max(Math.abs(target - travel), SETTLE_DISTANCE_PX));
    } else if ((target - travel) * velocity < 0) {
      // Slow a swipe away from the target before reversing, within the sheet's bounds.
      const available = velocity > 0 ? room() - travel : travel;
      const duration = Math.min(REVERSE_BRAKE_SEC, 2 * Math.max(available, 0) * EDGE_BRAKE_SHARE / Math.abs(velocity));
      if (duration > 0) {
        brakeAcceleration = -velocity / duration;
      } else {
        settleVelocity = 0;
      }
    }
    settleAt = performance.now();
    paint();
    settleFrame = requestAnimationFrame(animateSettle);
  };

  /** A drag that lifts the stack also lifts the sheet, so the two stay joined. */
  const travelTo = (clientY: number): void => dragTo(originTravel + (originY - clientY));

  const settle = (velocity: number): void => {
    const distance = travel - originTravel;
    const projected = distance + (Math.abs(distance) >= FLICK_DISTANCE_PX ? velocity * RELEASE_PROJECTION_SEC : 0);
    const threshold = room() * OPEN_SHARE;
    const next = projected > threshold ? true : projected < -threshold ? false : open;
    settleTo(next, velocity);
  };

  const press = (event: PointerEvent): void => {
    suppressOpenClick = false;
    if (open || !wanted()) {
      return;
    }
    measureRoom();
    interrupted = stopSettle();
    owns = false;
    originX = event.clientX;
    originY = event.clientY;
    originTravel = travel;
    dragVelocity.reset(travel);
  };

  const move = (event: PointerEvent): void => {
    if (owns) {
      travelTo(event.clientY);
      dragVelocity.sample(travel);
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
    dragVelocity.sample(travel);
  };

  const release = (event: PointerEvent): void => {
    if (!owns) {
      if (interrupted) {
        interrupted = false;
        settleTo(open);
      }
      return;
    }
    owns = false;
    interrupted = false;
    if (event.type !== "pointercancel") {
      travelTo(event.clientY);
      dragVelocity.sample(travel);
    }
    suppressOpenClick = true;
    settle(event.type === "pointercancel" ? 0 : dragVelocity.velocity());
  };

  dockGrab.addEventListener("click", (event) => {
    if (event.detail !== 0 && suppressOpenClick) {
      suppressOpenClick = false;
      return;
    }
    if (!open && wanted()) {
      settleTo(true);
      if (event.detail === 0) {
        grab.focus({ preventScroll: true });
      }
    }
  });

  // The handle is the sheet's own, and the only thing left to drag once it is
  // up: the lyrics below it are the scrub, so they cannot move the sheet too.
  grab.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !open) {
      return;
    }
    measureRoom();
    stopSettle();
    dragging = true;
    grabMoved = false;
    suppressCloseClick = false;
    originY = event.clientY;
    originTravel = travel;
    dragVelocity.reset(travel);
    grab.setPointerCapture(event.pointerId);
  });

  grab.addEventListener("pointermove", (event) => {
    if (dragging) {
      grabMoved ||= Math.abs(event.clientY - originY) >= DRAG_SLOP_PX;
      if (grabMoved) {
        travelTo(event.clientY);
        dragVelocity.sample(travel);
      }
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
    if (grabMoved) {
      if (event.type !== "pointercancel") {
        travelTo(event.clientY);
        dragVelocity.sample(travel);
      }
      suppressCloseClick = event.type !== "pointercancel";
      settle(event.type === "pointercancel" ? 0 : dragVelocity.velocity());
    } else {
      settleTo(open);
    }
  };

  grab.addEventListener("pointerup", endGrabDrag);
  grab.addEventListener("pointercancel", endGrabDrag);
  grab.addEventListener("click", (event) => {
    if (event.detail !== 0 && suppressCloseClick) {
      suppressCloseClick = false;
      return;
    }
    if (open) {
      settleTo(false);
      if (event.detail === 0 && wanted()) {
        dockGrab.focus({ preventScroll: true });
      }
    }
  });

  /** The sheet follows the top bar, which moves with the notch and the rotation. */
  const refit = (): void => {
    root.style.setProperty("--phone-topbar", `${topbar.offsetHeight}px`);
    measureRoom();
    if (dragging || owns || settleFrame !== null) {
      visibility?.update(paintedTravel, height);
      return;
    }
    travel = open ? room() : 0;
    paint();
  };

  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(refit);
    observer.observe(stage);
    observer.observe(topbar);
    observer.observe(panel);
  } else {
    window.addEventListener("resize", refit);
  }

  subscribeMotion(() => {
    if (settleFrame !== null && reduceMotionActive()) {
      finishSettle();
    }
  });

  const followLyrics = (): void => {
    if (!currentTrack()) {
      wantedOpen = false;
      if (!open && !dragging && !owns && travel === 0) {
        return;
      }
      dragging = false;
      owns = false;
      interrupted = false;
      settleTo(false, 0, false);
    } else if (!getState().lyricsLoading) {
      if (!wanted() && (open || dragging || owns)) {
        dragging = false;
        owns = false;
        interrupted = false;
        settleTo(false, 0, false);
      } else if (wanted() && wantedOpen && !open) {
        settleTo(true, 0, false);
      }
    }
  };

  subscribe(followLyrics);
  player.onChange(followLyrics);
  paintOpen();
  refit();

  return { press, owned: () => owns, move, release };
}
