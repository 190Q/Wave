import { cardGradient, colourFromId } from "../lib/colour";
import { escapeHtml } from "../lib/format";
import { artworkUrlFor, colourFor, type ArtworkTier } from "../lib/state";
import type { Collection, Track } from "../types";

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

export function collectionCoverHtml(
  collection: Collection,
  tracksById: Map<string, Track>,
  tier: ArtworkTier = "background",
): string {
  const ids = collection.kind === "album" ? collection.trackIds.slice(0, 1) : collection.trackIds;
  return mosaicHtml(ids, tracksById, tier);
}

export function mosaicHtml(
  trackIds: string[],
  tracksById: Map<string, Track>,
  tier: ArtworkTier = "background",
): string {
  const { tracks, marker } = mosaicTracks(trackIds, tracksById);
  return buildMosaic(tracks, marker, (track) => plainCoverStyle(track, tier));
}

export function resultCoverHtml(collection: Collection, tracksById: Map<string, Track>): string {
  const ids = collection.kind === "album" ? collection.trackIds.slice(0, 1) : collection.trackIds;
  const { tracks, marker } = mosaicTracks(ids, tracksById);
  return buildMosaic(tracks, marker, colourCoverStyle);
}

function mosaicTracks(
  trackIds: string[],
  tracksById: Map<string, Track>,
): { tracks: Track[]; marker: string } {
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

  const paths = tracks
    .map((track) => track.artworkPath)
    .filter((path): path is string => Boolean(path))
    .slice(0, 4);
  const marker = paths.length > 0 ? ` data-cover="${escapeHtml(paths.join("|"))}"` : "";

  return { tracks, marker };
}

function buildMosaic(tracks: Track[], marker: string, styleOf: (track: Track) => string): string {
  if (tracks.length === 0) {
    return `<span class="mosaic mosaic-empty"></span>`;
  }

  const cells = [...tracks];
  if (cells.length === 3) {
    cells.push(cells[0]);
  }

  const layout = cells.length === 1 ? "mosaic single" : cells.length === 2 ? "mosaic pair" : "mosaic";
  const tiles = cells
    .map((track) => `<span class="mosaic-cell" style="${styleOf(track)}"></span>`)
    .join("");

  return `<span class="${layout}"${marker}>${tiles}</span>`;
}

/** The song's own colour, for a cover that must not wait on loaded artwork. */
function colourCoverStyle(track: Track): string {
  const colour = colourFromId(track.id);
  return `background-color: ${colour}; background-image: ${cardGradient(colour)};`;
}

function cssUrl(url: string): string {
  return `url('${url.replace(/'/g, "%27")}')`;
}
