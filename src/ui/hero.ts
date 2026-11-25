import { device } from "../lib/device";
import { createVelocitySampler, springStep } from "../lib/drag-motion";
import { activeLyricIndex } from "../lib/lrc";
import { escapeHtml, joinMeta } from "../lib/format";
import { reduceMotionActive, subscribeMotion } from "../lib/motion";
import type { PlayerSnapshot } from "../lib/player";
import {
  currentTrack,
  ensureColour,
  ensureLyrics,
  getState,
  player,
  subscribe,
  toggleLibrary,
} from "../lib/state";
import type { LyricLine } from "../types";
import { plainCoverStyle } from "./artwork";
import type { SheetVisibility } from "./sheet-visibility";

/** Wheel deltas are normalised to pixels before accumulating. */
const WHEEL_STEP_PX = 100;
const WHEEL_LINE_PX = 33;
const CHASE_TAU_MS = 80;
const CHASE_LINES_PER_SEC = 40;
const CHASE_LINE_LIMIT = 0.9;
const CHASE_SETTLE_LINES = 0.005;
const DRAG_VELOCITY_WINDOW_MS = 100;
const RELEASE_PROJECTION_SEC = 0.12;
const RELEASE_RATE = 16;
const RELEASE_SETTLE_PX = 0.1;
const RELEASE_SETTLE_SPEED = 2;
const LYRICS_SLIDE_MS = 450;
const SWIPE_SLOP_PX = 20;
const VERTICAL_SLOP_PX = 8;
const SWIPE_AXIS_RATIO = 2;
const SWIPE_MIN_PX = 25;
const SWIPE_SHARE = 0.25;
const SWIPE_PROJECTION_SEC = 0.2;
const SWIPE_EDGE_RESISTANCE = 0.3;

export function mountHero(visibility?: SheetVisibility): void {
  const hero = document.getElementById("hero");
  const cover = document.getElementById("now-cover");
  const source = document.getElementById("now-source");
  const title = document.getElementById("now-title");
  const artist = document.getElementById("now-artist");
  const meta = document.getElementById("now-meta");
  const panel = document.getElementById("lyrics-panel");
  const lyricPage = document.getElementById("lyrics-page");
  const lyricTrack = document.getElementById("lyrics");

  if (!hero || !cover || !source || !title || !artist || !meta || !panel || !lyricPage || !lyricTrack) {
    return;
  }

  const phone = device() !== "desktop";
  let catchingUp = false;
  let catchUpFrame: number | null = null;

  const COVER_MAX_REM = 24;
  const COVER_MIN_REM = 6;
  const COVER_GAP_REM = 2.5;
  const COVER_WIDTH_SHARE = 0.5;

  const narrowLayout = window.matchMedia("(max-width: 48rem)");

  const carouselReserve = (): number => {
    const space = document.querySelector(".carousel-space");
    return space ? space.getBoundingClientRect().height : 0;
  };

  const fitCover = (): void => {
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const styles = getComputedStyle(hero);
    const padX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const byHeight = hero.clientHeight - COVER_GAP_REM * rootPx;
    const byWidth = (hero.clientWidth - padX) * COVER_WIDTH_SHARE;
    const size = Math.max(0, Math.min(byHeight, byWidth, COVER_MAX_REM * rootPx));
    hero.style.setProperty("--cover-height", `${size}px`);

    const tooShort = byHeight + carouselReserve() < COVER_MIN_REM * rootPx;
    hero.classList.toggle("is-cover-hidden", narrowLayout.matches || size < COVER_MIN_REM * rootPx);

    document.documentElement.classList.toggle("is-short", tooShort);
    if (tooShort && getState().libraryOpen) {
      toggleLibrary(false);
    }
  };

  const outerHeight = (el: HTMLElement): number => {
    const styles = getComputedStyle(el);
    return el.scrollHeight + parseFloat(styles.marginTop) + parseFloat(styles.marginBottom);
  };

  const fold = (el: HTMLElement, hidden: boolean): void => {
    const height = el.scrollHeight;
    el.style.maxHeight = hidden ? "0px" : height > 0 ? `${height}px` : "";
    el.style.opacity = hidden ? "0" : "1";
  };

  const fitText = (): void => {
    const available = hero.clientHeight;
    const full = outerHeight(source) + outerHeight(title) + outerHeight(artist) + outerHeight(meta);
    const withoutMeta = full - outerHeight(meta);
    const withoutSource = withoutMeta - outerHeight(source);

    const level =
      full <= available ? 0 : withoutMeta <= available ? 1 : withoutSource <= available ? 2 : 3;

    fold(meta, level >= 1);
    fold(source, level >= 2);
    fold(title, level >= 3);
    fold(artist, level >= 3);

    document.documentElement.classList.toggle("is-title-folded", level >= 3);
  };

  const layout = (): void => {
    if (!phone) {
      fitCover();
      fitText();
    }
    refitLines();
  };

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(layout).observe(phone ? panel : hero);
  }
  narrowLayout.addEventListener("change", layout);
  void document.fonts?.ready.then(layout);

  let lastTrackId: string | null = null;
  let lastNavigation: { sourceId: string | null; cursor: number; travel: number } | null = null;
  let renderedLyrics: LyricLine[] | null = null;
  let lyricLines: HTMLElement[] = [];
  let activeLine: HTMLElement | null = null;

  let shownLine = 0;
  let targetLine = 0;
  let scrubbing = false;
  let dragging = false;
  let dragPointerId: number | null = null;
  let dragAxis: "pending" | "vertical" | "horizontal" = "pending";
  let dragBeforeFirst = false;
  let dragOriginX = 0;
  let dragOriginY = 0;
  let dragOriginCentre = 0;
  const dragVelocity = createVelocitySampler(DRAG_VELOCITY_WINDOW_MS);
  const swipeVelocity = createVelocitySampler(DRAG_VELOCITY_WINDOW_MS);
  let swipeWidth = 0;
  let swipeBase = 0;
  let swipeOffset = 0;
  let swipePainted = 0;
  let swipeFrame: number | null = null;
  let swipeDeparture: { offset: number; width: number } | null = null;
  let settlingDrag = false;
  let settleVelocity = 0;
  let chaseFrame: number | null = null;
  let chaseAt = 0;
  let seekedLine = -1;
  let wheelTravel = 0;
  let heldAtEnd = false;

  let lineCentres: number[] = [];

  const endLine = (): number => Math.max(lyricLines.length - 1, 0);
  const clampLine = (line: number): number => Math.min(Math.max(line, 0), endLine());

  const centreAt = (line: number): number => {
    if (lineCentres.length === 0) {
      return 0;
    }
    const clamped = Math.min(Math.max(line, 0), lineCentres.length - 1);
    const above = Math.floor(clamped);
    const below = Math.min(above + 1, lineCentres.length - 1);
    return lineCentres[above] + (lineCentres[below] - lineCentres[above]) * (clamped - above);
  };

  /** The line sitting `offset` px down the track: `centreAt` read backwards, for dragging. */
  const lineAt = (offset: number): number => {
    for (let index = 1; index < lineCentres.length; index += 1) {
      if (offset <= lineCentres[index]) {
        const above = lineCentres[index - 1];
        const span = lineCentres[index] - above;
        return index - 1 + (span > 0 ? (offset - above) / span : 0);
      }
    }
    return Math.max(lineCentres.length - 1, 0);
  };

  const markWrapped = (): void => {
    lyricTrack.classList.add("is-fitting", "is-measuring");
    const range = document.createRange();
    for (const line of lyricLines) {
      range.selectNodeContents(line);
      line.classList.toggle("is-wrapped", range.getClientRects().length > 1);
    }
    lyricTrack.classList.remove("is-fitting");
    void lyricTrack.offsetHeight;
    lyricTrack.classList.remove("is-measuring");
  };

  const measureLines = (): void => {
    lineCentres = lyricLines.map((line) => line.offsetTop + line.offsetHeight / 2);
  };

  const paintActive = (index: number): void => {
    const next = lyricLines[index] ?? null;
    if (next === activeLine) {
      return;
    }
    activeLine?.classList.remove("is-active");
    next?.classList.add("is-active");
    activeLine = next;
  };

  const paintLine = (line: number): void => {
    paintActive(Math.round(line));
    applyTransform(line);
  };

  const applyTransform = (line: number): void => {
    lyricTrack.style.transform = `translateY(${-centreAt(clampLine(line))}px)`;
  };

  /** Reads the lines back off the page: a resize re-wraps them and moves their middles. */
  const refitLines = (): void => {
    if (lyricLines.length === 0) {
      return;
    }
    markWrapped();
    measureLines();
    applyTransform(shownLine);
  };

  /** Moves playback onto a line, so the clock and the dock follow the lyrics. */
  const seekToLine = (index: number): void => {
    const lyrics = renderedLyrics ?? [];
    if (lyrics.length === 0 || index < 0 || index === seekedLine) {
      return;
    }
    seekedLine = index;
    player.seek(lyrics[Math.min(Math.max(index, 0), lyrics.length - 1)].timeMs);
  };

  const endScrub = (): void => {
    scrubbing = false;
    panel.classList.remove("is-scrubbing");
  };

  const stopChase = (): void => {
    if (chaseFrame !== null) {
      window.cancelAnimationFrame(chaseFrame);
      chaseFrame = null;
    }
    settlingDrag = false;
    settleVelocity = 0;
    endScrub();
  };

  const chase = (now: number): void => {
    chaseFrame = null;

    const elapsed = Math.max(now - chaseAt, 0);
    chaseAt = now;

    if (settlingDrag) {
      const current = centreAt(shownLine);
      const target = centreAt(targetLine);
      const next = springStep(current, target, settleVelocity, elapsed / 1000, RELEASE_RATE);
      const crossed = (target - current) * (target - next.position) < 0;
      settleVelocity = next.velocity;
      if (
        reduceMotionActive() || crossed ||
        (Math.abs(target - next.position) < RELEASE_SETTLE_PX && Math.abs(settleVelocity) < RELEASE_SETTLE_SPEED)
      ) {
        shownLine = targetLine;
        settleVelocity = 0;
        settlingDrag = false;
      } else {
        shownLine = clampLine(lineAt(next.position));
      }
    } else {
      const gap = targetLine - shownLine;
      const reach = Math.min(elapsed / CHASE_TAU_MS, 1);
      const limit = Math.min(CHASE_LINE_LIMIT, (CHASE_LINES_PER_SEC * elapsed) / 1000);
      shownLine += Math.max(-limit, Math.min(limit, gap * reach));
      if (Math.abs(targetLine - shownLine) < CHASE_SETTLE_LINES) {
        shownLine = targetLine;
      }
    }

    paintLine(shownLine);
    seekToLine(Math.round(shownLine));

    if (settlingDrag || shownLine !== targetLine) {
      chaseFrame = requestAnimationFrame(chase);
    } else if (!dragging) {
      endScrub();
    }
  };

  const startChase = (): void => {
    scrubbing = true;
    panel.classList.add("is-scrubbing");
    if (chaseFrame === null) {
      chaseAt = performance.now();
      chaseFrame = requestAnimationFrame(chase);
    }
  };

  const cancelSwipe = (): void => {
    if (swipeFrame !== null) {
      window.cancelAnimationFrame(swipeFrame);
      swipeFrame = null;
    }
    if (dragAxis !== "horizontal") {
      return;
    }
    lyricPage.style.transform = "";
    if (dragPointerId !== null && panel.hasPointerCapture(dragPointerId)) {
      panel.releasePointerCapture(dragPointerId);
    }
    dragPointerId = null;
    dragging = false;
    dragAxis = "pending";
  };

  /** Forgets where the scrub was, ready for a fresh set of lines. */
  const resetScrub = (): void => {
    stopChase();
    cancelSwipe();
    if (dragPointerId !== null && panel.hasPointerCapture(dragPointerId)) {
      panel.releasePointerCapture(dragPointerId);
    }
    dragPointerId = null;
    dragging = false;
    dragAxis = "pending";
    dragBeforeFirst = false;
    activeLine = null;
    shownLine = 0;
    targetLine = 0;
    seekedLine = -1;
    wheelTravel = 0;
    heldAtEnd = false;
  };

  const clearLines = (): void => {
    resetScrub();
    lyricTrack.innerHTML = "";
    lyricTrack.style.transform = "";
    lyricLines = [];
    lineCentres = [];
    renderedLyrics = null;
  };

  let outgoingPage: HTMLElement | null = null;
  let incomingAnimation: Animation | null = null;
  let outgoingAnimation: Animation | null = null;
  let pendingDirection = 0;
  let pendingSwipeSlide: { offset: number; width: number; startedAt: number } | null = null;

  const stopSlides = (): void => {
    incomingAnimation?.cancel();
    outgoingAnimation?.cancel();
    incomingAnimation = null;
    outgoingAnimation = null;
    outgoingPage?.remove();
    outgoingPage = null;
    pendingSwipeSlide = null;
  };

  const directionTo = (snapshot: PlayerSnapshot): number => {
    if (!lastNavigation) {
      return 1;
    }
    const travel = snapshot.travel - lastNavigation.travel;
    if (travel !== 0) {
      return Math.sign(travel);
    }
    if (snapshot.sourceId !== lastNavigation.sourceId) {
      return 1;
    }
    const previous = snapshot.order.indexOf(lastTrackId ?? "");
    let delta = snapshot.cursor - (previous < 0 ? lastNavigation.cursor : previous);
    if (snapshot.repeat !== "off" && Math.abs(delta) > snapshot.order.length / 2) {
      delta += delta > 0 ? -snapshot.order.length : snapshot.order.length;
    }
    return Math.sign(delta) || 1;
  };

  const slideOut = (direction: number): void => {
    const departure = swipeDeparture ?? (dragging && dragAxis === "horizontal"
      ? { offset: swipePainted, width: swipeWidth }
      : null);
    swipeDeparture = null;
    stopSlides();
    pendingDirection = direction;
    lyricPage.style.transform = "";
    if (reduceMotionActive()) {
      return;
    }

    const page = lyricPage.cloneNode(true) as HTMLElement;
    outgoingPage = page;
    page.removeAttribute("id");
    page.setAttribute("aria-hidden", "true");
    page.style.pointerEvents = "none";
    for (const child of page.querySelectorAll<HTMLElement>("[id]")) {
      child.removeAttribute("id");
    }
    const outgoingTrack = page.querySelector<HTMLElement>(".lyrics-track");
    if (outgoingTrack) {
      outgoingTrack.style.transform = getComputedStyle(lyricTrack).transform;
    }
    panel.append(page);
    if (departure) {
      pendingSwipeSlide = { ...departure, startedAt: performance.now() };
    }
    outgoingAnimation = page.animate(
      [
        { transform: departure ? `translateX(${departure.offset}px)` : "translateX(0)" },
        { transform: `translateX(${-direction * 100}%)` },
      ],
      { duration: LYRICS_SLIDE_MS, easing: "ease" },
    );
    outgoingAnimation.onfinish = () => {
      page.remove();
      if (outgoingPage === page) {
        outgoingPage = null;
        outgoingAnimation = null;
      }
    };
  };

  const slideIn = (): void => {
    const direction = pendingDirection;
    pendingDirection = 0;
    const departure = pendingSwipeSlide;
    pendingSwipeSlide = null;
    if (!direction || (visibility ? !visibility.visible("lyrics") : panel.inert) || reduceMotionActive()) {
      return;
    }
    incomingAnimation?.cancel();
    const elapsed = departure ? performance.now() - departure.startedAt : LYRICS_SLIDE_MS;
    const from = departure && elapsed < LYRICS_SLIDE_MS
      ? `translateX(${departure.offset + direction * departure.width}px)`
      : `translateX(${direction * 100}%)`;
    const animation = lyricPage.animate(
      [{ transform: from }, { transform: "translateX(0)" }],
      { duration: LYRICS_SLIDE_MS, easing: "ease" },
    );
    if (departure && elapsed < LYRICS_SLIDE_MS) {
      animation.currentTime = Math.max(elapsed, 0);
    }
    incomingAnimation = animation;
    animation.onfinish = () => {
      if (incomingAnimation === animation) {
        incomingAnimation = null;
      }
    };
  };

  subscribeMotion(() => {
    if (reduceMotionActive()) {
      stopSlides();
    }
  });

  const highlight = (positionMs: number): void => {
    if (lyricLines.length === 0 || (visibility && !visibility.visible("lyrics")) ||
        (!catchingUp && document.documentElement.classList.contains("is-theming"))) {
      return;
    }

    const last = endLine();
    const index = Math.min(Math.max(activeLyricIndex(renderedLyrics ?? [], positionMs), -1), last);
    heldAtEnd = last >= 0 && index === last;

    // The song has run past its last lyric: hold the panel there, highlighted,
    // to the end. A drag is the user asking for an earlier line, so it is left
    // to follow the finger and take the song back with it.
    if (heldAtEnd && !dragging && !scrubbing) {
      stopChase();
      wheelTravel = 0;
      targetLine = last;
      seekedLine = last;
      if (shownLine !== last || activeLine !== lyricLines[last]) {
        shownLine = last;
        paintLine(last);
      }
      return;
    }

    if (scrubbing) {
      return;
    }
    if (index === shownLine && index === targetLine && index === seekedLine) {
      return;
    }
    shownLine = index;
    targetLine = index;
    seekedLine = index;
    paintLine(index);
  };

  panel.addEventListener(
    "wheel",
    (event) => {
      if (lyricLines.length === 0) {
        return;
      }
      event.preventDefault();

      const perLine = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? WHEEL_STEP_PX : 1;
      wheelTravel += event.deltaY * perLine;
      if (targetLine < 0 && wheelTravel < 0) {
        wheelTravel = 0;
        return;
      }

      const steps = Math.trunc(wheelTravel / WHEEL_STEP_PX);
      if (steps === 0) {
        return;
      }
      wheelTravel -= steps * WHEEL_STEP_PX;
      settlingDrag = false;
      targetLine = clampLine(Math.round(targetLine) + steps);
      startChase();
    },
    { passive: false },
  );

  panel.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.isPrimary === false || dragging || lyricLines.length === 0) {
      return;
    }
    // The sheet's own handle is what moves the sheet, not the lyrics.
    if ((event.target as HTMLElement).closest(".lyrics-grab")) {
      return;
    }
    dragBeforeFirst = shownLine < 0 && activeLine === null;
    if (!scrubbing) {
      const transform = getComputedStyle(lyricTrack).transform;
      const offset = transform === "none" ? 0 : -new DOMMatrixReadOnly(transform).m42;
      shownLine = clampLine(lineAt(offset));
    }
    if (chaseFrame !== null) {
      window.cancelAnimationFrame(chaseFrame);
      chaseFrame = null;
    }
    settlingDrag = false;
    settleVelocity = 0;
    dragging = true;
    dragPointerId = event.pointerId;
    dragAxis = phone ? "pending" : "vertical";
    dragOriginX = event.clientX;
    dragOriginY = event.clientY;
    dragOriginCentre = centreAt(shownLine);
    targetLine = shownLine;
    dragVelocity.reset(dragOriginCentre);
    if (phone) {
      swipeWidth = panel.clientWidth;
      swipeVelocity.reset(0);
    }
    scrubbing = true;
    panel.classList.add("is-scrubbing");
    if (dragBeforeFirst) {
      applyTransform(shownLine);
    } else {
      paintLine(shownLine);
    }
    panel.setPointerCapture(event.pointerId);
  });

  const dragTo = (clientY: number): void => {
    shownLine = clampLine(lineAt(dragOriginCentre + (dragOriginY - clientY)));
    targetLine = shownLine;
    dragVelocity.sample(centreAt(shownLine));
    if (dragBeforeFirst && dragOriginY - clientY < VERTICAL_SLOP_PX) {
      applyTransform(shownLine);
      return;
    }
    dragBeforeFirst = false;
    paintLine(shownLine);
    seekToLine(Math.round(shownLine));
  };

  const canSwipe = (direction: number): boolean => {
    const snapshot = player.snapshot();
    return snapshot.order.length > 1 && (snapshot.repeat !== "off" ||
      (direction > 0 ? snapshot.cursor < snapshot.order.length - 1 : snapshot.cursor > 0));
  };

  const moveDrag = (event: PointerEvent): void => {
    const across = event.clientX - dragOriginX;
    const down = event.clientY - dragOriginY;
    if (dragAxis === "pending") {
      if (Math.abs(across) >= SWIPE_SLOP_PX && Math.abs(across) > Math.abs(down) * SWIPE_AXIS_RATIO) {
        dragAxis = "horizontal";
        const transform = incomingAnimation ? getComputedStyle(lyricPage).transform : "none";
        swipeBase = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
        stopSlides();
        swipeOffset = swipeBase;
        swipePainted = swipeBase;
        lyricPage.style.transform = `translateX(${swipeBase}px)`;
        endScrub();
        if (dragBeforeFirst) {
          dragBeforeFirst = false;
          highlight(player.snapshot().positionMs);
        }
      } else if (Math.abs(down) >= VERTICAL_SLOP_PX) {
        dragAxis = "vertical";
      } else {
        return;
      }
    }

    if (dragAxis === "vertical") {
      dragTo(event.clientY);
      return;
    }

    swipeVelocity.sample(across);
    const direction = across < 0 ? 1 : -1;
    const movement = canSwipe(direction) ? across : across * SWIPE_EDGE_RESISTANCE;
    swipeOffset = Math.min(Math.max(swipeBase + movement, -swipeWidth), swipeWidth);
    if (swipeFrame === null) {
      swipeFrame = requestAnimationFrame(() => {
        swipeFrame = null;
        swipePainted = swipeOffset;
        lyricPage.style.transform = `translateX(${swipePainted}px)`;
      });
    }
  };

  const settleSwipe = (): void => {
    lyricPage.style.transform = "";
    if (reduceMotionActive() || swipePainted === 0) {
      return;
    }
    const animation = lyricPage.animate(
      [{ transform: `translateX(${swipePainted}px)` }, { transform: "translateX(0)" }],
      { duration: LYRICS_SLIDE_MS, easing: "ease" },
    );
    incomingAnimation = animation;
    animation.onfinish = () => {
      if (incomingAnimation === animation) {
        incomingAnimation = null;
      }
    };
  };

  panel.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== dragPointerId) {
      return;
    }
    moveDrag(event);
  });

  const endDrag = (event: PointerEvent): void => {
    if (!dragging || event.pointerId !== dragPointerId) {
      return;
    }
    if (event.type !== "pointercancel") {
      moveDrag(event);
    }
    dragging = false;
    dragPointerId = null;
    if (panel.hasPointerCapture(event.pointerId)) {
      panel.releasePointerCapture(event.pointerId);
    }
    if (dragAxis === "horizontal") {
      if (swipeFrame !== null) {
        window.cancelAnimationFrame(swipeFrame);
        swipeFrame = null;
      }
      const distance = event.clientX - dragOriginX;
      const projected = distance + swipeVelocity.velocity() * SWIPE_PROJECTION_SEC;
      const direction = projected < 0 ? 1 : -1;
      if (event.type !== "pointercancel" && Math.abs(distance) >= SWIPE_MIN_PX &&
          Math.abs(projected) >= swipeWidth * SWIPE_SHARE && canSwipe(direction)) {
        swipeDeparture = { offset: swipePainted, width: swipeWidth };
        if (direction > 0) player.next();
        else player.previous();
        if (!swipeDeparture) {
          return;
        }
        swipeDeparture = null;
      }
      dragAxis = "pending";
      settleSwipe();
      return;
    }
    if (dragAxis === "pending") {
      if (event.type !== "pointercancel") {
        dragTo(event.clientY);
      }
      dragAxis = "vertical";
    }
    if (dragBeforeFirst) {
      dragBeforeFirst = false;
      endScrub();
      highlight(player.snapshot().positionMs);
      return;
    }
    settleVelocity = event.type === "pointercancel" ? 0 : dragVelocity.velocity();
    const projected = centreAt(shownLine) + settleVelocity * RELEASE_PROJECTION_SEC;
    targetLine = clampLine(Math.round(lineAt(projected)));
    if (reduceMotionActive()) {
      shownLine = targetLine;
      paintLine(shownLine);
      seekToLine(targetLine);
      endScrub();
      return;
    }
    if (shownLine === targetLine && settleVelocity === 0) {
      endScrub();
      return;
    }
    settlingDrag = true;
    startChase();
  };

  panel.addEventListener("pointerup", endDrag);
  panel.addEventListener("pointercancel", endDrag);

  const renderLyrics = (): void => {
    const { lyrics, lyricsLoading } = getState();

    if (lyrics.length === 0) {
      panel.hidden = !phone;
      hero.classList.remove("has-lyrics");
      if (renderedLyrics !== null) {
        clearLines();
      }
      if (!lyricsLoading) {
        pendingDirection = 0;
        pendingSwipeSlide = null;
      }
      return;
    }

    panel.hidden = false;
    hero.classList.add("has-lyrics");

    if (lyrics !== renderedLyrics) {
      resetScrub();
      if (phone) lyricTrack.style.transition = "none";
      renderedLyrics = lyrics;
      lyricTrack.innerHTML = lyrics
        .map((line) => `<p class="lyric">${escapeHtml(line.text)}</p>`)
        .join("");
      lyricLines = Array.from(lyricTrack.querySelectorAll<HTMLElement>(".lyric"));
      refitLines();
      highlight(player.snapshot().positionMs);
      if (phone) {
        void lyricTrack.offsetHeight;
        lyricTrack.style.transition = "";
      }
      slideIn();
    } else {
      highlight(player.snapshot().positionMs);
    }
  };

  const render = (): void => {
    const track = currentTrack();
    const snapshot = player.snapshot();
    const { sourceName } = snapshot;
    const { tracks } = getState();

    if (!track) {
      hero.classList.add("is-empty");
      cover.removeAttribute("style");
      source.textContent = tracks.length === 0 ? "No library yet" : "Nothing playing";
      title.textContent = tracks.length === 0 ? "Import a folder to begin" : "Pick something to play";
      artist.textContent = "";
      meta.textContent = "";
      panel.hidden = true;
      hero.classList.remove("has-lyrics");
      clearLines();
      stopSlides();
      pendingDirection = 0;
      lastTrackId = null;
      lastNavigation = null;
      return;
    }

    hero.classList.remove("is-empty");
    const coverStyle = plainCoverStyle(track, "now");
    const sourceText = sourceName ? `Playing from ${sourceName}` : "";
    const artistText = track.artist ?? "Unknown artist";
    const metaText = joinMeta([track.album, track.year]);
    if (cover.getAttribute("style") !== coverStyle) cover.setAttribute("style", coverStyle);
    if (source.textContent !== sourceText) source.textContent = sourceText;
    if (title.textContent !== track.title) title.textContent = track.title;
    if (artist.textContent !== artistText) artist.textContent = artistText;
    if (meta.textContent !== metaText) meta.textContent = metaText;

    if (track.id !== lastTrackId) {
      if (phone && lastTrackId && (visibility ? visibility.visible("lyrics") : !panel.inert)) {
        slideOut(directionTo(snapshot));
      } else {
        stopSlides();
        pendingDirection = 0;
      }
      resetScrub();
      lastTrackId = track.id;
      lastNavigation = { sourceId: snapshot.sourceId, cursor: snapshot.cursor, travel: snapshot.travel };
      void ensureColour(track);
      void ensureLyrics(track);
    } else {
      lastNavigation = { sourceId: snapshot.sourceId, cursor: snapshot.cursor, travel: snapshot.travel };
    }

    if (!phone) fitText();
    if (!visibility || visibility.visible("lyrics") || getState().lyrics !== renderedLyrics) {
      renderLyrics();
    }
  };

  subscribe(render);
  player.onChange(render);
  player.onProgress((positionMs) => highlight(positionMs));
  if (visibility && !visibility.visible("lyrics")) {
    panel.classList.add("is-catching-up");
  }
  visibility?.subscribe((view, visible) => {
    if (view !== "lyrics") return;
    if (catchUpFrame !== null) {
      window.cancelAnimationFrame(catchUpFrame);
      catchUpFrame = null;
    }
    if (!visible) {
      panel.classList.add("is-catching-up");
      cancelSwipe();
      stopChase();
      stopSlides();
      pendingDirection = 0;
      return;
    }
    catchingUp = true;
    panel.classList.add("is-catching-up");
    highlight(player.snapshot().positionMs);
    catchingUp = false;
    catchUpFrame = requestAnimationFrame(() => {
      catchUpFrame = requestAnimationFrame(() => {
        catchUpFrame = null;
        panel.classList.remove("is-catching-up");
      });
    });
  });
  layout();
  render();
}
