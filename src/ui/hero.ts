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

  const fitCover = (): void => {
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const styles = getComputedStyle(hero);
    const padX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
    const byHeight = hero.clientHeight - COVER_GAP_REM * rootPx;
    const byWidth = (hero.clientWidth - padX) * COVER_WIDTH_SHARE;
    const size = Math.max(0, Math.min(byHeight, byWidth, COVER_MAX_REM * rootPx));
    hero.style.setProperty("--cover-height", `${size}px`);

    const tooShort = byHeight < COVER_MIN_REM * rootPx;
    hero.classList.toggle("is-cover-hidden", narrowLayout.matches || size < COVER_MIN_REM * rootPx);

    // With no room for even a small cover, the library is out of reach.
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

  const highlight = (positionMs: number): void => {
    if (lyricLines.length === 0 || document.documentElement.classList.contains("is-theming")) {
      return;
    }
    const index = activeLyricIndex(renderedLyrics ?? [], positionMs);
    lyricLines.forEach((line, position) => line.classList.toggle("is-active", position === index));
    lyricTrack.style.transform = `translateY(${-(index + 0.5) * LYRIC_LINE_HEIGHT_REM}rem)`;
  };

  const renderLyrics = (): void => {
    const { lyrics } = getState();

    // No sidecar, no panel: the hero gets the space back instead of showing placeholder text.
    if (lyrics.length === 0) {
      panel.hidden = true;
      hero.classList.remove("has-lyrics");
      if (renderedLyrics !== null) {
        lyricTrack.innerHTML = "";
        lyricLines = [];
        renderedLyrics = null;
      }
      return;
    }

    panel.hidden = false;
    hero.classList.add("has-lyrics");

    if (lyrics !== renderedLyrics) {
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
      lyricTrack.innerHTML = "";
      lyricLines = [];
      renderedLyrics = null;
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
