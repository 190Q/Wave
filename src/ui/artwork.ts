import { cardGradient } from "../lib/colour";
import { escapeHtml } from "../lib/format";
import { artworkUrlFor, colourFor, type ArtworkTier } from "../lib/state";
import type { Track } from "../types";

export function coverStyle(track: Track, tier: ArtworkTier = "background"): string {
  const colour = colourFor(track);
  const url = artworkUrlFor(track, tier);
  if (!url) {
    return `background-color: ${colour}; background-image: ${cardGradient(colour)};`;
  }
  return `background-color: ${colour}; background-image: linear-gradient(180deg, rgb(0 0 0 / 0.08) 40%, rgb(0 0 0 / 0.62) 100%), ${cssUrl(url)};`;
}

export function plainCoverStyle(track: Track, tier: ArtworkTier = "background"): string {
  const colour = colourFor(track);
  const url = artworkUrlFor(track, tier);
  if (!url) {
    return `background-color: ${colour}; background-image: ${cardGradient(colour)};`;
  }
  return `background-color: ${colour}; background-image: ${cssUrl(url)};`;
}

const mosaicCache = new Map<string, string>();
const MOSAIC_CACHE_LIMIT = 500;

export function mosaicHtml(
  trackIds: string[],
  tracksById: Map<string, Track>,
  tier: ArtworkTier = "background",
): string {
  const tracks: Track[] = [];
  for (const id of trackIds) {
    const track = tracksById.get(id);
    if (track) {
      tracks.push(track);
    }
    if (tracks.length === 4) {
      break;
    }
  }

  const key = tracks.map((track) => `${track.id}:${colourFor(track)}`).join("|");
  const cached = mosaicCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const paths = tracks
    .map((track) => track.artworkPath)
    .filter((path): path is string => Boolean(path))
    .slice(0, 4);
  const marker = paths.length > 0 ? ` data-cover="${escapeHtml(paths.join("|"))}"` : "";

  const html = buildMosaic(tracks, tier, marker);
  if (mosaicCache.size >= MOSAIC_CACHE_LIMIT) {
    mosaicCache.clear();
  }
  mosaicCache.set(key, html);
  return html;
}

function buildMosaic(tracks: Track[], tier: ArtworkTier, marker: string): string {
  if (tracks.length === 0) {
    return `<span class="mosaic mosaic-empty"></span>`;
  }

  const cells = [...tracks];
  if (cells.length === 3) {
    cells.push(cells[0]);
  }

  const layout = cells.length === 1 ? "mosaic single" : cells.length === 2 ? "mosaic pair" : "mosaic";
  const tiles = cells
    .map((track) => `<span class="mosaic-cell" style="${plainCoverStyle(track, tier)}"></span>`)
    .join("");

  return `<span class="${layout}"${marker}>${tiles}</span>`;
}

function cssUrl(url: string): string {
  return `url('${url.replace(/'/g, "%27")}')`;
}
