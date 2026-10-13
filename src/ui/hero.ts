import { activeLyricIndex } from "../lib/lrc";
import { escapeHtml, joinMeta } from "../lib/format";
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

/** Wheel deltas are normalised to pixels before accumulating. */
const WHEEL_STEP_PX = 100;
const WHEEL_LINE_PX = 33;
const CHASE_TAU_MS = 80;
const CHASE_LINES_PER_SEC = 40;
const CHASE_LINE_LIMIT = 0.9;
const CHASE_SETTLE_LINES = 0.005;

export function mountHero(): void {
  const hero = document.getElementById("hero");
  const cover = document.getElementById("now-cover");
  const source = document.getElementById("now-source");
  const title = document.getElementById("now-title");
  const artist = document.getElementById("now-artist");
  const meta = document.getElementById("now-meta");
  const panel = document.getElementById("lyrics-panel");
  const lyricTrack = document.getElementById("lyrics");

  if (!hero || !cover || !source || !title || !artist || !meta || !panel || !lyricTrack) {
    return;
  }

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
    fitCover();
    fitText();
    refitLines();
  };

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(layout).observe(hero);
  }
  narrowLayout.addEventListener("change", layout);
  void document.fonts?.ready.then(layout);

  let lastTrackId: string | null = null;
  let renderedLyrics: LyricLine[] | null = null;
  let lyricLines: HTMLElement[] = [];
  let activeLine: HTMLElement | null = null;

  let shownLine = 0;
  let targetLine = 0;
  let scrubbing = false;
  let dragging = false;
  let dragOriginY = 0;
  let dragOriginCentre = 0;
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
    if (lyrics.length === 0 || index === seekedLine) {
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
    endScrub();
  };

  const chase = (now: number): void => {
    chaseFrame = null;

    const elapsed = now - chaseAt;
    chaseAt = now;

    const gap = targetLine - shownLine;
    const reach = Math.min(elapsed / CHASE_TAU_MS, 1);
    const limit = Math.min(CHASE_LINE_LIMIT, (CHASE_LINES_PER_SEC * elapsed) / 1000);
    shownLine += Math.max(-limit, Math.min(limit, gap * reach));
    if (Math.abs(targetLine - shownLine) < CHASE_SETTLE_LINES) {
      shownLine = targetLine;
    }

    paintLine(shownLine);
    seekToLine(Math.round(shownLine));

    if (shownLine !== targetLine) {
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

  /** Forgets where the scrub was, ready for a fresh set of lines. */
  const resetScrub = (): void => {
    stopChase();
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

  const highlight = (positionMs: number): void => {
    if (lyricLines.length === 0 || document.documentElement.classList.contains("is-theming")) {
      return;
    }

    const last = endLine();
    const index = Math.min(Math.max(activeLyricIndex(renderedLyrics ?? [], positionMs), -1), last);
    heldAtEnd = last >= 0 && index === last;

    // The song has run past its last lyric: hold the panel there, highlighted, to the end.
    if (heldAtEnd) {
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
      if (heldAtEnd) {
        return;
      }

      const perLine = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? WHEEL_STEP_PX : 1;
      wheelTravel += event.deltaY * perLine;

      const steps = Math.trunc(wheelTravel / WHEEL_STEP_PX);
      if (steps === 0) {
        return;
      }
      wheelTravel -= steps * WHEEL_STEP_PX;
      targetLine = clampLine(Math.round(targetLine) + steps);
      startChase();
    },
    { passive: false },
  );

  panel.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || lyricLines.length === 0 || heldAtEnd) {
      return;
    }
    dragging = true;
    dragOriginY = event.clientY;
    dragOriginCentre = centreAt(shownLine);
    scrubbing = true;
    panel.classList.add("is-scrubbing");
    panel.setPointerCapture(event.pointerId);
  });

  panel.addEventListener("pointermove", (event) => {
    if (!dragging || heldAtEnd) {
      return;
    }
    // Pulling the lyrics up brings the later ones into the centre, however tall they are.
    targetLine = clampLine(lineAt(dragOriginCentre + (dragOriginY - event.clientY)));
    startChase();
  });

  const endDrag = (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    dragging = false;
    if (panel.hasPointerCapture(event.pointerId)) {
      panel.releasePointerCapture(event.pointerId);
    }
    if (heldAtEnd) {
      endScrub();
      return;
    }
    // Settle on the nearest line, so the highlight and the offset agree.
    targetLine = clampLine(Math.round(targetLine));
    if (shownLine === targetLine) {
      endScrub();
      return;
    }
    startChase();
  };

  panel.addEventListener("pointerup", endDrag);
  panel.addEventListener("pointercancel", endDrag);

  const renderLyrics = (): void => {
    const { lyrics } = getState();

    // No sidecar, no panel: the hero gets the space back instead of showing placeholder text.
    if (lyrics.length === 0) {
      panel.hidden = true;
      hero.classList.remove("has-lyrics");
      if (renderedLyrics !== null) {
        clearLines();
      }
      return;
    }

    panel.hidden = false;
    hero.classList.add("has-lyrics");

    if (lyrics !== renderedLyrics) {
      resetScrub();
      renderedLyrics = lyrics;
      lyricTrack.innerHTML = lyrics
        .map((line) => `<p class="lyric">${escapeHtml(line.text)}</p>`)
        .join("");
      lyricLines = Array.from(lyricTrack.querySelectorAll<HTMLElement>(".lyric"));
      refitLines();
    }

    highlight(player.snapshot().positionMs);
  };

  const render = (): void => {
    const track = currentTrack();
    const { sourceName } = player.snapshot();
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
      lastTrackId = null;
      return;
    }

    hero.classList.remove("is-empty");
    cover.setAttribute("style", plainCoverStyle(track, "now"));
    source.textContent = sourceName ? `Playing from ${sourceName}` : "";
    title.textContent = track.title;
    artist.textContent = track.artist ?? "Unknown artist";
    meta.textContent = joinMeta([track.album, track.year]);

    if (track.id !== lastTrackId) {
      lastTrackId = track.id;
      void ensureColour(track);
      void ensureLyrics(track);
    }

    fitText();
    renderLyrics();
  };

  subscribe(render);
  player.onChange(render);
  player.onProgress((positionMs) => highlight(positionMs));
  layout();
  render();
}
