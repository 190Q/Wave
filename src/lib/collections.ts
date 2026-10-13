import type { Collection, CollectionFilter, Playlist, SearchAlgorithm, Track } from "../types";
import { songCount } from "./format";
import { scoreItems, type FieldsOf } from "./search";

const FEATURE_SPLIT = /\s+(?:feat\.?|ft\.?|featuring|with|vs\.?)\s+/i;
const LIST_SPLIT = /\s*(?:&|;|,|\band\b)\s*/i;

export const COLLECTION_FILTERS: CollectionFilter[] = ["all", "playlists", "artists", "albums"];

export function buildCollections(tracks: Track[], playlists: Playlist[], likes: Set<string>): Collection[] {
  const collections: Collection[] = [];

  collections.push({
    id: "all",
    kind: "all",
    name: "All songs",
    subtitle: songCount(tracks.length),
    trackIds: tracks.map((track) => track.id),
  });

  const likedIds = tracks.filter((track) => likes.has(track.id)).map((track) => track.id);
  collections.push({
    id: "liked",
    kind: "liked",
    name: "Liked Songs",
    subtitle: `Playlist, ${songCount(likedIds.length)}`,
    trackIds: likedIds,
  });

  for (const playlist of playlists) {
    const ids = playlist.trackIds.filter((id) => tracks.some((track) => track.id === id));
    collections.push({
      id: playlist.id,
      kind: "playlist",
      name: playlist.name,
      subtitle: `Playlist, ${songCount(ids.length)}`,
      trackIds: ids,
    });
  }

  // Untagged tracks are skipped entirely rather than filed under a guess.
  for (const [, group] of groupByArtist(tracks)) {
    collections.push({
      id: collectionId("artist", group.name),
      kind: "artist",
      name: group.name,
      subtitle: `Artist, ${songCount(group.tracks.length)}`,
      trackIds: group.tracks.map((track) => track.id),
    });
  }

  const byAlbum = groupBy(tracks, (track) => track.album);
  for (const [album, grouped] of byAlbum) {
    collections.push({
      id: collectionId("album", album),
      kind: "album",
      name: album,
      subtitle: `Album, ${songCount(grouped.length)}`,
      trackIds: grouped.map((track) => track.id),
    });
  }

  return collections;
}

/** Sorts an album the way the disc would have played. */
export function sortAlbumTracks(trackIds: string[], tracksById: Map<string, Track>): string[] {
  return [...trackIds].sort((left, right) => {
    const a = tracksById.get(left);
    const b = tracksById.get(right);
    if (!a || !b) {
      return 0;
    }
    return (
      (a.discNo ?? 0) - (b.discNo ?? 0) ||
      (a.trackNo ?? 0) - (b.trackNo ?? 0) ||
      a.title.localeCompare(b.title)
    );
  });
}

const collectionFields: FieldsOf<Collection> = (collection) => [collection.name];

export function filterCollections(
  collections: Collection[],
  filter: CollectionFilter,
  query: string,
  sort: "name" | "size",
  algorithm: SearchAlgorithm = "substring",
): Collection[] {
  const candidates = collections.filter((collection) => matchesFilter(collection, filter));

  // Relevance outranks the chosen order, but the pinned rows still come first.
  return scoreItems(candidates, query, algorithm, collectionFields, collections)
    .sort(
      (a, b) =>
        Number(isPinned(b.item)) - Number(isPinned(a.item)) ||
        b.score - a.score ||
        (sort === "size"
          ? b.item.trackIds.length - a.item.trackIds.length
          : a.item.name.localeCompare(b.item.name)),
    )
    .map((entry) => entry.item);
}

export function isPinned(collection: Collection): boolean {
  return collection.kind === "all" || collection.kind === "liked";
}

export function findCollection(collections: Collection[], id: string): Collection | undefined {
  return collections.find((collection) => collection.id === id);
}

function matchesFilter(collection: Collection, filter: CollectionFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "playlists":
      return collection.kind === "playlist";
    case "artists":
      return collection.kind === "artist";
    case "albums":
      return collection.kind === "album";
  }
}

function collectionId(kind: string, name: string): string {
  return `${kind}:${name.toLowerCase()}`;
}

interface ArtistGroup {
  name: string;
  tracks: Track[];
}

function featuredNames(artist: string): string[] {
  return artist
    .split(FEATURE_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean);
}

function nameCandidates(name: string): string[] {
  return name
    .split(LIST_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean);
}

function resolveArtist(name: string, known: Set<string>, guest: boolean): string[] {
  const candidates = nameCandidates(name);
  if (candidates.length < 2) {
    return [name];
  }
  if (guest || candidates.some((candidate) => known.has(candidate.toLowerCase()))) {
    return candidates;
  }
  return [name];
}

function groupByArtist(tracks: Track[]): Map<string, ArtistGroup> {
  const credits = tracks.map((track) => ({
    track,
    names: featuredNames(track.artist ?? ""),
  }));

  const spellings = new Map<string, Set<string>>();
  const known = new Set<string>();
  for (const credit of credits) {
    for (const name of credit.names) {
      const candidates = nameCandidates(name);
      if (candidates.length < 2) {
        known.add(name.toLowerCase());
      }
      const spelling = candidates
        .map((candidate) => candidate.toLowerCase())
        .sort()
        .join("\u0000");
      for (const candidate of candidates) {
        const key = candidate.toLowerCase();
        const seen = spellings.get(key) ?? new Set<string>();
        seen.add(spelling);
        spellings.set(key, seen);
      }
    }
  }
  for (const [name, seen] of spellings) {
    if (seen.size > 1) {
      known.add(name);
    }
  }

  const groups = new Map<string, ArtistGroup>();
  for (const credit of credits) {
    const credited = new Map<string, string>();
    credit.names.forEach((name, position) => {
      for (const artist of resolveArtist(name, known, position > 0)) {
        credited.set(artist.toLowerCase(), artist);
      }
    });

    for (const artist of credited.values()) {
      const key = artist.toLowerCase();
      const group = groups.get(key);
      if (group) {
        group.tracks.push(credit.track);
      } else {
        groups.set(key, { name: artist, tracks: [credit.track] });
      }
    }
  }

  return new Map([...groups.entries()].sort(([, a], [, b]) => a.name.localeCompare(b.name)));
}

function groupBy(tracks: Track[], key: (track: Track) => string | null): Map<string, Track[]> {
  const groups = new Map<string, Track[]>();
  for (const track of tracks) {
    const value = key(track)?.trim();
    if (!value) {
      continue;
    }
    const existing = groups.get(value);
    if (existing) {
      existing.push(track);
    } else {
      groups.set(value, [track]);
    }
  }
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
