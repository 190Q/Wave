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

const LYRIC_LINE_HEIGHT_REM = 3;

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
  };

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(layout).observe(hero);
  }
  narrowLayout.addEventListener("change", layout);
  void document.fonts?.ready.then(layout);
  layout();

  let lastTrackId: string | null = null;
  let renderedLyrics: LyricLine[] | null = null;
  let lyricLines: HTMLElement[] = [];
  let activeLine: HTMLElement | null = null;

  let shownLine = 0;
  let targetLine = 0;
  let scrubbing = false;
  let dragging = false;
  let dragOriginY = 0;
  let dragOriginLine = 0;
  let chaseFrame: number | null = null;
  let chaseAt = 0;
  let seekedLine = -1;
  let wheelTravel = 0;

  const lineHeightPx = (): number =>
    lyricLines[0]?.getBoundingClientRect().height ||
    LYRIC_LINE_HEIGHT_REM * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);

  const clampLine = (line: number): number =>
    Math.min(Math.max(line, 0), Math.max(lyricLines.length - 1, 0));

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
    lyricTrack.style.transform = `translateY(${-(line + 0.5) * LYRIC_LINE_HEIGHT_REM}rem)`;
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
  };

  const clearLines = (): void => {
    resetScrub();
    lyricTrack.innerHTML = "";
    lyricLines = [];
    renderedLyrics = null;
  };

  const highlight = (positionMs: number): void => {
    if (lyricLines.length === 0 || document.documentElement.classList.contains("is-theming")) {
      return;
    }
    if (scrubbing) {
      return;
    }
    const index = activeLyricIndex(renderedLyrics ?? [], positionMs);
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
    if (event.button !== 0 || lyricLines.length === 0) {
      return;
    }
    dragging = true;
    dragOriginY = event.clientY;
    dragOriginLine = shownLine;
    scrubbing = true;
    panel.classList.add("is-scrubbing");
    panel.setPointerCapture(event.pointerId);
  });

  panel.addEventListener("pointermove", (event) => {
    if (!dragging) {
      return;
    }
    // Pulling the lyrics up brings the later ones into the centre.
    targetLine = clampLine(dragOriginLine + (dragOriginY - event.clientY) / lineHeightPx());
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
  render();
}
