import type {
  Collection,
  CollectionFilter,
  LyricLine,
  PersistedState,
  Playback,
  Playlist,
  Session,
  Settings,
  Track,
} from "../types";
import { buildCollections, findCollection, sortAlbumTracks } from "./collections";
import { FALLBACK_COLOUR, colourFromId, isUsableAccent } from "./colour";
import * as ipc from "./ipc";
import { plural } from "./format";
import { parseLrc } from "./lrc";
import { Player } from "./player";

/** Follows whatever the current artwork produced. */
export const ADAPTIVE_THEME = "adaptive";

/** How many custom accents are remembered. */
export const RECENT_THEME_LIMIT = 3;

export interface AppState {
  ready: boolean;
  scanning: boolean;
  tracks: Track[];
  tracksById: Map<string, Track>;
  collections: Collection[];
  root: string;
  skipped: number;
  scanErrors: string[];
  likes: Set<string>;
  playlists: Playlist[];
  /** Track id -> `#rrggbb`, mirrored from the persisted cache. */
  colours: Map<string, string>;
  settings: Settings;
  filter: CollectionFilter;
  query: string;
  sort: "name" | "size";
  libraryOpen: boolean;
  queueOpen: boolean;
  recents: string[];
  search: string;
  lyrics: LyricLine[];
  lyricsTrackId: string | null;
  /** Transient message shown in the status strip. */
  notice: string | null;
}

const state: AppState = {
  ready: false,
  scanning: false,
  tracks: [],
  tracksById: new Map(),
  collections: [],
  root: "",
  skipped: 0,
  scanErrors: [],
  likes: new Set(),
  playlists: [],
  colours: new Map(),
  settings: { theme: ADAPTIVE_THEME, volume: 70, recentColours: [] },
  filter: "all",
  query: "",
  sort: "name",
  libraryOpen: false,
  queueOpen: false,
  recents: [],
  search: "",
  lyrics: [],
  lyricsTrackId: null,
  notice: null,
};

const listeners = new Set<() => void>();

/** Ids whose colour has been requested but not resolved yet. */
const coloursInFlight = new Set<string>();
const colourQueue: string[] = [];
let drainingColours = false;

export type ArtworkTier = "now" | "queue" | "background" | "prefetch" | "idle";

const TIER_PRIORITY: Record<ArtworkTier, number> = { now: 0, queue: 1, background: 2, prefetch: 3, idle: 4 };
const TIER_CONCURRENCY: Record<ArtworkTier, number> = { now: 1, queue: 7, background: 2, prefetch: 2, idle: 0 };
/** Track id -> object URL for its artwork. */
const artworkUrls = new Map<string, string>();
const artworkPending = new Map<string, ArtworkTier>();
const artworkInFlight = new Set<string>();
const artworkRunning: Record<ArtworkTier, number> = { now: 0, queue: 0, background: 0, prefetch: 0, idle: 0 };
/** Tracks whose artwork could not be read; not retried this session. */
const artworkFailed = new Set<string>();

let emitScheduled = false;

export const player = new Player((trackId) => state.tracksById.get(trackId)?.durationMs ?? 0);

/** One queue step, shared by the arrow keys and the wheel. */
export function stepTrack(direction: number): void {
  if (direction > 0) {
    player.next();
  } else {
    player.previous();
  }
}

export function getState(): AppState {
  return state;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function trackById(id: string | null): Track | undefined {
  return id ? state.tracksById.get(id) : undefined;
}

export function collectionById(id: string): Collection | undefined {
  return findCollection(state.collections, id);
}

export function currentTrack(): Track | undefined {
  return trackById(player.currentId);
}

export function adaptiveColour(): string {
  const track = currentTrack();
  return track ? colourFor(track) : FALLBACK_COLOUR;
}

export function themeColour(): string {
  const { theme } = state.settings;
  return theme === ADAPTIVE_THEME ? adaptiveColour() : theme;
}

export function colourFor(track: Track): string {
  return state.colours.get(track.id) ?? colourFromId(track.id);
}

export function artworkUrlFor(track: Track, tier: ArtworkTier = "background"): string | null {
  const path = track.artworkPath;
  if (!path || artworkFailed.has(track.id)) {
    return null;
  }

  const cached = artworkUrls.get(track.id);
  if (cached !== undefined) {
    return cached;
  }

  if (tier === "idle") {
    return null;
  }

  if (!artworkInFlight.has(track.id) && !artworkPending.has(track.id)) {
    artworkPending.set(track.id, tier);
    pumpArtwork();
  }

  return null;
}

export function pruneArtworkQueue(window: Set<string>, queue: Set<string>): void {
  for (const [id, tier] of artworkPending) {
    const wanted = tier === "queue" ? window.has(id) : tier === "prefetch" ? queue.has(id) : true;
    if (!wanted) {
      artworkPending.delete(id);
    }
  }
}

export function prefetchArtwork(trackIds: string[]): void {
  for (const id of trackIds) {
    const track = state.tracksById.get(id);
    if (!track?.artworkPath || artworkUrls.has(id) || artworkFailed.has(id)) {
      continue;
    }
    if (!artworkInFlight.has(id) && !artworkPending.has(id)) {
      artworkPending.set(id, "prefetch");
    }
  }
  pumpArtwork();
}

/**
 * Resolves once the current track's artwork is ready to paint, so the window
 * can be revealed without the cover flashing in. Gives up after a moment.
 */
export function whenArtworkReady(): Promise<void> {
  const track = currentTrack();
  if (!track?.artworkPath || artworkUrls.has(track.id)) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let timer = 0;
    let unsubscribe = (): void => {};
    let settled = false;

    const ready = (): boolean => artworkUrls.has(track.id) || artworkFailed.has(track.id);

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      unsubscribe();
      resolve();
    };

    unsubscribe = subscribe(() => {
      if (ready()) {
        finish();
      }
    });
    timer = window.setTimeout(finish, 1200);

    if (ready()) {
      finish();
    }
  });
}

function retainArtwork(): void {
  const keep = new Set<string>(player.snapshot().order);
  for (const id of state.recents) {
    for (const trackId of findCollection(state.collections, id)?.trackIds ?? []) {
      keep.add(trackId);
    }
  }

  for (const [trackId, url] of artworkUrls) {
    if (!keep.has(trackId)) {
      URL.revokeObjectURL(url);
      artworkUrls.delete(trackId);
    }
  }
}

/** Starts as many pending reads as the per-tier limits allow, best tier first. */
function pumpArtwork(): void {
  for (;;) {
    let chosen: string | null = null;
    let chosenTier: ArtworkTier = "background";

    for (const [id, tier] of artworkPending) {
      if (artworkRunning[tier] >= TIER_CONCURRENCY[tier]) {
        continue;
      }
      if (chosen === null || TIER_PRIORITY[tier] < TIER_PRIORITY[chosenTier]) {
        chosen = id;
        chosenTier = tier;
      }
    }

    if (chosen === null) {
      return;
    }

    artworkPending.delete(chosen);
    startArtwork(chosen, chosenTier);
  }
}

function startArtwork(trackId: string, tier: ArtworkTier): void {
  const path = state.tracksById.get(trackId)?.artworkPath;
  if (!path) {
    return;
  }

  artworkInFlight.add(trackId);
  artworkRunning[tier] += 1;

  void ipc
    .artworkBytes(path)
    .then((buffer) => {
      artworkUrls.set(trackId, URL.createObjectURL(new Blob([buffer], { type: imageMime(path) })));
      scheduleEmit();
    })
    .catch(() => {
      // Recorded so a failed read is not retried on every re-render.
      artworkFailed.add(trackId);
    })
    .finally(() => {
      artworkInFlight.delete(trackId);
      artworkRunning[tier] -= 1;
      pumpArtwork();
    });
}

/** Collection cover key -> object URL for its composed image. */
const coverUrls = new Map<string, string>();
const coverPending = new Map<string, string[]>();
const coversInFlight = new Set<string>();
const coverWaiters = new Map<string, ((url: string | null) => void)[]>();
let coversRunning = 0;
const COVER_CONCURRENCY = 1;

export function cachedCoverUrl(paths: string[]): string | null {
  const usable = paths.filter(Boolean).slice(0, 4);
  if (usable.length === 0) {
    return null;
  }
  return coverUrls.get(usable.join("|")) ?? null;
}

export function coverUrl(paths: string[]): Promise<string | null> {
  const usable = paths.filter(Boolean).slice(0, 4);
  if (usable.length === 0) {
    return Promise.resolve(null);
  }

  const key = usable.join("|");
  const cached = coverUrls.get(key);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }

  return new Promise((resolve) => {
    const waiters = coverWaiters.get(key) ?? [];
    waiters.push(resolve);
    coverWaiters.set(key, waiters);

    if (!coversInFlight.has(key) && !coverPending.has(key)) {
      coverPending.set(key, usable);
      pumpCovers();
    }
  });
}

function pumpCovers(): void {
  while (coversRunning < COVER_CONCURRENCY) {
    const next = coverPending.entries().next();
    if (next.done) {
      return;
    }
    const [key, paths] = next.value;
    coverPending.delete(key);
    startCover(key, paths);
  }
}

function startCover(key: string, paths: string[]): void {
  coversInFlight.add(key);
  coversRunning += 1;

  void ipc
    .coverBytes(paths)
    .then((buffer) => {
      const url = URL.createObjectURL(new Blob([buffer], { type: "image/jpeg" }));
      coverUrls.set(key, url);
      resolveCover(key, url);
    })
    .catch(() => {
      // Left uncached, so a later request gets another try.
      resolveCover(key, null);
    })
    .finally(() => {
      coversInFlight.delete(key);
      coversRunning -= 1;
      pumpCovers();
    });
}

function resolveCover(key: string, url: string | null): void {
  const waiters = coverWaiters.get(key);
  coverWaiters.delete(key);
  for (const resolve of waiters ?? []) {
    resolve(url);
  }
}

function imageMime(path: string): string {
  switch (path.split(".").pop()?.toLowerCase()) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    default:
      return "image/jpeg";
  }
}

/**
 * Queues an artwork colour. Requests run one at a time: a 250 track queue would
 * otherwise fire 250 image decodes and 250 state writes at once.
 */
export function ensureColour(track: Track): void {
  if (!track.artworkPath || state.colours.has(track.id) || coloursInFlight.has(track.id)) {
    return;
  }
  coloursInFlight.add(track.id);
  colourQueue.push(track.id);
  void drainColours();
}

async function drainColours(): Promise<void> {
  if (drainingColours) {
    return;
  }
  drainingColours = true;

  while (colourQueue.length > 0) {
    const id = colourQueue.shift();
    if (id === undefined) {
      break;
    }

    const track = state.tracksById.get(id);
    if (!track?.artworkPath) {
      coloursInFlight.delete(id);
      continue;
    }

    try {
      const hex = await ipc.artworkColour(id, track.artworkPath);
      state.colours.set(id, hex);
    } catch {
      // Session-only fallback; the failure is not persisted, so a later launch retries.
      state.colours.set(id, FALLBACK_COLOUR);
    }
    coloursInFlight.delete(id);
    scheduleEmit();
  }

  drainingColours = false;
}

/** Colours and artwork arrive in a stream, so re-render on a trailing edge. */
function scheduleEmit(): void {
  if (emitScheduled) {
    return;
  }
  emitScheduled = true;
  window.setTimeout(() => {
    emitScheduled = false;
    emit();
  }, 150);
}

export async function init(): Promise<void> {
  try {
    const persisted = await ipc.loadState();
    applyPersisted(persisted);
    applySession(persisted.session);
    player.setVolume(state.settings.volume);
    await rescan();
    restorePlayback(persisted.session?.playback);
    wirePersistence();
    state.ready = true;
  } catch (error) {
    state.notice = describe(error);
    state.ready = true;
  }
  emit();
}

export async function rescan(): Promise<void> {
  state.scanning = true;
  emit();

  try {
    const summary = await ipc.scanLibrary();
    state.tracks = summary.tracks;
    state.tracksById = new Map(summary.tracks.map((track) => [track.id, track]));
    state.root = summary.root;
    state.skipped = summary.skipped;
    state.scanErrors = summary.errors;
    recomputeCollections();
    repairQueue();
    applyPersisted(await ipc.loadState());
  } catch (error) {
    state.scanErrors = [describe(error)];
  }

  state.scanning = false;
  emit();
}

export async function importFolder(createPlaylist: boolean): Promise<void> {
  try {
    const folder = await ipc.pickFolder();
    if (!folder) {
      return;
    }

    setNotice("Importing...");
    const outcome = await ipc.importFolder(folder, createPlaylist, null);
    applyPersisted(outcome.state);
    await rescan();

    const parts = [`${plural(outcome.songs, "song")} imported`];
    if (outcome.images > 0) {
      parts.push(plural(outcome.images, "image"));
    }
    if (outcome.lyrics > 0) {
      parts.push(plural(outcome.lyrics, "lyric file"));
    }
    if (outcome.playlist) {
      parts.push(`playlist "${outcome.playlist}" created`);
    }
    if (outcome.errors.length > 0) {
      parts.push(`${outcome.errors.length} failed`);
    }
    setNotice(parts.join(", "));
  } catch (error) {
    setNotice(describe(error));
  }
}

export function setFilter(filter: CollectionFilter): void {
  state.filter = filter;
  schedulePersist();
  emit();
}

export function setQuery(query: string): void {
  state.query = query;
  emit();
}

export function setSort(sort: "name" | "size"): void {
  state.sort = sort;
  schedulePersist();
  emit();
}

export function setSearch(search: string): void {
  state.search = search;
  emit();
}

export function toggleLibrary(open?: boolean): void {
  state.libraryOpen = open ?? !state.libraryOpen;
  emit();
}

export function toggleQueue(open?: boolean): void {
  state.queueOpen = open ?? !state.queueOpen;
  schedulePersist();
  emit();
}

export function setNotice(notice: string | null): void {
  state.notice = notice;
  emit();
}

/** Loads a collection into the queue without starting playback. */
export function openCollection(id: string, startTrackId?: string): void {
  const collection = findCollection(state.collections, id);
  if (!collection || collection.trackIds.length === 0) {
    return;
  }

  const ids =
    collection.kind === "album"
      ? sortAlbumTracks(collection.trackIds, state.tracksById)
      : collection.trackIds;

  player.setQueue(collection.id, collection.name, ids, startTrackId);
  state.recents = [id, ...state.recents.filter((entry) => entry !== id)].slice(0, 3);
  retainArtwork();
  schedulePersist();
  emit();
}

/** Used by search results and card clicks: load the collection and start there. */
export function playFromCollection(id: string, trackId: string): void {
  openCollection(id, trackId);
  player.playTrack(trackId);
}

/** Loads a collection into the queue and starts it from the top. */
export function playCollection(id: string): void {
  openCollection(id);
  player.play();
}

/** Loads a collection, turns shuffle on and starts it. */
export function shuffleCollection(id: string): void {
  openCollection(id);
  player.setShuffle(true);
  player.play();
}

export async function toggleLikeTrack(trackId: string): Promise<void> {
  try {
    applyPersisted(await ipc.toggleLike(trackId));
    emit();
  } catch (error) {
    setNotice(describe(error));
  }
}

export async function createPlaylist(name: string): Promise<void> {
  try {
    applyPersisted(await ipc.createPlaylist(name));
    emit();
  } catch (error) {
    setNotice(describe(error));
  }
}

export async function renamePlaylist(id: string, name: string): Promise<void> {
  try {
    applyPersisted(await ipc.renamePlaylist(id, name));
    emit();
  } catch (error) {
    setNotice(describe(error));
  }
}

export async function deletePlaylist(id: string): Promise<void> {
  try {
    applyPersisted(await ipc.deletePlaylist(id));
    state.recents = state.recents.filter((entry) => entry !== id);
    emit();
  } catch (error) {
    setNotice(describe(error));
  }
}

export async function addTracksToPlaylist(id: string, trackIds: string[]): Promise<void> {
  try {
    applyPersisted(await ipc.addToPlaylist(id, trackIds));
    emit();
  } catch (error) {
    setNotice(describe(error));
  }
}

export async function removeTracksFromPlaylist(id: string, trackIds: string[]): Promise<void> {
  try {
    applyPersisted(await ipc.removeFromPlaylist(id, trackIds));
    emit();
  } catch (error) {
    setNotice(describe(error));
  }
}

export async function reorderPlaylist(id: string, trackIds: string[]): Promise<void> {
  try {
    applyPersisted(await ipc.reorderPlaylist(id, trackIds));
    emit();
  } catch (error) {
    setNotice(describe(error));
  }
}

export async function setTheme(theme: string): Promise<void> {
  const recentColours =
    theme === ADAPTIVE_THEME
      ? state.settings.recentColours
      : [theme, ...state.settings.recentColours.filter((colour) => colour !== theme)].slice(
          0,
          RECENT_THEME_LIMIT,
        );

  try {
    applyPersisted(await ipc.saveSettings({ ...state.settings, theme, recentColours }));
    emit();
  } catch (error) {
    setNotice(describe(error));
  }
}

export function setVolume(volume: number): void {
  player.setVolume(volume);
  void ipc
    .saveSettings({ ...state.settings, volume: player.snapshot().volume })
    .then((next) => {
      applyPersisted(next);
      emit();
    })
    .catch(() => {
      // Volume is cosmetic; a failed write is not worth interrupting playback.
    });
}

/**
 * Reads the lyrics for a track. The index points at the copied `.lrc`; without
 * one, a sidecar sitting beside the song is used. Empty when there is neither.
 */
export async function ensureLyrics(track: Track | undefined): Promise<void> {
  const trackId = track?.id ?? null;
  if (state.lyricsTrackId === trackId) {
    return;
  }

  state.lyricsTrackId = trackId;
  state.lyrics = [];
  emit();

  if (!track) {
    return;
  }

  try {
    const raw = await ipc.loadLyrics(track.lyricsPath ?? track.path);
    if (state.lyricsTrackId !== trackId) {
      return; // a newer track was requested while this one was loading
    }
    state.lyrics = raw ? parseLrc(raw) : [];
  } catch {
    state.lyrics = [];
  }
  emit();
}

function applyPersisted(next: PersistedState): void {
  state.settings = next.settings ?? state.settings;
  state.playlists = next.playlists ?? [];
  state.likes = new Set(next.likes ?? []);
  state.colours = new Map(
    Object.entries(next.artworkColours ?? {}).filter(([, hex]) => isUsableAccent(hex)),
  );
  recomputeCollections();
}

function recomputeCollections(): void {
  state.collections = buildCollections(state.tracks, state.playlists, state.likes);
}

function repairQueue(): void {
  const currentId = player.currentId;
  if (currentId && state.tracksById.has(currentId)) {
    return;
  }

  if (findCollection(state.collections, "all")?.trackIds.length) {
    openCollection("all");
  }
}

/** Restores the browsing bits of the session: history, filter and sort. */
function applySession(session: Session | undefined): void {
  if (!session) {
    return;
  }
  state.recents = session.recents ?? [];
  state.filter = session.filter ?? "all";
  state.sort = session.sort ?? "name";
  state.queueOpen = session.queueOpen ?? false;
}

function restorePlayback(playback: Playback | undefined): void {
  if (!playback || playback.order.length === 0) {
    return;
  }

  const currentId = playback.order[playback.cursor] ?? null;
  const order = playback.order.filter((id) => state.tracksById.has(id));
  if (order.length === 0) {
    return;
  }

  const sourceOrder = playback.sourceOrder.filter((id) => state.tracksById.has(id));
  const cursor = currentId ? Math.max(order.indexOf(currentId), 0) : 0;
  player.restore({ ...playback, order, sourceOrder, cursor });
}

/** How long changes are coalesced before the session is written. */
const PERSIST_DELAY_MS = 350;
let persistTimer: number | null = null;
let persistenceWired = false;

/** Persists the session on every playback change. */
function wirePersistence(): void {
  if (persistenceWired) {
    return;
  }
  persistenceWired = true;
  player.onChange(schedulePersist);
}

/** Writes the session soon, coalescing a burst of changes into one write. */
function schedulePersist(): void {
  if (!state.ready || persistTimer !== null) {
    return;
  }
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    void persistSession();
  }, PERSIST_DELAY_MS);
}

function currentSession(): Session {
  const snapshot = player.snapshot();
  return {
    playback: {
      sourceId: snapshot.sourceId,
      sourceName: snapshot.sourceName,
      sourceOrder: snapshot.sourceOrder,
      order: snapshot.order,
      cursor: snapshot.cursor,
      positionMs: Math.round(snapshot.positionMs),
      shuffle: snapshot.shuffle,
      repeat: snapshot.repeat,
      muted: snapshot.muted,
    },
    recents: state.recents,
    filter: state.filter,
    sort: state.sort,
    queueOpen: state.queueOpen,
  };
}

async function persistSession(): Promise<void> {
  if (!state.ready) {
    return;
  }
  try {
    await ipc.saveSession(currentSession());
  } catch {
    // Persistence is best-effort; a failed write must not disturb playback.
  }
}

export async function flushSession(): Promise<void> {
  if (persistTimer !== null) {
    window.clearTimeout(persistTimer);
    persistTimer = null;
  }
  await persistSession();
}

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
