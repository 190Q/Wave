import { activeLyricIndex } from "../lib/lrc";
import { escapeHtml, joinMeta } from "../lib/format";
import { currentTrack, ensureColor, ensureLyrics, getState, player, subscribe } from "../lib/state";
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

  let lastTrackId: string | null = null;
  let renderedLyrics: LyricLine[] | null = null;
  let lyricLines: HTMLElement[] = [];

  const highlight = (positionMs: number): void => {
    if (lyricLines.length === 0) {
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
      void ensureColor(track);
      void ensureLyrics(track);
    }

    renderLyrics();
  };

  subscribe(render);
  player.onChange(render);
  player.onProgress((positionMs) => highlight(positionMs));
  render();
}
