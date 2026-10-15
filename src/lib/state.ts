import { listen } from "@tauri-apps/api/event";

import type {
  Collection,
  CollectionFilter,
  CoversOutcome,
  GenresOutcome,
  ImportOutcome,
  ImportPlan,
  ImportProgress,
  ImportRecord,
  LibraryInfo,
  LyricLine,
  LoudnessUpdate,
  LyricsOutcome,
  PersistedState,
  Playback,
  Playlist,
  Session,
  Settings,
  SpotifyStatus,
  Track,
  WindowGeometry,
} from "../types";
import { flushAnalytics, mountAnalytics, notePlaybackError, noteTrackEnded, recordEvent, rememberTracks } from "./analytics";
import { AudioEngine } from "./audio";
import { COLLECTION_FILTERS, buildCollections, findCollection, sortAlbumTracks } from "./collections";
import { FALLBACK_COLOUR, colourFromId, isUsableAccent } from "./colour";
import * as ipc from "./ipc";
import { plural } from "./format";
import { gainFor } from "./loudness";
import { parseLrc } from "./lrc";
import { MAX_VOLUME, MIN_VOLUME, Player, easeOutCubic } from "./player";

/** Follows whatever the current artwork produced. */
export const ADAPTIVE_THEME = "adaptive";

/** How many custom accents are remembered. */
export const RECENT_THEME_LIMIT = 3;

/** Sent by the backend when it changes a setting without the UI asking. */
const SETTINGS_EVENT = "settings-changed";

/** Follows one Spotify import, track by track. */
const SPOTIFY_PROGRESS_EVENT = "spotify-import";

/** Sent when the config `.env` is saved, so the credentials can be re-checked. */
const SPOTIFY_CONFIG_EVENT = "spotify-config-changed";

/** Follows one lyrics fetch, song by song. */
const LYRICS_PROGRESS_EVENT = "lyrics-fetch";

/** Follows one covers fetch, song by song. */
const COVERS_PROGRESS_EVENT = "covers-fetch";

/** Follows one genre pass, song by song. */
const GENRES_PROGRESS_EVENT = "genres-fetch";

/** Follows one loudness pass, song by song. */
const LOUDNESS_EVENT = "loudness-scan";

/** How long a burst of saves is left to settle before re-checking. */
const CONFIG_SETTLE_MS = 400;

/** Where `m` on its own puts the mini player. */
const MINI_CORNER = 4;

export interface AppState {
  ready: boolean;
  scanning: boolean;
  tracks: Track[];
  tracksById: Map<string, Track>;
  collections: Collection[];
  root: string;
  skipped: number;
  scanErrors: string[];
  /** What the library holds on disk, `null` when it could not be read. */
  libraryInfo: LibraryInfo | null;
  likes: Set<string>;
  playlists: Playlist[];
  /** The last few imports, newest first. */
  recentImports: ImportRecord[];
  /** One saved window frame per shortcut slot, `null` while unset. */
  windowSlots: (WindowGeometry | null)[];
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
  /** What the import dialog shows about the Spotify credentials. */
  spotify: SpotifyStatus | null;
  spotifyChecking: boolean;
  /** The Spotify import in flight, `null` when nothing is running. */
  importing: ImportProgress | null;
  transferProgress: ImportProgress | null;
  /** The lyrics fetch in flight, and its last result. */
  lyricsProgress: ImportProgress | null;
  /** The covers fetch in flight, and its last result. */
  coversProgress: ImportProgress | null;
  /** The genre pass in flight, and its last result. */
  genresProgress: ImportProgress | null;
  /** How far the loudness pass has got, `null` when nothing is being measured. */
  analysing: { done: number; total: number } | null;
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
  libraryInfo: null,
  likes: new Set(),
  playlists: [],
  recentImports: [],
  windowSlots: [],
  colours: new Map(),
  settings: {
    theme: ADAPTIVE_THEME,
    volume: 70,
    normalizeVolume: true,
    recentColours: [],
    resumeOnLaunch: true,
    reduceMotion: "system",
    rememberWindow: true,
    alwaysOnTop: false,
    miniPlayer: false,
    miniCorner: 4,
    searchAlgorithm: "substring",
    shortcutSlots: [],
    analyticsEnabled: true,
  },
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
  spotify: null,
  spotifyChecking: false,
  importing: null,
  transferProgress: null,
  lyricsProgress: null,
  coversProgress: null,
  genresProgress: null,
  analysing: null,
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

const engine = new AudioEngine({
  onEnded: () => {
    noteTrackEnded();
    player.handleEnded();
  },
  onLoaded: () => player.handleLoaded(),
  onError: () => {
    const title = currentTrack()?.title;
    setNotice(title ? `Could not play "${title}".` : "That song could not be played.");
    notePlaybackError();
    player.handleError();
  },
});

export const player = new Player(engine, (trackId) => {
  const track = state.tracksById.get(trackId);
  return track
    ? { path: track.path, durationMs: track.durationMs, gain: trackGain(track) }
    : undefined;
});

/** The gain a song plays at, or `1` while normalization is switched off. */
function trackGain(track: Track): number {
  return state.settings.normalizeVolume ? gainFor(track) : 1;
}

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
  for (const [trackId, url] of artworkUrls) {
    if (!state.tracksById.has(trackId)) {
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
  watchSettings();
  watchSpotify();
  watchLoudness();
  mountAnalytics({
    player,
    trackById,
    collectionById,
    enabled: () => state.settings.analyticsEnabled,
  });
  try {
    const persisted = await ipc.loadState();
    applyPersisted(persisted);
    applySession(persisted.session);
    player.setVolume(state.settings.volume);
    await rescan();
    if (state.settings.resumeOnLaunch) {
      restorePlayback(persisted.session?.playback);
    }
    wirePersistence();
    state.ready = true;
  } catch (error) {
    state.notice = describe(error);
    state.ready = true;
  }
  emit();
}

async function readLibraryInfo(): Promise<void> {
  try {
    state.libraryInfo = await ipc.libraryInfo();
  } catch {
    state.libraryInfo = null;
  }
}

export async function rescan(): Promise<void> {
  state.scanning = true;
  emit();

  try {
    const summary = await ipc.scanLibrary();
    state.tracks = summary.tracks;
    state.tracksById = new Map(summary.tracks.map((track) => [track.id, track]));
    artworkFailed.clear();
    retainArtwork();
    state.root = summary.root;
    state.skipped = summary.skipped;
    state.scanErrors = summary.errors;
    await readLibraryInfo();
    recomputeCollections();
    repairQueue();
    rememberTracks(summary.tracks);
    applyPersisted(await ipc.loadState());
  } catch (error) {
    state.scanErrors = [describe(error)];
  }

  state.scanning = false;
  emit();

  // Measuring runs behind the scan, so a long pass never holds up the library.
  void analyseLoudness();
}

/** Rescans, then fills in the genre of any song that has none. */
export async function rescanLibrary(): Promise<void> {
  await rescan();
  await backfillGenres();
}

/** Set while a pass is running, so a second one cannot start on top of it. */
let loudnessRunning = false;
/** Set when a pass is asked for while one is already running. */
let loudnessAgain = false;

async function analyseLoudness(): Promise<void> {
  if (state.tracks.length === 0) {
    return;
  }
  if (loudnessRunning) {
    // Whatever arrived since is picked up by the run that follows this one.
    loudnessAgain = true;
    return;
  }
  loudnessRunning = true;

  try {
    do {
      loudnessAgain = false;
      await ipc.analyseLoudness(state.tracks.map((track) => track.id));
    } while (loudnessAgain);
  } catch {
    // A song with no reading simply plays at its own level.
  } finally {
    loudnessRunning = false;
    state.analysing = null;
    emit();
  }
}

/** The one-line summary both import paths finish with. */
function importSummary(outcome: ImportOutcome): string {
  const parts = [`${plural(outcome.songs, "song")} imported`];
  if (outcome.duplicates > 0) {
    parts.push(`${plural(outcome.duplicates, "duplicate")} skipped`);
  }
  if (outcome.similar > 0) {
    parts.push(`${plural(outcome.similar, "song")} sharing a title`);
  }
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
  return parts.join(", ");
}

export async function importFolder(choose: () => Promise<boolean | null>): Promise<void> {
  try {
    const folder = await ipc.pickFolder();
    if (!folder) {
      return;
    }
    const createPlaylist = await choose();
    if (createPlaylist === null) {
      return;
    }

    setNotice("Importing...");
    const outcome = await ipc.importFolder(folder, createPlaylist, null);
    applyPersisted(outcome.state);
    await rescan();
    setNotice(importSummary(outcome));
  } catch (error) {
    setNotice(describe(error));
  }
}

let transferPending = false;

export async function importWaveList(): Promise<void> {
  if (transferPending || jobRunning(state.transferProgress)) {
    return;
  }
  transferPending = true;
  try {
    const path = await ipc.pickWaveList();
    if (!path) {
      return;
    }
    state.transferProgress = {
      phase: "resolving", done: 0, total: 0, label: "",
      message: "Reading the Wave playlist...", failures: [], reused: 0,
    };
    emit();
    const outcome = await ipc.importWaveList(path);
    applyPersisted(outcome.state);
    await rescan();
    const message = importSummary(outcome);
    setNotice(message);
    state.transferProgress = {
      phase: outcome.errors.length ? "failed" : "done",
      done: state.transferProgress?.done ?? 0,
      total: state.transferProgress?.total ?? 0,
      label: "", message, failures: outcome.errors,
      reused: state.transferProgress?.reused ?? 0,
    };
  } catch (error) {
    state.transferProgress = failedProgress(describe(error));
    setNotice(describe(error));
  } finally {
    transferPending = false;
    emit();
  }
}

let exporting = false;

export async function exportCollection(collectionId: string): Promise<void> {
  const collection = collectionById(collectionId);
  if (!collection || !collection.trackIds.length || exporting) {
    return;
  }
  exporting = true;
  try {
    const count = await ipc.exportWaveList(collection.name, collection.trackIds);
    if (count !== null) {
      setNotice(`Exported ${plural(count, "song")} with available covers, lyrics and metadata.`);
    }
  } catch (error) {
    setNotice(describe(error));
  } finally {
    exporting = false;
  }
}

/** Re-reads the config and asks Spotify whether the credentials work. */
export async function refreshSpotifyStatus(): Promise<void> {
  state.spotifyChecking = true;
  emit();

  try {
    state.spotify = await ipc.spotifyStatus();
  } catch (error) {
    state.spotify = {
      envPath: "",
      redirectUri: "",
      configured: false,
      accepted: false,
      ytDlp: false,
      ytDlpSource: "",
      ffmpeg: false,
      message: describe(error),
    };
  }

  state.spotifyChecking = false;
  emit();
}

/** A background job is only in the way while it is actually running. */
export function jobRunning(progress: ImportProgress | null): boolean {
  return progress !== null && progress.phase !== "done" && progress.phase !== "failed";
}

/** The one-line summary a finished covers fetch leaves behind. */
function coversSummary(outcome: CoversOutcome): string {
  const parts = [`${outcome.restored} restored`];
  if (outcome.embedded > 0) {
    parts.push(`${outcome.embedded} from the files`);
  }
  if (outcome.online > 0) {
    parts.push(`${outcome.online} fetched`);
  }
  if (outcome.skipped > 0) {
    parts.push(`${outcome.skipped} already had covers`);
  }
  if (outcome.untagged > 0) {
    parts.push(`${outcome.untagged} with no artist tag`);
  }
  if (outcome.missing > 0) {
    parts.push(`${outcome.missing} not found`);
  }
  if (outcome.errors.length > 0) {
    parts.push(`${outcome.errors.length} failed`);
  }
  return parts.join(", ");
}

/** Restores missing cover art for every song in a collection. */
export async function fetchCovers(collectionId: string): Promise<void> {
  const collection = collectionById(collectionId);
  if (!collection || collection.trackIds.length === 0 || jobRunning(state.coversProgress)) {
    return;
  }

  state.coversProgress = {
    phase: "covers",
    done: 0,
    total: collection.trackIds.length,
    label: "",
    message: "Starting...",
    failures: [],
    reused: 0,
  };
  emit();

  try {
    const outcome = await ipc.fetchCovers(collection.trackIds);
    // The new covers are linked in the index, so the songs need re-reading.
    await rescan();

    const message = coversSummary(outcome);
    setNotice(message);
    state.coversProgress = {
      phase: "done",
      done: collection.trackIds.length,
      total: collection.trackIds.length,
      label: "",
      message,
      failures: outcome.errors,
      reused: 0,
    };
  } catch (error) {
    const message = describe(error);
    setNotice(message);
    state.coversProgress = failedProgress(message);
  }
  emit();
}

/** The one-line summary a finished genre pass leaves behind. */
function genresSummary(outcome: GenresOutcome): string {
  const parts = [`${outcome.tagged} tagged`];
  if (outcome.skipped > 0) {
    parts.push(`${outcome.skipped} already had genres`);
  }
  if (outcome.untagged > 0) {
    parts.push(`${outcome.untagged} with no artist tag`);
  }
  if (outcome.missing > 0) {
    parts.push(`${outcome.missing} not found`);
  }
  if (outcome.paused > 0) {
    parts.push(`waited out the rate limit ${outcome.paused === 1 ? "once" : `${outcome.paused} times`}`);
  }
  if (outcome.errors.length > 0) {
    parts.push(`${outcome.errors.length} failed`);
  }
  if (outcome.gaveUp) {
    parts.push(
      outcome.remaining > 0
        ? `stopped early, ${plural(outcome.remaining, "song")} still without a genre, run it again to carry on`
        : "stopped early",
    );
  }
  return parts.join(", ");
}

/** Writes the genre of every song in a collection into its file. */
export async function fetchGenres(collectionId: string): Promise<void> {
  const collection = collectionById(collectionId);
  if (!collection || collection.trackIds.length === 0 || jobRunning(state.genresProgress)) {
    return;
  }

  state.genresProgress = {
    phase: "genres",
    done: 0,
    total: collection.trackIds.length,
    label: "",
    message: "Starting...",
    failures: [],
    reused: 0,
  };
  emit();

  try {
    const outcome = await ipc.fetchGenres(collection.trackIds);
    // The genres are written into the files, so the songs need re-reading.
    await rescan();

    const message = genresSummary(outcome);
    setNotice(message);
    // Only what the pass got through, so a pass that stopped early says so.
    const handled = Math.max(collection.trackIds.length - outcome.remaining, 0);
    state.genresProgress = {
      phase: "done",
      done: handled,
      total: collection.trackIds.length,
      label: "",
      message,
      failures: outcome.errors,
      reused: 0,
    };
  } catch (error) {
    const message = describe(error);
    setNotice(message);
    state.genresProgress = failedProgress(message);
  }
  emit();
}

/** Set while the library-wide pass is running, so a second one cannot start. */
let genresRunning = false;

async function backfillGenres(): Promise<void> {
  if (state.tracks.length === 0 || genresRunning) {
    return;
  }
  genresRunning = true;

  try {
    const outcome = await ipc.fetchGenres(state.tracks.map((track) => track.id));
    // The genres are written into the files, so the songs need re-reading.
    await rescan();
    setNotice(genresSummary(outcome));
  } catch (error) {
    setNotice(describe(error));
  } finally {
    genresRunning = false;
    state.genresProgress = null;
    emit();
  }
}

/** The one-line summary a finished lyrics fetch leaves behind. */
function lyricsSummary(outcome: LyricsOutcome): string {
  const parts = [`${outcome.fetched} with lyrics`];
  if (outcome.synced > 0) {
    parts.push(`${outcome.synced} with timings`);
  }
  if (outcome.skipped > 0) {
    parts.push(`${outcome.skipped} already had them`);
  }
  if (outcome.untagged > 0) {
    parts.push(`${outcome.untagged} with no artist tag`);
  }
  if (outcome.missing > 0) {
    parts.push(`${outcome.missing} not found`);
  }
  if (outcome.errors.length > 0) {
    parts.push(`${outcome.errors.length} failed`);
  }
  return parts.join(", ");
}

/** Looks lyrics up for every song in a collection and files them. */
export async function fetchLyrics(collectionId: string): Promise<void> {
  const collection = collectionById(collectionId);
  if (!collection || collection.trackIds.length === 0 || jobRunning(state.lyricsProgress)) {
    return;
  }

  state.lyricsProgress = {
    phase: "lyrics",
    done: 0,
    total: collection.trackIds.length,
    label: "",
    message: "Starting...",
    failures: [],
    reused: 0,
  };
  emit();

  try {
    const outcome = await ipc.fetchLyrics(collection.trackIds);
    // The new sidecars are linked in the index, so the songs need re-reading.
    await rescan();

    const message = lyricsSummary(outcome);
    setNotice(message);
    state.lyricsProgress = {
      phase: "done",
      done: collection.trackIds.length,
      total: collection.trackIds.length,
      label: "",
      message,
      failures: outcome.errors,
      reused: 0,
    };
  } catch (error) {
    const message = describe(error);
    setNotice(message);
    state.lyricsProgress = failedProgress(message);
  }
  emit();
}

/** Opens the folder holding the config `.env`, writing the template first. */
export async function openSpotifyConfig(): Promise<void> {
  try {
    await ipc.openSpotifyConfig();
  } catch (error) {
    setNotice(describe(error));
  }
}

/** A Spotify import is only in the way while it is actually running. */
function spotifyBusy(): boolean {
  return state.importing !== null && state.importing.phase !== "failed";
}

/** A failure that stays on screen, rather than a notice that times out. */
function failedProgress(message: string, failures: string[] = []): ImportProgress {
  return {
    phase: "failed",
    done: 0,
    total: 0,
    label: "",
    message,
    failures,
    reused: 0,
  };
}

export async function planSpotify(url: string): Promise<ImportPlan | null> {
  const link = url.trim();
  if (!link || spotifyBusy()) {
    return null;
  }

  // The backend refines this from here; it is the first paint.
  state.importing = {
    phase: "resolving",
    done: 0,
    total: 0,
    label: "",
    message: "Checking your library...",
    failures: [],
    reused: 0,
  };
  emit();

  try {
    const plan = await ipc.spotifyPlan(link);
    state.importing = null;
    emit();
    return plan;
  } catch (error) {
    const message = describe(error);
    setNotice(message);
    state.importing = failedProgress(message);
    emit();
    return null;
  }
}

/** Downloads a Spotify playlist or track and adds it to the library. */
export async function importSpotify(url: string, downloadDuplicates: boolean): Promise<void> {
  const link = url.trim();
  if (!link || spotifyBusy()) {
    return;
  }

  // The backend sends its own updates from here; this is the first paint.
  state.importing = {
    phase: "authorising",
    done: 0,
    total: 0,
    label: "",
    message: "Starting...",
    failures: [],
    reused: 0,
  };
  emit();

  try {
    const outcome = await ipc.importSpotify(link, downloadDuplicates);
    applyPersisted(outcome.state);
    await rescan();
    setNotice(importSummary(outcome));
    state.importing =
      outcome.errors.length > 0
        ? failedProgress(
            `${plural(outcome.songs, "song")} imported, ${outcome.errors.length} failed.`,
            outcome.errors,
          )
        : null;
  } catch (error) {
    const message = describe(error);
    setNotice(message);
    state.importing = failedProgress(message);
  }
  emit();
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
  schedulePersist();
  emit();
}

/** Used by search results and card clicks: load the collection and start there. */
export function playFromCollection(id: string, trackId: string): void {
  openCollection(id, trackId);
  player.playTrack(trackId);
}

export function playTrackInContext(trackId: string): void {
  const { sourceId } = player.snapshot();
  const source = sourceId ? findCollection(state.collections, sourceId) : undefined;
  if (source && source.trackIds.includes(trackId)) {
    playFromCollection(source.id, trackId);
    return;
  }
  playFromCollection("all", trackId);
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
    recordEvent(state.likes.has(trackId) ? "like" : "unlike", { trackIds: [trackId] });
    emit();
  } catch (error) {
    setNotice(describe(error));
  }
}

/** Likes or unlikes a whole selection, in one write rather than one per song. */
export async function setTracksLiked(trackIds: string[], liked: boolean): Promise<void> {
  if (trackIds.length === 0) {
    return;
  }

  try {
    applyPersisted(await ipc.setLikes(trackIds, liked));
    recordEvent(liked ? "like" : "unlike", { trackIds });
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

export async function createPlaylistWithTracks(name: string, trackIds: string[]): Promise<void> {
  try {
    const before = new Set(state.playlists.map((playlist) => playlist.id));
    applyPersisted(await ipc.createPlaylist(name));
    const created = state.playlists.find((playlist) => !before.has(playlist.id));
    if (created && trackIds.length > 0) {
      applyPersisted(await ipc.addToPlaylist(created.id, trackIds));
      recordEvent("playlist_add", { trackIds, playlistId: created.id, value: created.name });
    }
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
  const name = state.playlists.find((playlist) => playlist.id === id)?.name ?? null;
  try {
    applyPersisted(await ipc.deletePlaylist(id));
    recordEvent("playlist_remove", { playlistId: id, value: name });
    state.recents = state.recents.filter((entry) => entry !== id);
    emit();
  } catch (error) {
    setNotice(describe(error));
  }
}

export async function deleteTracks(trackIds: string[]): Promise<void> {
  if (trackIds.length === 0) {
    return;
  }

  const title = trackIds.length === 1 ? state.tracksById.get(trackIds[0])?.title : undefined;

  try {
    applyPersisted(await ipc.deleteTracks(trackIds));
    for (const id of trackIds) {
      player.removeFromQueue(id);
    }
    await rescan();
    setNotice(title ? `Deleted "${title}".` : `${plural(trackIds.length, "song")} deleted.`);
  } catch (error) {
    setNotice(describe(error));
  }
}

export async function addTracksToPlaylist(id: string, trackIds: string[]): Promise<void> {
  try {
    applyPersisted(await ipc.addToPlaylist(id, trackIds));
    recordEvent("playlist_add", {
      trackIds,
      playlistId: id,
      value: state.playlists.find((playlist) => playlist.id === id)?.name ?? null,
    });
    emit();
  } catch (error) {
    setNotice(describe(error));
  }
}

export async function removeTracksFromPlaylist(id: string, trackIds: string[]): Promise<void> {
  try {
    applyPersisted(await ipc.removeFromPlaylist(id, trackIds));
    recordEvent("playlist_remove", {
      trackIds,
      playlistId: id,
      value: state.playlists.find((playlist) => playlist.id === id)?.name ?? null,
    });
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

/** Remembers the window as it stands now against a shortcut slot. */
export async function captureWindowSlot(slot: number): Promise<void> {
  try {
    applyPersisted(await ipc.saveWindowSlot(slot));
    emit();
  } catch (error) {
    setNotice(describe(error));
  }
}

/** Flips the always-on-top setting, for the shortcut slots. */
export async function toggleAlwaysOnTop(): Promise<void> {
  await updateSettings({ alwaysOnTop: !state.settings.alwaysOnTop });
}

export async function toggleMiniPlayer(corner?: number): Promise<void> {
  const { miniPlayer } = state.settings;


  if (miniPlayer && corner !== undefined) {
    try {
      applyPersisted(await ipc.placeMiniPlayer(corner));
      emit();
    } catch (error) {
      setNotice(describe(error));
    }
    return;
  }

  if (miniPlayer) {
    await updateSettings({ miniPlayer: false });
    return;
  }

  await updateSettings({ miniPlayer: true, miniCorner: corner ?? MINI_CORNER });
}

let configTimer: number | null = null;

/** Follows the Spotify import and the config file, for the dialog. */
function watchSpotify(): void {
  void listen<ImportProgress>("wavelist-import", (event) => {
    state.transferProgress = event.payload;
    emit();
  }).catch(() => {
    // A plain browser has no Tauri event bridge.
  });
  void listen<ImportProgress>(SPOTIFY_PROGRESS_EVENT, (event) => {
    state.importing = event.payload;
    emit();
  }).catch(() => {
    // Not running inside Tauri, for example `npm run dev` in a browser.
  });

  void listen<ImportProgress>(LYRICS_PROGRESS_EVENT, (event) => {
    state.lyricsProgress = event.payload;
    emit();
  }).catch(() => {
    // Same as above.
  });

  void listen<ImportProgress>(COVERS_PROGRESS_EVENT, (event) => {
    state.coversProgress = event.payload;
    emit();
  }).catch(() => {
    // Same as above.
  });

  void listen<ImportProgress>(GENRES_PROGRESS_EVENT, (event) => {
    state.genresProgress = event.payload;
    emit();
  }).catch(() => {
    // Same as above.
  });

  void listen(SPOTIFY_CONFIG_EVENT, () => {
    // One save can arrive as several events, so wait for the dust to settle.
    if (configTimer !== null) {
      window.clearTimeout(configTimer);
    }
    configTimer = window.setTimeout(() => {
      configTimer = null;
      void refreshSpotifyStatus();
    }, CONFIG_SETTLE_MS);
  }).catch(() => {
    // Same as above: the browser has no config watcher.
  });
}

/** Follows a loudness pass, so each reading lands as soon as it is measured. */
function watchLoudness(): void {
  void listen<LoudnessUpdate>(LOUDNESS_EVENT, (event) => {
    const { id, lufs, peak, done, total } = event.payload;

    const track = state.tracksById.get(id);
    if (track) {
      track.lufs = lufs;
      track.peak = peak;
    }
    state.analysing = { done, total };

    if (player.currentId === id) {
      player.refreshGain();
    }
    emit();
  }).catch(() => {
    // Not running inside Tauri, for example `npm run dev` in a browser.
  });
}

function watchSettings(): void {
  void listen<Settings>(SETTINGS_EVENT, (event) => {
    state.settings = event.payload;
    emit();
  }).catch(() => {
    // Not running inside Tauri, for example `npm run dev` in a browser.
  });
}

/** Steps through Adaptive and the remembered colours. */
export function cycleAccent(): void {
  const { theme, recentColours } = state.settings;
  const choices = [ADAPTIVE_THEME, ...recentColours];
  const next = choices[choices.indexOf(theme) + 1] ?? ADAPTIVE_THEME;
  void setTheme(next);
}

export async function updateSettings(patch: Partial<Settings>): Promise<boolean> {
  try {
    applyPersisted(await ipc.saveSettings({ ...state.settings, ...patch }));
    if (patch.normalizeVolume !== undefined) {
      // The song playing right now should follow the switch, not the next one.
      player.refreshGain();
    }
    emit();
    return true;
  } catch (error) {
    setNotice(describe(error));
    return false;
  }
}

export function setVolume(volume: number): void {
  player.setVolume(volume);
  scheduleVolumeSave();
}

/** How long a burst of volume changes is left to settle before it is written. */
const VOLUME_SAVE_MS = 400;
let volumeTimer: number | null = null;
let volumeUnsaved = false;

/** The volume is written once, after a burst of changes has settled. */
function scheduleVolumeSave(): void {
  volumeUnsaved = true;
  if (volumeTimer !== null) {
    window.clearTimeout(volumeTimer);
  }
  volumeTimer = window.setTimeout(() => {
    volumeTimer = null;
    void saveVolume();
  }, VOLUME_SAVE_MS);
}

async function saveVolume(): Promise<void> {
  if (!volumeUnsaved) {
    return;
  }
  try {
    applyPersisted(await ipc.saveSettings({ ...state.settings, volume: player.snapshot().volume }));
    volumeUnsaved = false;
    emit();
  } catch {
    // Volume is cosmetic; a failed write is not worth interrupting playback.
  }
}

/** How far one volume step moves. The player clamps the result. */
const VOLUME_STEP = 10;

/** How long one step takes to run its course. */
const VOLUME_RAMP_MS = 200;

let volumeRamp: number | null = null;

export function stepVolume(direction: number): void {
  const from = player.snapshot().volume;
  const to = Math.min(Math.max(from + direction * VOLUME_STEP, MIN_VOLUME), MAX_VOLUME);

  if (to === from) {
    setVolume(to);
    return;
  }

  if (volumeRamp !== null) {
    window.cancelAnimationFrame(volumeRamp);
    volumeRamp = null;
  }

  const startedAt = performance.now();
  const run = (now: number): void => {
    const progress = Math.min((now - startedAt) / VOLUME_RAMP_MS, 1);
    setVolume(from + (to - from) * easeOutCubic(progress));
    volumeRamp = progress < 1 ? requestAnimationFrame(run) : null;
  };
  volumeRamp = requestAnimationFrame(run);
}

/**
 * Reads the lyrics for a track. The backend resolves the file it recorded, or a
 * sidecar sitting beside the audio. Empty when there is neither.
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
    const raw = await ipc.loadLyrics(track.id);
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
  state.windowSlots = next.windowSlots ?? [];
  state.recentImports = next.recentImports ?? [];
  state.spotify = next.spotify ?? null;
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
  state.filter = knownFilter(session.filter);
  state.sort = session.sort ?? "name";
  state.queueOpen = session.queueOpen ?? false;
}

function knownFilter(value: string | undefined): CollectionFilter {
  return COLLECTION_FILTERS.find((filter) => filter === value) ?? "all";
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

const AUTOSAVE_MS = 15_000;

let persistTimer: number | null = null;
let autosaveTimer: number | null = null;
let autosaving = false;
let persistenceWired = false;

/** The session as it was last written, so an unchanged one is not rewritten. */
let savedSession: string | null = null;

/** Persists the session on every playback change, and on a slow timer. */
function wirePersistence(): void {
  if (persistenceWired) {
    return;
  }
  persistenceWired = true;
  player.onChange(schedulePersist);
  autosaveTimer = window.setInterval(() => void autosave(), AUTOSAVE_MS);
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

async function autosave(): Promise<void> {
  if (!state.ready || autosaving) {
    return;
  }
  autosaving = true;
  try {
    await saveVolume();
    await persistSession();
    await ipc.saveWindowGeometry();
  } catch {
    // Best effort; the next tick tries again.
  } finally {
    autosaving = false;
  }
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
  const session = currentSession();
  const encoded = JSON.stringify(session);
  if (encoded === savedSession) {
    return;
  }
  try {
    await ipc.saveSession(session);
    savedSession = encoded;
  } catch {
    // Persistence is best-effort; a failed write must not disturb playback.
  }
}

export async function flushSession(): Promise<void> {
  if (persistTimer !== null) {
    window.clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (volumeTimer !== null) {
    window.clearTimeout(volumeTimer);
    volumeTimer = null;
  }
  if (autosaveTimer !== null) {
    window.clearInterval(autosaveTimer);
    autosaveTimer = null;
  }
  await saveVolume();
  await persistSession();
  // The listen still running is written down before the window goes.
  await flushAnalytics();
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
