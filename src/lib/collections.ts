import type { Collection, CollectionFilter, Playlist, Track } from "../types";
import { songCount } from "./format";

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
  const byArtist = groupBy(tracks, (track) => track.artist);
  for (const [artist, grouped] of byArtist) {
    collections.push({
      id: collectionId("artist", artist),
      kind: "artist",
      name: artist,
      subtitle: `Artist, ${songCount(grouped.length)}`,
      trackIds: grouped.map((track) => track.id),
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

export function filterCollections(
  collections: Collection[],
  filter: CollectionFilter,
  query: string,
  sort: "name" | "size",
): Collection[] {
  const needle = query.trim().toLowerCase();

  return collections
    .filter((collection) => matchesFilter(collection, filter))
    .filter((collection) => !needle || collection.name.toLowerCase().includes(needle))
    .sort((a, b) => {
      // All songs and Liked Songs stay pinned to the top.
      const pinned = Number(isPinned(b)) - Number(isPinned(a));
      if (pinned !== 0) {
        return pinned;
      }
      return sort === "size"
        ? b.trackIds.length - a.trackIds.length
        : a.name.localeCompare(b.name);
    });
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
    case "liked":
      return collection.kind === "liked";
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
