import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type {
  Collection,
  CollectionFilter,
  CollectionSort,
  AudioCut,
  CoversOutcome,
  DeezerStatus,
  EqBand,
  EqContextKind,
  EqContextRule,
  EqOutput,
  EqPreset,
  EqPresetSource,
  GenresOutcome,
  ImportOutcome,
  ImportPlan,
  ImportProgress,
  ImportRecord,
  LibraryInfo,
  LyricLine,
  LoudnessUpdate,
  LyricsOutcome,
  PendingTrack,
  PersistedState,
  Playback,
  Playlist,
  PlaylistMode,
  RecommendStatus,
  ScanSummary,
  Session,
  Settings,
  SpotifyStatus,
  Track,
  TrackMetadata,
  UpdateInfo,
  UpdateProgress,
  WindowGeometry,
  YoutubeStatus,
} from "../types";
import { flushAnalytics, mountAnalytics, notePlaybackError, noteTrackEnded, recordEvent, rememberTracks } from "./analytics";
import { nearbyArtwork } from "./artwork-priority";
import { AudioEngine, trackAudioPath } from "./audio";
import { mountAudioWatchdog } from "./audio-watchdog";
import type { EqProfile } from "./autoeq";
import { COLLECTION_FILTERS, buildCollections, findCollection, isUnknownCollection, sortAlbumTracks } from "./collections";
import { FALLBACK_COLOUR, colourFromId, isUsableAccent } from "./colour";
import { device, isAndroidPlatform, isWebKitGtk } from "./device";
import { DEFAULT_EQ_BANDS, EqChain } from "./eq";
import * as ipc from "./ipc";
import { plural } from "./format";
import { gainFor } from "./loudness";
import { parseLrc } from "./lrc";
import { MAX_VOLUME, MIN_VOLUME, Player, easeOutCubic } from "./player";
import { newestSession, readSessionRecovery, SESSION_RECOVERY_KEY } from "./session-recovery";

/** Follows whatever the current artwork produced. */
export const ADAPTIVE_THEME = "adaptive";

/** How many custom accents are remembered. */
export const RECENT_THEME_LIMIT = 3;

/** Sent by the backend when it changes a setting without the UI asking. */
const SETTINGS_EVENT = "settings-changed";

/** Follows one link import, track by track, whichever service it came from. */
const SOURCE_PROGRESS_EVENT = "source-import";

/** Sent when the config `.env` is saved, so the setup can be re-checked. */
const CONFIG_EVENT = "config-changed";

/** Follows one lyrics fetch, song by song. */
const LYRICS_PROGRESS_EVENT = "lyrics-fetch";

/** Follows one covers fetch, song by song. */
const COVERS_PROGRESS_EVENT = "covers-fetch";

/** Follows one genre pass, song by song. */
const GENRES_PROGRESS_EVENT = "genres-fetch";

/** Sent as each song is filed into the library, so a download shows up live. */
const LANDED_EVENT = "library-landed";

/** Follows one loudness pass, song by song. */
const LOUDNESS_EVENT = "loudness-scan";

/** Follows one playlist generation, phase by phase. */
const GENERATE_PROGRESS_EVENT = "playlist-generate";

/** Follows one update download, so the popup can show how far it has got. */
const UPDATE_PROGRESS_EVENT = "update-progress";

/** Sent when the local API scans or deletes, so the window follows the change. */
const LIBRARY_CHANGED_EVENT = "library-changed";

/** Sent when the local API writes likes, playlists or settings. */
const STATE_CHANGED_EVENT = "state-changed";

/** How long a burst of saves is left to settle before re-checking. */
const CONFIG_SETTLE_MS = 400;

/** Where `m` on its own puts the mini player. */
const MINI_CORNER = 4;

export interface AppState {
  ready: boolean;
  /** The version this build is running, empty until the backend has said. */
  appVersion: string;
  scanning: boolean;
  tracks: Track[];
  tracksById: Map<string, Track>;
  collections: Collection[];
  /** Bumped whenever the collections are rebuilt, so a pane can tell cheaply. */
  collectionsRevision: number;
  root: string;
  skipped: number;
  scanErrors: string[];
  /** What the library holds on disk, `null` when it could not be read. */
  libraryInfo: LibraryInfo | null;
  likes: Set<string>;
  playlists: Playlist[];
  /** Pending entries by id, so a row can be drawn before it is downloaded. */
  pendingById: Map<string, PendingTrack>;
  /** Whether generation is offered yet, `null` until the first read lands. */
  recommend: RecommendStatus | null;
  /** The last few imports, newest first. */
  recentImports: ImportRecord[];
  /** One saved window frame per shortcut slot, `null` while unset. */
  windowSlots: (WindowGeometry | null)[];
  /** Track id -> `#rrggbb`, mirrored from the persisted cache. */
  colours: Map<string, string>;
  settings: Settings;
  filter: CollectionFilter;
  query: string;
  sort: CollectionSort;
  /** Track id -> how often it has been streamed, for the orders that need it. */
  playCounts: Map<string, number>;
  analyticsRevision: number;
  libraryOpen: boolean;
  queueOpen: boolean;
  recents: string[];
  search: string;
  lyrics: LyricLine[];
  lyricsTrackId: string | null;
  lyricsLoading: boolean;
  /** Transient message shown in the status strip. */
  notice: string | null;
  folderImport: string | null;
  /** What the import dialog shows about the Spotify credentials. */
  spotify: SpotifyStatus | null;
  spotifyChecking: boolean;
  /** What it shows about Deezer, which needs the tools and nothing else. */
  deezer: DeezerStatus | null;
  deezerChecking: boolean;
  /** What it shows about a pasted link, which needs the same tools. */
  youtube: YoutubeStatus | null;
  youtubeChecking: boolean;
  /** The link import in flight, `null` when nothing is running. */
  importing: ImportProgress | null;
  transferProgress: ImportProgress | null;
  /** The generation in flight, and its last result. */
  generateProgress: ImportProgress | null;
  /** The download in flight, and its last result. */
  downloadProgress: ImportProgress | null;
  /** The playlist the download in flight is for. */
  downloadPlaylistId: string | null;
  /** The lyrics fetch in flight, and its last result. */
  lyricsProgress: ImportProgress | null;
  /** The covers fetch in flight, and its last result. */
  coversProgress: ImportProgress | null;
  /** The genre pass in flight, and its last result. */
  genresProgress: ImportProgress | null;
  /** How far the loudness pass has got, `null` when nothing is being measured. */
  analysing: { done: number; total: number } | null;
  /** The newer release the last check found, `null` when there is none. */
  update: UpdateInfo | null;
  /** True while a check is in flight. */
  updateChecking: boolean;
  /** When a launch check turned up a version the store did not already hold. */
  updateFoundAt: number;
  /** How far an update download has got, `null` when nothing is being installed. */
  updateProgress: UpdateProgress | null;
  /** What a check or an install said when it went wrong. */
  updateError: string | null;
}

export async function refreshAnalytics(): Promise<void> {
  await rememberTracks(state.tracks);
  state.analyticsRevision += 1;
  emit();
  await Promise.all([loadPlayCounts(true), refreshRecommendStatus()]);
}

function applyLikes(likes: string[]): void {
  if (!sameLikes(state.likes, likes)) {
    state.likes = new Set(likes);
    refreshCollections();
  }
}

function settingsReadable(): boolean {
  return settingsPending === 0 && eqSaving === 0;
}

function persistedReadToken(): {
  id: number; settings: number; likes: number; playlists: number;
  settingsReadable: boolean; likesClean: boolean; playlistsClean: boolean;
} {
  return {
    id: ++persistedRead,
    settings: settingsEpoch,
    likes: likesEpoch,
    playlists: playlistsEpoch,
    settingsReadable: settingsReadable(),
    likesClean: likesPending === 0,
    playlistsClean: playlistsPending === 0,
  };
}

function applyReadState(next: PersistedState, token: ReturnType<typeof persistedReadToken>): void {
  if (token.id !== persistedRead) {
    return;
  }
  const settings = token.settingsReadable && settingsReadable() && token.settings === settingsEpoch;
  const likes = token.likesClean && likesPending === 0 && token.likes === likesEpoch;
  const playlists = token.playlistsClean && playlistsPending === 0 && token.playlists === playlistsEpoch;
  refreshSettingsAfterWrites ||= !settings;
  refreshLikesAfterWrites ||= !likes;
  refreshPlaylistsAfterWrites ||= !playlists;
  applyPersisted(next, settings, likes, playlists);
  refreshAfterWrites();
}

function refreshAfterWrites(): void {
  let refresh = false;
  if (refreshSettingsAfterWrites && settingsReadable()) {
    refreshSettingsAfterWrites = false;
    refresh = true;
  }
  if (refreshLikesAfterWrites && likesPending === 0) {
    refreshLikesAfterWrites = false;
    refresh = true;
  }
  if (refreshPlaylistsAfterWrites && playlistsPending === 0) {
    refreshPlaylistsAfterWrites = false;
    refresh = true;
  }
  if (refresh) {
    void refreshPersistedState();
  }
}

async function refreshPersistedState(): Promise<void> {
  const token = persistedReadToken();
  try {
    const next = await ipc.loadState();
    applyReadState(next, token);
    emit();
  } catch {
    // The next event or scan can retry.
  }
}

const state: AppState = {
  ready: false,
  appVersion: "",
  scanning: false,
  tracks: [],
  tracksById: new Map(),
  collections: [],
  collectionsRevision: 0,
  root: "",
  skipped: 0,
  scanErrors: [],
  libraryInfo: null,
  likes: new Set(),
  playlists: [],
  pendingById: new Map(),
  recommend: null,
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
    showTitlebar: null,
    alwaysOnTop: false,
    miniPlayer: false,
    miniCorner: 4,
    searchAlgorithm: "substring",
    shortcutSlots: [],
    analyticsEnabled: true,
    systemMediaControls: true,
    ...(isAndroidPlatform ? {} : { discordPresence: false, localApiEnabled: false }),
    autoUpdate: true,
    eqEnabled: false,
    eqBands: [],
    eqAutoPreamp: true,
    eqPreampDb: 0,
    eqLimiter: true,
    eqPresets: [],
    eqActivePresetId: null,
    eqDeviceRules: {},
    eqContextRules: [],
    eqOutputId: "",
  },
  filter: "all",
  query: "",
  sort: "name",
  playCounts: new Map(),
  analyticsRevision: 0,
  libraryOpen: false,
  queueOpen: false,
  recents: [],
  search: "",
  lyrics: [],
  lyricsTrackId: null,
  lyricsLoading: false,
  notice: null,
  folderImport: null,
  spotify: null,
  spotifyChecking: false,
  deezer: null,
  deezerChecking: false,
  youtube: null,
  youtubeChecking: false,
  importing: null,
  transferProgress: null,
  generateProgress: null,
  downloadProgress: null,
  downloadPlaylistId: null,
  lyricsProgress: null,
  coversProgress: null,
  genresProgress: null,
  analysing: null,
  update: null,
  updateChecking: false,
  updateFoundAt: 0,
  updateProgress: null,
  updateError: null,
};

const listeners = new Set<() => void>();

let confirmedSettings: Settings | null = null;
let settingsWrites: Promise<void> = Promise.resolve();
let settingsPending = 0;
let settingsEpoch = 0;
let settingsVersion = 0;
const settingVersions: Partial<Record<keyof Settings, number>> = {};
let likesWrites: Promise<void> = Promise.resolve();
let likesPending = 0;
let likesEpoch = 0;
let playlistsWrites: Promise<void> = Promise.resolve();
let playlistsPending = 0;
let playlistsEpoch = 0;
let persistedRead = 0;
let refreshSettingsAfterWrites = false;
let refreshLikesAfterWrites = false;
let refreshPlaylistsAfterWrites = false;

function markSettingsPatch(patch: Partial<Settings>): Partial<Record<keyof Settings, number>> {
  const versions: Partial<Record<keyof Settings, number>> = {};
  for (const key of Object.keys(patch) as (keyof Settings)[]) {
    const version = ++settingsVersion;
    settingVersions[key] = version;
    versions[key] = version;
  }
  settingsEpoch += 1;
  return versions;
}

function currentSettingVersions(patch: Partial<Settings>): Partial<Record<keyof Settings, number>> {
  const versions: Partial<Record<keyof Settings, number>> = {};
  for (const key of Object.keys(patch) as (keyof Settings)[]) {
    versions[key] = settingVersions[key];
  }
  return versions;
}

function applySettingsFields(
  settings: Settings,
  versions: Partial<Record<keyof Settings, number>>,
): void {
  const patch: Partial<Settings> = {};
  for (const key of Object.keys(versions) as (keyof Settings)[]) {
    if (settingVersions[key] === versions[key]) {
      Object.assign(patch, { [key]: settings[key] });
    }
  }
  state.settings = { ...state.settings, ...patch };
  eq.apply(state.settings);
}

function applyPlaylists(playlists: Playlist[]): void {
  if (!samePlaylists(state.playlists, playlists)) {
    state.playlists = playlists;
    state.pendingById = indexPending(playlists);
    refreshCollections();
  }
}

function queueSettingsWrite(
  patch: Partial<Settings>,
  versions = markSettingsPatch(patch),
  save: (patch: Partial<Settings>) => Promise<PersistedState> = ipc.patchSettings,
  restoreOnFailure = true,
): Promise<void> {
  settingsPending += 1;
  settingsEpoch += 1;
  const operation = settingsWrites.then(async () => {
    try {
      const next = await save(patch);
      confirmedSettings = next.settings;
      applySettingsFields(next.settings, versions);
      emit();
    } catch (error) {
      if (restoreOnFailure && confirmedSettings) {
        applySettingsFields(confirmedSettings, versions);
        emit();
      }
      throw error;
    }
  }).finally(() => {
    settingsPending -= 1;
    settingsEpoch += 1;
    refreshAfterWrites();
  });
  settingsWrites = operation.catch(() => {});
  return operation;
}

function queueLikesWrite(write: () => Promise<PersistedState>): Promise<PersistedState> {
  likesPending += 1;
  likesEpoch += 1;
  const operation = likesWrites.then(async () => {
    const next = await write();
    applyLikes(next.likes ?? []);
    return next;
  }).finally(() => {
    likesPending -= 1;
    likesEpoch += 1;
    refreshAfterWrites();
  });
  likesWrites = operation.then(() => {}, () => {});
  return operation;
}

function queuePlaylistWrite(write: () => Promise<PersistedState>): Promise<PersistedState> {
  playlistsPending += 1;
  playlistsEpoch += 1;
  const operation = playlistsWrites.then(async () => {
    const next = await write();
    applyPlaylists(next.playlists ?? []);
    return next;
  }).finally(() => {
    playlistsPending -= 1;
    playlistsEpoch += 1;
    refreshAfterWrites();
  });
  playlistsWrites = operation.then(() => {}, () => {});
  return operation;
}

/** Ids whose colour has been requested but not resolved yet. */
const coloursInFlight = new Set<string>();
const colourQueue: string[] = [];
let drainingColours = false;

export type ArtworkTier = "now" | "queue" | "background" | "prefetch" | "idle";
type ArtworkWorkTier = ArtworkTier | "priority";

const TIER_PRIORITY: Record<ArtworkTier, number> = { now: 0, queue: 1, background: 2, prefetch: 3, idle: 4 };
const TIER_CONCURRENCY: Record<ArtworkTier, number> = { now: 1, queue: 7, background: 2, prefetch: 2, idle: 0 };
const PHONE_ARTWORK_READS = 3;
const PHONE_ARTWORK_URLS = 64;
/** Track id -> object URL for its artwork. */
const artworkUrls = new Map<string, string>();
const artworkPending = new Map<string, ArtworkTier>();
const artworkInFlight = new Set<string>();
const artworkRunning: Record<ArtworkTier, number> = { now: 0, queue: 0, background: 0, prefetch: 0, idle: 0 };
let artworkPriority = new Set<string>();
let artworkPriorityNeedsRender = false;
/** Tracks whose artwork could not be read; not retried this session. */
const artworkFailed = new Set<string>();

let emitScheduled = false;

/** The filter chain every element the engine makes is fed through. */
const eq = new EqChain(isAndroidPlatform ? { latencyHint: "playback" } : undefined);

/** The chain itself, so the overlay can read the curve and the spectrum. */
export const eqChain = eq;

let corsRetryTrack: string | null = null;

const engine = new AudioEngine({
  onBeforeLoad: () => {
    if (corsRetryTrack !== null && corsRetryTrack !== player.currentId) {
      corsRetryTrack = null;
      engine.enableCors();
    }
  },
  onEnded: () => {
    noteTrackEnded();
    player.handleEnded();
  },
  onLoaded: () => {
    if (corsRetryTrack !== null && engine.element.readyState >= HTMLMediaElement.HAVE_METADATA) {
      corsRetryTrack = null;
      eq.block("cors");
      if (state.settings.eqEnabled) {
        setNotice("This system will not let Wave read the audio, so the equaliser is off.");
      } else {
        emit();
      }
    }
    player.handleLoaded();
  },
  onPlaying: () => player.handlePlaying(),
  onPause: () => player.handlePaused(),
  onError: () => {
    if (corsRetryTrack !== null) {
      corsRetryTrack = null;
      engine.enableCors();
    }
    const title = currentTrack()?.title;
    setNotice(title ? `Could not play "${title}".` : "That song could not be played.");
    notePlaybackError();
    player.handleError();
  },
  onCorsRefused: handleCorsRefused,
  onBuffering: (durationMs, element) => {
    console.warn(`Audio buffering lasted ${Math.round(durationMs)}ms. ` +
      `Ready ${element.readyState}, network ${element.networkState}, hidden ${document.hidden}.`);
  },
  onElement: (element, phase) => {
    if (phase === "created") {
      eq.attach(element);
    } else {
      eq.detach(element);
    }
  },
});

let audioStreamBase: string | null = null;

function audioPath(track: Track): string {
  return trackAudioPath(track.path, track.id, audioStreamBase);
}

export function previewAudioPath(track: Track): string {
  return audioPath(track);
}

export function previewStagedAudioPath(path: string): string {
  const id = /(?:^|[\\/])\.song-editor-([0-9a-f-]+)\.[^.]+$/i.exec(path)?.[1];
  return audioStreamBase && id ? `${audioStreamBase}/editor-${id}` : path;
}

/**
 * A file that will not be handed to Web Audio is loaded again without it, so
 * the equaliser steps aside rather than costing plain playback.
 */
function handleCorsRefused(): void {
  engine.disableCors();
  corsRetryTrack = player.currentId;
  player.reloadCurrent();
}

export const player = new Player(engine, (trackId) => {
  const track = state.tracksById.get(trackId);
  return track
    ? { path: audioPath(track), durationMs: track.durationMs, gain: trackGain(track) }
    : undefined;
});

mountAudioWatchdog(engine, player, (message) => {
  console.warn(message);
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

export function connectPreviewAudio(
  element: HTMLAudioElement, trackId: string, originalAudio: () => boolean,
): () => void {
  const routed = element.crossOrigin === "anonymous";
  if (routed) eq.attach(element);
  const sync = (): void => {
    const track = state.tracksById.get(trackId);
    const gain = originalAudio() && track ? trackGain(track) : 1;
    element.volume = Math.min(Math.max(player.levelForGain(gain), 0), 1);
  };
  const resume = (): void => eq.resume();
  const unsubscribePlayer = player.onChange(sync);
  const unsubscribeState = subscribe(sync);
  element.addEventListener("play", resume);
  sync();
  return () => {
    element.removeEventListener("play", resume);
    unsubscribePlayer();
    unsubscribeState();
    if (routed) eq.detach(element);
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
    if (isAndroidPlatform) {
      artworkUrls.delete(track.id);
      artworkUrls.set(track.id, cached);
    }
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
    const wanted = artworkPriority.has(id) ||
      (tier === "queue" ? window.has(id) : tier === "prefetch" ? queue.has(id) : true);
    if (!wanted) {
      artworkPending.delete(id);
    }
  }
}

export function prioritizeNearbyArtwork(order: readonly string[], cursor: number, looping: boolean): void {
  artworkPriority = new Set(nearbyArtwork(order, cursor, looping));
  let waiting = false;
  for (const id of artworkPriority) {
    const track = state.tracksById.get(id);
    if (!track?.artworkPath || artworkUrls.has(id) || artworkFailed.has(id)) {
      continue;
    }
    waiting = true;
    if (!artworkInFlight.has(id) && !artworkPending.has(id)) {
      artworkPending.set(id, "queue");
    }
  }
  if (waiting) {
    artworkPriorityNeedsRender = true;
  } else if (artworkPriority.size === 0) {
    artworkPriorityNeedsRender = false;
  } else if (artworkPriorityNeedsRender) {
    scheduleEmit();
  }
  pumpArtwork();
}

export function mayRevealArtwork(trackId: string): boolean {
  return !artworkPriorityNeedsRender || (artworkPriority.has(trackId) && !priorityArtworkPending());
}

function priorityArtworkPending(): boolean {
  for (const id of artworkPriority) {
    if (artworkPending.has(id) || artworkInFlight.has(id)) {
      return true;
    }
  }
  return false;
}

export function prefetchArtwork(trackIds: readonly string[]): void {
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

export function whenArtworkReady(): Promise<void> {
  const snapshot = player.snapshot();
  const phone = device() !== "desktop";
  const ids = phone
    ? nearbyArtwork(snapshot.order, snapshot.cursor, snapshot.repeat !== "off")
    : snapshot.currentId ? [snapshot.currentId] : [];
  if (phone) {
    prioritizeNearbyArtwork(snapshot.order, snapshot.cursor, snapshot.repeat !== "off");
  } else {
    const track = currentTrack();
    if (track) artworkUrlFor(track, "now");
  }

  const ready = (): boolean => ids.every((id) => {
    const track = state.tracksById.get(id);
    return !track?.artworkPath || artworkUrls.has(id) || artworkFailed.has(id);
  });
  if (ready()) {
    emit();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let timer = 0;
    let unsubscribe = (): void => {};
    let settled = false;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      unsubscribe();
      emit();
      resolve();
    };

    unsubscribe = subscribe(() => {
      if (ready()) {
        finish();
      }
    });
    timer = window.setTimeout(finish, phone ? 8000 : 1200);

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

function trimArtwork(): void {
  if (!isAndroidPlatform) {
    return;
  }
  for (const [id, url] of artworkUrls) {
    if (artworkUrls.size <= PHONE_ARTWORK_URLS) {
      break;
    }
    if (artworkPriority.has(id) || id === player.currentId) {
      continue;
    }
    artworkUrls.delete(id);
    URL.revokeObjectURL(url);
  }
}

/** Starts as many pending reads as the per-tier limits allow, best tier first. */
function pumpArtwork(): void {
  for (const id of artworkPriority) {
    if (isAndroidPlatform && artworkInFlight.size >= PHONE_ARTWORK_READS) {
      break;
    }
    if (artworkPending.has(id)) {
      artworkPending.delete(id);
      startArtwork(id, "priority");
    }
  }

  if (artworkPriorityNeedsRender || priorityArtworkPending()) {
    return;
  }

  for (;;) {
    if (isAndroidPlatform && artworkInFlight.size >= PHONE_ARTWORK_READS) {
      return;
    }
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

function startArtwork(trackId: string, tier: ArtworkWorkTier): void {
  const path = state.tracksById.get(trackId)?.artworkPath;
  if (!path) {
    if (artworkPriority.has(trackId)) {
      scheduleEmit();
    }
    return;
  }

  artworkInFlight.add(trackId);
  if (tier !== "priority") {
    artworkRunning[tier] += 1;
  }

  void ipc
    .artworkBytes(path)
    .then(async (buffer) => {
      if (state.tracksById.get(trackId)?.artworkPath !== path) {
        return;
      }
      const url = URL.createObjectURL(new Blob([buffer], { type: imageMime(path, buffer) }));
      try {
        if (isAndroidPlatform || device() !== "desktop") {
          await decodeArtwork(url);
        }
      } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
      }
      if (state.tracksById.get(trackId)?.artworkPath !== path) {
        URL.revokeObjectURL(url);
        return;
      }
      artworkUrls.set(trackId, url);
      trimArtwork();
      if (artworkPriority.has(trackId)) {
        artworkPriorityNeedsRender = true;
      }
      scheduleEmit();
    })
    .catch(() => {
      if (state.tracksById.get(trackId)?.artworkPath !== path) {
        return;
      }
      // Recorded so a failed read is not retried on every re-render.
      artworkFailed.add(trackId);
      if (artworkPriority.has(trackId)) {
        artworkPriorityNeedsRender = true;
        scheduleEmit();
      }
    })
    .finally(() => {
      artworkInFlight.delete(trackId);
      if (tier !== "priority") {
        artworkRunning[tier] -= 1;
      }
      if (state.tracksById.get(trackId)?.artworkPath !== path && state.tracksById.has(trackId)) {
        artworkPending.set(trackId, tier === "priority" ? "now" : tier);
      }
      pumpArtwork();
    });
}

function decodeArtwork(url: string): Promise<void> {
  const image = new Image();
  if (typeof image.decode === "function") {
    image.src = url;
    return image.decode();
  }
  return new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Could not decode artwork"));
    image.src = url;
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

function imageMime(path: string, buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
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
      if (state.tracksById.get(id)?.artworkPath === track.artworkPath) {
        state.colours.set(id, hex);
      }
    } catch {
      // Session-only fallback; the failure is not persisted, so a later launch retries.
      if (state.tracksById.get(id)?.artworkPath === track.artworkPath) {
        state.colours.set(id, FALLBACK_COLOUR);
      }
    }
    coloursInFlight.delete(id);
    const current = state.tracksById.get(id);
    if (current && current.artworkPath !== track.artworkPath) {
      ensureColour(current);
    }
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
    if (artworkPriorityNeedsRender && !priorityArtworkPending()) {
      artworkPriorityNeedsRender = false;
      pumpArtwork();
      scheduleEmit();
    }
  }, 150);
}

export async function init(): Promise<string | null> {
  watchSettings();
  watchSources();
  watchLoudness();
  watchUpdate();
  watchExternalChanges();
  wireEq();
  mountAnalytics({
    player,
    trackById,
    collectionById,
    enabled: () => state.settings.analyticsEnabled,
  });
  await readAppVersion();
  let startupError: string | null = null;
  try {
    if (isAndroidPlatform || isWebKitGtk) {
      try {
        audioStreamBase = await ipc.audioStreamBase();
      } catch (error) {
        setNotice(`Could not start audio streaming: ${describe(error)}`);
      }
    }
    const persisted = await ipc.loadState();
    const recovery = phoneRecoveryStorage();
    const session = newestSession(persisted.session, recovery ? readSessionRecovery(recovery) : null);
    lastSessionSavedAt = Math.max(persisted.session?.savedAt ?? 0, session?.savedAt ?? 0);
    applyPersisted(persisted, true, true, true);
    seedEqOrigin();
    applySession(session);
    player.setVolume(state.settings.volume);
    const deferQueueRepair = state.settings.resumeOnLaunch &&
      (session?.playback?.order.length ?? 0) > 0;
    await rescan(false, deferQueueRepair);
    if (state.settings.resumeOnLaunch) {
      const playback = session?.playback;
      const currentId = playback?.order[playback.cursor];
      const incomplete = playback && state.scanErrors.length > 0 &&
        [...playback.order, ...playback.sourceOrder].some((id) => !state.tracksById.has(id));
      if (incomplete) {
        if (currentId && state.tracksById.has(currentId)) {
          restorePlayback(playback);
        }
        pendingPlayback = playback;
        pendingQueueRevision = player.snapshot().queueRevision;
      } else {
        restorePlayback(playback);
      }
    }
    if (deferQueueRepair && !player.currentId && !pendingPlayback) {
      repairQueue();
    }
    wirePersistence();
    state.ready = true;
  } catch (error) {
    startupError = describe(error);
    state.notice = startupError;
    state.ready = true;
  }
  if (!isAndroidPlatform) {
    void refreshDeezerStatus();
    void refreshYoutubeStatus();
  }
  void refreshRecommendStatus();
  void loadPlayCounts();
  void startUpdater();
  emit();
  return startupError ?? state.scanErrors[0] ?? null;
}

/** The version the binary reports, which is what a release is compared against. */
async function readAppVersion(): Promise<void> {
  try {
    state.appVersion = await getVersion();
  } catch {
    // Not running inside Tauri, for example `npm run dev` in a browser.
  }
}

async function readLibraryInfo(): Promise<void> {
  try {
    state.libraryInfo = await ipc.libraryInfo();
  } catch {
    state.libraryInfo = null;
  }
}

let scanSequence = 0;
let loudnessDuringScan: Map<string, { lufs: number; peak: number }> | null = null;

export async function rescan(forceFull = false, deferQueueRepair = false): Promise<void> {
  const sequence = ++scanSequence;
  loudnessDuringScan = new Map();
  state.scanning = true;
  emit();

  try {
    const known = state.libraryInfo?.tracks;
    const full =
      forceFull || state.tracksById.size === 0 || (known !== undefined && state.tracksById.size !== known);
    const summary = await ipc.scanLibrary(full);
    if (sequence !== scanSequence) {
      return;
    }
    for (const track of summary.changed) {
      const reading = loudnessDuringScan?.get(track.id);
      if (reading) {
        track.lufs = reading.lufs;
        track.peak = reading.peak;
      }
    }
    loudnessDuringScan = null;
    await applyScan(summary, full, sequence, deferQueueRepair);
  } catch (error) {
    if (sequence === scanSequence) {
      state.scanErrors = [describe(error)];
    }
  }

  if (sequence !== scanSequence) {
    return;
  }
  loudnessDuringScan = null;
  state.scanning = false;
  emit();

  if (!isAndroidPlatform) {
    void analyseLoudness();
  }
}

/**
 * Applies a scan's summary, whether the window ran the scan or the local API
 * did. Shared so the two paths can never drift apart.
 */
async function applyScan(
  summary: ScanSummary,
  full = false,
  sequence?: number,
  deferQueueRepair = false,
): Promise<void> {
  // Only what moved is merged in, so a scan that changed nothing does not have
  // to rebuild the whole listing.
  if (full || summary.changed.length > 0 || summary.removed.length > 0) {
    const byId = full && summary.errors.length === 0 ? new Map<string, Track>() : new Map(state.tracksById);
    for (const id of summary.removed) {
      byId.delete(id);
    }
    for (const track of summary.changed) {
      byId.set(track.id, track);
    }

    state.tracksById = byId;
    state.tracks = [...byId.values()].sort((left, right) =>
      left.title.toLowerCase().localeCompare(right.title.toLowerCase()),
    );
  }

  artworkFailed.clear();
  retainArtwork();
  state.root = summary.root;
  state.skipped = summary.skipped;
  state.scanErrors = summary.errors;
  await readLibraryInfo();
  if (sequence !== undefined && sequence !== scanSequence) {
    return;
  }
  refreshCollections();
  if (pendingPlayback && summary.errors.length === 0) {
    const snapshot = player.snapshot();
    const playback = currentSession().playback;
    pendingPlayback = undefined;
    pendingQueueRevision = null;
    restorePlayback(playback);
    if (snapshot.playing && snapshot.currentId === player.currentId) {
      player.play();
    }
  }
  if (!deferQueueRepair && !pendingPlayback) {
    repairQueue();
  }
  if (summary.changed.length > 0) {
    rememberTracks(summary.changed);
  }
  const token = persistedReadToken();
  const persisted = await ipc.loadState();
  if (sequence !== undefined && sequence !== scanSequence) {
    return;
  }
  applyReadState(persisted, token);
  if (!pendingPlayback) {
    adoptSource();
  }
}

/** Rescans, then fills in the genre of any song that has none. */
export async function rescanLibrary(): Promise<void> {
  await rescan();
  await backfillGenres();
}

export async function rereadTags(): Promise<void> {
  setNotice("Reading the tags again...");
  try {
    await applyScan(await ipc.rereadTags());
    setNotice(`${plural(state.tracks.length, "song")} read again.`);
  } catch (error) {
    setNotice(describe(error));
  }
}

export async function fixTagsAndCovers(): Promise<void> {
  await rereadTags();

  const ids = state.tracks.map((track) => track.id);
  if (ids.length === 0) {
    setNotice("There is nothing in the library to fix.");
    return;
  }

  const parts = [await fillCovers(ids), await fillGenres(ids)];
  setNotice(parts.filter(Boolean).join(", ") || "Nothing needed fixing.");
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
      await ipc.analyseLoudness([]);
    } while (loudnessAgain);
  } catch {
    // A song with no reading simply plays at its own level.
  } finally {
    loudnessRunning = false;
    state.analysing = null;
    emit();
  }
}

async function completeImport(outcome: ImportOutcome): Promise<string> {
  const ids = outcome.trackIds;
  if (ids.length === 0) {
    return "";
  }

  setNotice(`Looking up ${plural(ids.length, "song")}...`);
  const parts = [await fillCovers(ids), await fillGenres(ids)];
  return parts.filter(Boolean).join(", ");
}

/** The one-line summary both import paths finish with. */
function importSummary(outcome: ImportOutcome, waitingForAudio = false): string {
  const parts = [`${plural(outcome.songs, "song")} imported`];
  if (outcome.duplicates > 0) {
    parts.push(waitingForAudio
      ? `${plural(outcome.duplicates, "song")} already in your library`
      : `${plural(outcome.duplicates, "duplicate")} skipped`);
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
  if (waitingForAudio && outcome.skipped > 0) {
    parts.push(`${plural(outcome.skipped, "song")} waiting for audio`);
  }
  if (outcome.errors.length > 0) {
    parts.push(`${outcome.errors.length} failed`);
  }
  return parts.join(", ");
}

function importNotice(outcome: ImportOutcome, found = ""): string {
  const message = [importSummary(outcome), found].filter(Boolean).join(", ");
  const failure = outcome.errors.find((error) => error.includes("playlists could not be refreshed:")) ??
    outcome.errors[0];
  return `${message}${failure ? `. ${failure}` : ""}`;
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
    await rescan(true);
    const found = await completeImport(outcome);
    setNotice(importNotice(outcome, found));
  } catch (error) {
    setNotice(describe(error));
  }
}

/** Imports the files a picker handed back. On Android those are content URIs. */
export async function importPickedFiles(): Promise<void> {
  try {
    const paths = await (isAndroidPlatform ? ipc.pickPhoneAudioFiles() : ipc.pickAudioFiles());
    if (!paths || paths.length === 0) {
      return;
    }

    setNotice("Importing...");
    const outcome = await ipc.importPickedFiles(paths);
    applyPersisted(outcome.state);
    await rescan(true);
    const found = await completeImport(outcome);
    setNotice(importNotice(outcome, found));
  } catch (error) {
    setNotice(describe(error));
  }
}

export async function importPhoneFolder(): Promise<void> {
  if (state.folderImport !== null) {
    return;
  }
  state.folderImport = "Choose a music folder to import...";
  setNotice(null);
  try {
    const outcome = await ipc.importPhoneFolder();
    if (!outcome) {
      return;
    }
    applyPersisted(outcome.state);
    await rescan(true);
    setNotice(importNotice(outcome));
  } catch (error) {
    setNotice(describe(error));
  } finally {
    state.folderImport = null;
    emit();
  }
}

/** Imports what the phone's own music folders hold. */
export async function importPhoneMusic(): Promise<void> {
  try {
    setNotice("Looking through your music folders...");
    const outcome = await ipc.scanPhoneMusic();
    applyPersisted(outcome.state);
    await rescan(true);
    const found = await completeImport(outcome);
    setNotice(importNotice(outcome, found));
  } catch (error) {
    setNotice(describe(error));
  }
}

let transferPending = false;

export async function importWaveList(choose: () => Promise<boolean | null>): Promise<void> {
  if (transferPending || jobRunning(state.transferProgress)) {
    return;
  }
  transferPending = true;
  try {
    const path = await ipc.pickWaveList();
    if (!path) {
      return;
    }
    const createPlaylist = await choose();
    if (createPlaylist === null) {
      return;
    }
    state.transferProgress = {
      phase: "resolving", done: 0, total: 0, label: "",
      message: "Reading the Wave playlist...", failures: [], reused: 0,
      startedAt: Date.now(),
    };
    emit();
    const outcome = await ipc.importWaveList(path, createPlaylist);
    applyPersisted(outcome.state);
    await rescan();
    const message = importSummary(outcome, isAndroidPlatform);
    setNotice(message);
    state.transferProgress = {
      phase: outcome.errors.length ? "failed" : "done",
      done: state.transferProgress?.done ?? 0,
      total: state.transferProgress?.total ?? 0,
      label: "", message, failures: outcome.errors,
      reused: state.transferProgress?.reused ?? 0,
      startedAt: state.transferProgress?.startedAt ?? Date.now(),
    };
    if (isAndroidPlatform && outcome.playlistId && outcome.skipped > 0) {
      void downloadPending(outcome.playlistId, []);
    }
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
  if (!collection || !collection.entries.length || exporting) {
    return;
  }
  exporting = true;
  try {
    const playlistId = collection.kind === "playlist" || collection.kind === "generated" ? collection.id : null;
    const count = await ipc.exportWaveList(collection.name, collection.entries, playlistId);
    if (count !== null) {
      setNotice(`Exported ${plural(count, "song")} to a Wave playlist.`);
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
      deno: false,
      denoSource: "",
      message: describe(error),
    };
  }

  state.spotifyChecking = false;
  emit();
}

/** Re-reads the config and reports what Deezer needs: the download tools. */
export async function refreshDeezerStatus(): Promise<void> {
  state.deezerChecking = true;
  emit();

  try {
    state.deezer = await ipc.deezerStatus();
  } catch (error) {
    state.deezer = {
      envPath: "",
      ytDlp: false,
      ytDlpSource: "",
      ffmpeg: false,
      deno: false,
      denoSource: "",
      message: describe(error),
    };
  }

  state.deezerChecking = false;
  emit();
}

/** Re-reads the config and reports what a pasted link needs. */
export async function refreshYoutubeStatus(): Promise<void> {
  state.youtubeChecking = true;
  emit();

  try {
    state.youtube = await ipc.youtubeStatus();
  } catch (error) {
    state.youtube = {
      envPath: "",
      ytDlp: false,
      ytDlpSource: "",
      ffmpeg: false,
      deno: false,
      denoSource: "",
      message: describe(error),
    };
  }

  state.youtubeChecking = false;
  emit();
}

export type LinkService = "spotify" | "deezer" | "youtube";

export function serviceOf(link: string): LinkService {
  const value = link.trim().toLowerCase();
  if (value.includes("deezer.") || value.startsWith("deezer:")) {
    return "deezer";
  }
  if (value.includes("youtube.") || value.includes("youtu.be")) {
    return "youtube";
  }
  return "spotify";
}

/** A background job is only in the way while it is actually running. */
export function jobRunning(progress: ImportProgress | null): boolean {
  return progress !== null && progress.phase !== "done" && progress.phase !== "failed";
}

/** The one-line summary a finished covers fetch leaves behind. */
function coversSummary(outcome: CoversOutcome): string {
  const parts = [`${outcome.restored} restored`];
  if (outcome.tagged > 0) {
    parts.push(`${outcome.tagged} given tags`);
  }
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
  if (collection) {
    await fillCovers(collection.trackIds);
  }
}

/** Restores missing cover art for a set of songs, and answers with its summary. */
async function fillCovers(trackIds: string[]): Promise<string> {
  if (trackIds.length === 0 || jobRunning(state.coversProgress)) {
    return "";
  }

  state.coversProgress = {
    phase: "covers",
    done: 0,
    total: trackIds.length,
    label: "",
    message: "Starting...",
    failures: [],
    reused: 0,
    startedAt: Date.now(),
  };
  emit();

  let message = "";
  try {
    const outcome = await ipc.fetchCovers(trackIds);
    await rescan(true);

    message = coversSummary(outcome);
    setNotice(message);
    state.coversProgress = {
      phase: "done",
      done: trackIds.length,
      total: trackIds.length,
      label: "",
      message,
      failures: outcome.errors,
      reused: 0,
      startedAt: Date.now(),
    };
  } catch (error) {
    message = describe(error);
    setNotice(message);
    state.coversProgress = failedProgress(message);
    message = "";
  }
  return message;
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
  if (collection) {
    await fillGenres(collection.trackIds);
  }
}

/** Writes the genre of a set of songs into their files, and answers with a summary. */
async function fillGenres(trackIds: string[]): Promise<string> {
  if (trackIds.length === 0 || jobRunning(state.genresProgress)) {
    return "";
  }

  state.genresProgress = {
    phase: "genres",
    done: 0,
    total: trackIds.length,
    label: "",
    message: "Starting...",
    failures: [],
    reused: 0,
    startedAt: Date.now(),
  };
  emit();

  let message = "";
  try {
    const outcome = await ipc.fetchGenres(trackIds);
    await rescan(true);

    message = genresSummary(outcome);
    setNotice(message);
    // Only what the pass got through, so a pass that stopped early says so.
    const handled = Math.max(trackIds.length - outcome.remaining, 0);
    state.genresProgress = {
      phase: "done",
      done: handled,
      total: trackIds.length,
      label: "",
      message,
      failures: outcome.errors,
      reused: 0,
      startedAt: Date.now(),
    };
  } catch (error) {
    message = describe(error);
    setNotice(message);
    state.genresProgress = failedProgress(message);
    message = "";
  }
  emit();
  return message;
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
    startedAt: Date.now(),
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
      startedAt: Date.now(),
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

/** Opens the log every download writes, so a failed one can be read back. */
export async function openImportLog(): Promise<void> {
  try {
    await ipc.openImportLog();
  } catch (error) {
    setNotice(describe(error));
  }
}

/** Where that log lives. Empty when it cannot be placed. */
export async function importLogPath(): Promise<string> {
  try {
    return await ipc.importLogPath();
  } catch {
    return "";
  }
}

function finishedProgress(
  phase: "done" | "failed",
  message: string,
  failures: string[] = [],
): ImportProgress {
  return {
    phase,
    done: 0,
    total: 0,
    label: "",
    message,
    failures,
    reused: 0,
    startedAt: Date.now(),
  };
}

/** A failure that stays on screen, rather than a notice that times out. */
function failedProgress(message: string, failures: string[] = []): ImportProgress {
  return finishedProgress("failed", message, failures);
}

export async function planLink(url: string): Promise<ImportPlan | null> {
  const link = url.trim();
  if (!link || jobRunning(state.importing)) {
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
    startedAt: Date.now(),
  };
  emit();

  try {
    const service = isAndroidPlatform || device() === "android" ? "youtube" : serviceOf(link);
    const plan =
      service === "spotify"
        ? await ipc.spotifyPlan(link)
        : service === "deezer"
          ? await ipc.deezerPlan(link)
          : await ipc.youtubePlan(link);
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

/** Downloads a playlist, album or track from a Spotify, Deezer or YouTube link. */
export async function importLink(url: string, downloadDuplicates: boolean): Promise<void> {
  const link = url.trim();
  if (!link || jobRunning(state.importing)) {
    return;
  }

  // The backend sends its own updates from here; this is the first paint.
  state.importing = {
    phase: "resolving",
    done: 0,
    total: 0,
    label: "",
    message: "Starting...",
    failures: [],
    reused: 0,
    startedAt: Date.now(),
  };
  emit();

  try {
    const service = isAndroidPlatform || device() === "android" ? "youtube" : serviceOf(link);
    const outcome =
      service === "spotify"
        ? await ipc.importSpotify(link, downloadDuplicates)
        : service === "deezer"
          ? await ipc.importDeezer(link, downloadDuplicates)
          : await ipc.importYoutube(link, downloadDuplicates);
    applyPersisted(outcome.state);
    await rescan();
    const message = importSummary(outcome);
    setNotice(message);
    state.importing =
      outcome.errors.length > 0
        ? failedProgress(
            `${plural(outcome.songs, "song")} imported, ${outcome.errors.length} failed.`,
            outcome.errors,
          )
        : outcome.songs === 0
          ? finishedProgress("done", message)
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

/** Set while the play counts are being read, so a second read waits its turn. */
let countsReading = false;
let countsRequest = 0;

/** Reads how often each song has been streamed, for the orders that need it. */
async function loadPlayCounts(force = false): Promise<void> {
  if (countsReading && !force) {
    return;
  }
  countsReading = true;
  const request = ++countsRequest;

  try {
    const counts = await ipc.analyticsPlayCounts();
    if (request === countsRequest) {
      state.playCounts = new Map(Object.entries(counts));
      emit();
    }
  } catch {
    // Left as it stands; every song simply counts as unplayed.
  } finally {
    if (request === countsRequest) countsReading = false;
  }
}

export function setSort(sort: CollectionSort): void {
  state.sort = sort;
  if (sort === "plays") {
    // The counts move as songs are listened to, so they are read again here.
    void loadPlayCounts();
  }
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

  player.setQueue(collection.id, collection.name, queueOrder(collection), startTrackId);
  state.recents = [id, ...state.recents.filter((entry) => entry !== id)].slice(0, 3);
  schedulePersist();
  emit();
}

/** The order a collection's songs are queued in. */
function queueOrder(collection: Collection): string[] {
  return collection.kind === "album" && !isUnknownCollection(collection)
    ? sortAlbumTracks(collection.trackIds, state.tracksById)
    : collection.trackIds;
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
    await queueLikesWrite(() => ipc.toggleLike(trackId));
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
    await queueLikesWrite(() => ipc.setLikes(trackIds, liked));
    recordEvent(liked ? "like" : "unlike", { trackIds });
    emit();
  } catch (error) {
    setNotice(describe(error));
  }
}

export async function createPlaylist(name: string): Promise<void> {
  try {
    await queuePlaylistWrite(() => ipc.createPlaylist(name));
    emit();
  } catch (error) {
    setNotice(describe(error));
  }
}

export async function createPlaylistWithTracks(name: string, trackIds: string[]): Promise<void> {
  try {
    await queuePlaylistWrite(async () => {
      const before = new Set(state.playlists.map((playlist) => playlist.id));
      const next = await ipc.createPlaylist(name);
      const created = next.playlists.find((playlist) => !before.has(playlist.id));
      if (created && trackIds.length > 0) {
        try {
          const added = await ipc.addToPlaylist(created.id, trackIds);
          recordEvent("playlist_add", { trackIds, playlistId: created.id, value: created.name });
          return added;
        } catch (error) {
          applyPlaylists(next.playlists);
          throw error;
        }
      }
      return next;
    });
    emit();
  } catch (error) {
    setNotice(describe(error));
  }
}

export async function renamePlaylist(id: string, name: string): Promise<void> {
  try {
    await queuePlaylistWrite(() => ipc.renamePlaylist(id, name));
    emit();
  } catch (error) {
    setNotice(describe(error));
  }
}

export async function deletePlaylist(id: string): Promise<void> {
  const name = state.playlists.find((playlist) => playlist.id === id)?.name ?? null;
  try {
    await queuePlaylistWrite(() => ipc.deletePlaylist(id));
    recordEvent("playlist_remove", { playlistId: id, value: name });
    state.recents = state.recents.filter((entry) => entry !== id);
    emit();
  } catch (error) {
    setNotice(describe(error));
  }
}

function removeDeletedTracks(trackIds: string[]): void {
  scanSequence += 1;
  const removed = new Set(trackIds);
  likesEpoch += 1;
  applyLikes([...state.likes].filter((id) => !removed.has(id)));
  state.tracks = state.tracks.filter((track) => !removed.has(track.id));
  state.tracksById = new Map(state.tracks.map((track) => [track.id, track]));
  retainArtwork();
  refreshCollections();
  for (const id of trackIds) {
    player.removeFromQueue(id);
  }
  emit();
}

export async function deleteTracks(trackIds: string[]): Promise<void> {
  if (trackIds.length === 0) {
    return;
  }

  const title = trackIds.length === 1 ? state.tracksById.get(trackIds[0])?.title : undefined;

  try {
    await queuePlaylistWrite(() => queueLikesWrite(() => ipc.deleteTracks(trackIds)));
    removeDeletedTracks(trackIds);
    await rescan();
    setNotice(title ? `Deleted "${title}".` : `${plural(trackIds.length, "song")} deleted.`);
  } catch (error) {
    const message = describe(error);
    if (message.startsWith("The changes were saved, but the playlists could not be refreshed:")) {
      removeDeletedTracks(trackIds);
    }
    const before = [...state.tracksById.keys()];
    await rescan(true);
    for (const id of before) {
      if (!state.tracksById.has(id)) {
        player.removeFromQueue(id);
      }
    }
    const scanFailure = state.scanErrors[0];
    setNotice(scanFailure ? `${message} Library rescan: ${scanFailure}` : message);
  }
}

export async function editTrack(trackId: string, metadata: TrackMetadata): Promise<void> {
  const before = state.tracksById.get(trackId);
  const track = await ipc.editTrack(trackId, metadata);
  scanSequence += 1;
  state.tracksById = new Map(state.tracksById).set(track.id, track);
  state.tracks = [...state.tracksById.values()].sort((left, right) =>
    left.title.toLowerCase().localeCompare(right.title.toLowerCase()),
  );
  refreshCollections();
  rememberTracks([track]);
  const fields: (keyof TrackMetadata)[] = [
    "title", "artist", "album", "albumArtist", "genre", "year", "trackNo", "discNo",
  ];
  if (
    before && player.currentId === trackId && engine.hasFile &&
    fields.some((field) => before[field] !== track[field])
  ) {
    player.reloadCurrent();
  }
  emit();
  await rescan();
  setNotice(`Updated "${track.title}".`);
}

export async function saveEditedSong(
  trackId: string,
  expectedPath: string,
  expectedLyrics: string | null,
  lyrics: string | null,
  stagedAudio: string | null,
  cuts: AudioCut[],
): Promise<void> {
  const track = await ipc.saveSongEdit(trackId, expectedPath, expectedLyrics, lyrics, stagedAudio, cuts);
  scanSequence += 1;
  state.tracksById = new Map(state.tracksById).set(track.id, track);
  state.tracks = state.tracks.map((entry) => entry.id === track.id ? track : entry);
  refreshCollections();
  rememberTracks([track]);
  if (player.currentId === trackId && track.path !== expectedPath) {
    player.refreshCurrentSource();
    player.finishTransitions();
  }
  if (state.lyricsTrackId === trackId) {
    state.lyricsTrackId = null;
    void ensureLyrics(track);
  }
  emit();
  if (track.path !== expectedPath) {
    try {
      await ipc.cleanupEditedAudio(trackId, expectedPath);
    } catch {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
      try {
        await ipc.cleanupEditedAudio(trackId, expectedPath);
      } catch {
        setNotice("Saved, but the old library copy could not be removed. The original is also in audio-backups.");
        return;
      }
    }
  }
  setNotice(`Audio and lyrics saved for "${track.title}".`);
}

export async function replaceTrackCover(trackId: string): Promise<void> {
  try {
    const path = await ipc.pickCover();
    if (!path) {
      return;
    }
    const track = await ipc.replaceCover(trackId, path);
    scanSequence += 1;
    state.tracksById = new Map(state.tracksById).set(track.id, track);
    state.tracks = state.tracks.map((entry) => entry.id === track.id ? track : entry);
    const oldUrl = artworkUrls.get(track.id);
    if (oldUrl) {
      URL.revokeObjectURL(oldUrl);
      artworkUrls.delete(track.id);
    }
    artworkFailed.delete(track.id);
    state.colours.delete(track.id);
    refreshCollections();
    ensureColour(track);
    emit();
    await rescan();
    setNotice(`Cover updated for "${track.title}".`);
  } catch (error) {
    setNotice(describe(error));
  }
}

export async function addTracksToPlaylist(id: string, trackIds: string[]): Promise<void> {
  try {
    await queuePlaylistWrite(() => ipc.addToPlaylist(id, trackIds));
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
    await queuePlaylistWrite(() => ipc.removeFromPlaylist(id, trackIds));
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
    await queuePlaylistWrite(() => ipc.reorderPlaylist(id, trackIds));
    emit();
  } catch (error) {
    setNotice(describe(error));
  }
}

/** Reads whether the listening record holds enough to generate a playlist from. */
export async function refreshRecommendStatus(): Promise<void> {
  try {
    state.recommend = await ipc.recommendStatus();
    emit();
  } catch {
    // Left as it stands; the sheet only reads it to name the reason.
  }
}

/** Fills a new playlist from the catalogue, by taste or by one genre. */
export async function generatePlaylist(mode: PlaylistMode, genre: string | null): Promise<void> {
  if (jobRunning(state.generateProgress)) {
    return;
  }

  // The backend sends its own phases from here; this is the first paint.
  state.generateProgress = {
    phase: mode === "taste" ? "taste" : "catalogue",
    done: 0,
    total: 0,
    label: "",
    message: "Starting...",
    failures: [],
    reused: 0,
    startedAt: Date.now(),
  };
  emit();

  try {
    const outcome = await ipc.generatePlaylist(mode, genre);
    applyPersisted(outcome.state);
    await refreshPersistedState();
    const playlist = outcome.state.playlists.find((entry) => entry.id === outcome.playlistId);
    setNotice(
      playlist
        ? `Created "${playlist.name}" with ${plural(playlist.entries.length, "song")}.`
        : "Playlist created.",
    );
    state.generateProgress = null;
  } catch (error) {
    const message = describe(error);
    setNotice(message);
    state.generateProgress = failedProgress(message);
  }
  emit();
}

/** Set while the source-import event is reporting a playlist download. */
let downloading = false;

/** The one-line summary a finished playlist download leaves behind. */
function downloadSummary(outcome: ImportOutcome): string {
  const parts = [`${plural(outcome.songs, "song")} downloaded`];
  if (outcome.duplicates > 0) {
    parts.push(`${plural(outcome.duplicates, "duplicate")} skipped`);
  }
  if (outcome.errors.length > 0) {
    parts.push(`${outcome.errors.length} failed`);
  }
  return parts.join(", ");
}

/** Fetches a generated playlist's pending entries, an empty list meaning all of them. */
export async function downloadPending(playlistId: string, entryIds: string[]): Promise<void> {
  if (jobRunning(state.downloadProgress)) {
    setNotice("Another playlist is already downloading. Download the waiting songs when it finishes.");
    return;
  }

  state.downloadPlaylistId = playlistId;
  state.downloadProgress = {
    phase: "downloading",
    done: 0,
    total: entryIds.length,
    label: "",
    message: "Starting...",
    failures: [],
    reused: 0,
    startedAt: Date.now(),
  };
  downloading = true;
  emit();

  try {
    const outcome = await ipc.downloadPlaylist(playlistId, entryIds);
    applyPersisted(outcome.state);
    await rescan();
    setNotice(downloadSummary(outcome));
    // Only a failure stays on screen; a clean run needs no line left behind.
    state.downloadProgress =
      outcome.errors.length > 0
        ? failedProgress(
            `${plural(outcome.songs, "song")} downloaded, ${outcome.errors.length} failed.`,
            outcome.errors,
          )
        : null;
  } catch (error) {
    const message = describe(error);
    setNotice(message);
    state.downloadProgress = failedProgress(message);
  } finally {
    downloading = false;
    emit();
  }
}

let queuedRecentColours: string[] | null = null;
let themesPending = 0;

export async function setTheme(theme: string): Promise<void> {
  const previous = queuedRecentColours ?? state.settings.recentColours;
  const recentColours =
    theme === ADAPTIVE_THEME
      ? previous
      : [theme, ...previous.filter((colour) => colour !== theme)].slice(
          0,
          RECENT_THEME_LIMIT,
        );

  queuedRecentColours = recentColours;
  themesPending += 1;
  try {
    await queueSettingsWrite({ theme, recentColours });
  } catch (error) {
    setNotice(describe(error));
  } finally {
    themesPending -= 1;
    if (themesPending === 0) {
      queuedRecentColours = null;
    }
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
      await queueSettingsWrite({ miniCorner: corner }, undefined, () => ipc.placeMiniPlayer(corner));
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

/** Follows the link import and the config file, for the dialog. */
function watchSources(): void {
  void listen<string>("phone-folder-import", (event) => {
    if (state.folderImport !== null) {
      state.folderImport = event.payload;
      scheduleEmit();
    }
  }).catch(() => {});
  void listen<ImportProgress>("wavelist-import", (event) => {
    state.transferProgress = event.payload;
    scheduleEmit();
  }).catch(() => {
    // A plain browser has no Tauri event bridge.
  });
  void listen<ImportProgress>(SOURCE_PROGRESS_EVENT, (event) => {
    state.importing = event.payload;
    // A playlist download reports on this event too, so the sheet can follow it.
    if (downloading) {
      state.downloadProgress = event.payload;
    }
    scheduleEmit();
  }).catch(() => {
    // Not running inside Tauri, for example `npm run dev` in a browser.
  });

  void listen<ImportProgress>(GENERATE_PROGRESS_EVENT, (event) => {
    state.generateProgress = event.payload;
    scheduleEmit();
  }).catch(() => {
    // Same as above.
  });

  void listen<ImportProgress>(LYRICS_PROGRESS_EVENT, (event) => {
    state.lyricsProgress = event.payload;
    scheduleEmit();
  }).catch(() => {
    // Same as above.
  });

  void listen<ImportProgress>(COVERS_PROGRESS_EVENT, (event) => {
    state.coversProgress = event.payload;
    scheduleEmit();
  }).catch(() => {
    // Same as above.
  });

  void listen<ImportProgress>(GENRES_PROGRESS_EVENT, (event) => {
    state.genresProgress = event.payload;
    scheduleEmit();
  }).catch(() => {
    // Same as above.
  });

  void listen<Track[]>(LANDED_EVENT, (event) => {
    mergeLanded(event.payload ?? []);
  }).catch(() => {
    // Same as above.
  });

  void listen(CONFIG_EVENT, () => {
    // One save can arrive as several events, so wait for the dust to settle.
    if (configTimer !== null) {
      return;
    }
    configTimer = window.setTimeout(() => {
      configTimer = null;
      if (!isAndroidPlatform) {
        void refreshSpotifyStatus();
        void refreshDeezerStatus();
        void refreshYoutubeStatus();
      }
    }, CONFIG_SETTLE_MS);
  }).catch(() => {
    // Same as above: the browser has no config watcher.
  });
}

/** Adds the songs a running download has just filed into the library. */
function mergeLanded(landed: Track[]): void {
  if (landed.length === 0) {
    return;
  }

  const arrived = new Set(landed.map((track) => track.id));
  for (const track of landed) {
    state.tracksById.set(track.id, track);
  }

  // Kept in the order a scan leaves the library in.
  state.tracks = [...state.tracks.filter((track) => !arrived.has(track.id)), ...landed].sort(
    (a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()),
  );

  recomputeCollections();
  adoptSource();
  scheduleEmit();
}

/** Follows a loudness pass, so each reading lands as soon as it is measured. */
function watchLoudness(): void {
  void listen<LoudnessUpdate>(LOUDNESS_EVENT, (event) => {
    const { id, lufs, peak, done, total } = event.payload;

    loudnessDuringScan?.set(id, { lufs, peak });
    const track = state.tracksById.get(id);
    if (track) {
      track.lufs = lufs;
      track.peak = peak;
    }
    state.analysing = { done, total };

    if (player.currentId === id) {
      player.refreshGain();
    }
    scheduleEmit();
  }).catch(() => {
    // Not running inside Tauri, for example `npm run dev` in a browser.
  });
  if (isAndroidPlatform) {
    void listen("loudness-finished", () => {
      state.analysing = null;
      scheduleEmit();
    }).catch(() => {});
  }
}

function watchSettings(): void {
  void listen<Settings>(SETTINGS_EVENT, () => {
    void refreshPersistedState();
  }).catch(() => {
    // Not running inside Tauri, for example `npm run dev` in a browser.
  });
}

function watchExternalChanges(): void {
  if (!isAndroidPlatform) {
    void listen<ScanSummary>(LIBRARY_CHANGED_EVENT, (event) => {
      void applyScan(event.payload)
        .then(() => emit())
        .catch(() => {
          // The window keeps what it holds; the API's own reply says what happened.
        });
    }).catch(() => {
      // Not running inside Tauri, for example `npm run dev` in a browser.
    });
  }

  void listen<PersistedState>(STATE_CHANGED_EVENT, () => {
    void refreshPersistedState();
  }).catch(() => {
    // Same as above.
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
    await queueSettingsWrite(patch);
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

/**
 * Looks the releases up and keeps whatever it finds. `announce` marks a version
 * the store did not already hold, which is what earns it a notification.
 */
export async function checkForUpdates(announce = false): Promise<void> {
  if (state.updateChecking) {
    return;
  }

  const known = state.update?.version ?? null;
  state.updateChecking = true;
  state.updateError = null;
  emit();

  try {
    const found = await ipc.checkUpdate();
    state.update = found;
    if (announce && found && found.version !== known) {
      state.updateFoundAt = Date.now();
    }
  } catch (error) {
    state.updateError = describe(error);
  }

  state.updateChecking = false;
  emit();
}

/** Downloads the newer release and starts its installer. */
export async function installUpdate(): Promise<void> {
  if (state.updateProgress !== null || state.updateChecking) {
    return;
  }

  state.updateProgress = { received: 0, total: 0 };
  state.updateError = null;
  emit();

  try {
    const handedOff = await ipc.installUpdate();
    if (handedOff) {
      state.updateProgress = null;
      emit();
    }
  } catch (error) {
    state.updateProgress = null;
    state.updateError = describe(error);
    emit();
  }
}

/**
 * The one check the app makes on its own, on the way in. What the last session
 * left is read first, so the panel can offer it without the network and so a
 * version already found is not announced all over again.
 */
async function startUpdater(): Promise<void> {
  try {
    state.update = await ipc.updateStatus();
  } catch {
    // Nothing stored reads as nothing found.
  }
  emit();

  if (state.settings.autoUpdate) {
    await checkForUpdates(true);
  }
}

/** Follows an update download, so the popup can show how far it has got. */
function watchUpdate(): void {
  void listen<UpdateProgress>(UPDATE_PROGRESS_EVENT, (event) => {
    if (state.updateProgress !== null) {
      state.updateProgress = event.payload;
      scheduleEmit();
    }
  }).catch(() => {
    // Not running inside Tauri, for example `npm run dev` in a browser.
  });
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
  markSettingsPatch({ volume: player.snapshot().volume });
  if (volumeTimer !== null) {
    window.clearTimeout(volumeTimer);
  }
  volumeTimer = window.setTimeout(() => {
    volumeTimer = null;
    void saveVolume();
  }, VOLUME_SAVE_MS);
}

async function saveVolume(): Promise<boolean> {
  if (!volumeUnsaved) {
    await settingsWrites;
    return true;
  }
  const patch = { volume: player.snapshot().volume };
  const versions = currentSettingVersions(patch);
  try {
    await queueSettingsWrite(patch, versions, ipc.patchSettings, false);
    if (settingVersions.volume === versions.volume) {
      volumeUnsaved = false;
    }
    refreshAfterWrites();
    return true;
  } catch {
    // Volume is cosmetic; a failed write is not worth interrupting playback.
    return false;
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

let lyricsSequence = 0;

/**
 * Reads the lyrics for a track. The backend resolves the file it recorded, or a
 * sidecar sitting beside the audio. Empty when there is neither.
 */
export async function ensureLyrics(track: Track | undefined): Promise<void> {
  const trackId = track?.id ?? null;
  if (state.lyricsTrackId === trackId) {
    return;
  }

  const sequence = ++lyricsSequence;
  state.lyricsTrackId = trackId;
  state.lyrics = [];
  state.lyricsLoading = Boolean(track);
  emit();

  if (!track) {
    return;
  }

  try {
    const raw = await ipc.loadLyrics(track.id);
    if (sequence !== lyricsSequence) {
      return; // a newer track was requested while this one was loading
    }
    state.lyrics = raw ? parseLrc(raw) : [];
  } catch {
    if (sequence !== lyricsSequence) {
      return;
    }
    state.lyrics = [];
  }
  state.lyricsLoading = false;
  emit();
}

function applyPersisted(next: PersistedState, settings = false, likes = false, playlists = false): void {
  if (settings && next.settings) {
    confirmedSettings = next.settings;
    state.settings = {
      ...next.settings,
      ...eqUnsaved,
      ...(volumeUnsaved ? { volume: player.snapshot().volume } : {}),
    };
    if (!volumeUnsaved && next.settings.volume !== player.snapshot().volume) {
      player.setVolume(next.settings.volume);
    }
  }

  // Replacing these only when they actually moved is what lets the collections
  // below be left alone, so a volume save does not re-group the library.
  if (playlists) {
    applyPlaylists(next.playlists ?? []);
  }

  if (likes) {
    applyLikes(next.likes ?? []);
  }

  state.windowSlots = next.windowSlots ?? [];
  state.recentImports = next.recentImports ?? [];
  state.spotify = next.spotify ?? null;
  state.update = next.update ?? null;
  applyColours(next.artworkColours ?? {});
  refreshCollections();
  eq.apply(state.settings);
}

/** True when two sets of likes hold the same songs. */
function sameLikes(current: Set<string>, next: string[]): boolean {
  return current.size === next.length && next.every((id) => current.has(id));
}

/** True when two sets of playlists hold the same songs in the same order. */
function samePlaylists(current: Playlist[], next: Playlist[]): boolean {
  if (current === next) {
    return true;
  }
  if (current.length !== next.length) {
    return false;
  }

  return current.every((before, at) => {
    const after = next[at];
    return (
      before.id === after.id &&
      before.name === after.name &&
      before.kind === after.kind &&
      sameList(before.trackIds, after.trackIds) &&
      sameList(before.entries, after.entries) &&
      samePending(before.pending, after.pending)
    );
  });
}

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, at) => value === right[at]);
}

function samePending(left: PendingTrack[], right: PendingTrack[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, at) => entry.id === right[at].id && entry.coverPath === right[at].coverPath)
  );
}

let coloursRead = -1;

function applyColours(next: Record<string, string>): void {
  const entries = Object.entries(next);
  if (entries.length === coloursRead) {
    return;
  }
  coloursRead = entries.length;
  state.colours = new Map(entries.filter(([, hex]) => isUsableAccent(hex)));
}

let collectionsFrom: { tracks: Track[]; playlists: Playlist[]; likes: Set<string> } | null = null;

function recomputeCollections(): void {
  state.collections = buildCollections(state.tracks, state.playlists, state.likes);
  state.collectionsRevision += 1;
  collectionsFrom = { tracks: state.tracks, playlists: state.playlists, likes: state.likes };
}

/** Rebuilds the collections only when something they are built from moved. */
function refreshCollections(): void {
  if (
    collectionsFrom !== null &&
    collectionsFrom.tracks === state.tracks &&
    collectionsFrom.playlists === state.playlists &&
    collectionsFrom.likes === state.likes
  ) {
    return;
  }
  recomputeCollections();
}

/** Every pending entry the playlists hold, keyed by id. */
function indexPending(playlists: Playlist[]): Map<string, PendingTrack> {
  const entries = new Map<string, PendingTrack>();
  for (const playlist of playlists) {
    for (const entry of playlist.pending ?? []) {
      entries.set(entry.id, entry);
    }
  }
  return entries;
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

/** Adds songs the collection a queue came from has gained, without interrupting it. */
function adoptSource(): void {
  const { sourceId } = player.snapshot();
  const source = sourceId ? findCollection(state.collections, sourceId) : undefined;
  if (source) {
    player.adoptSource(queueOrder(source));
  }
}

/** Restores the browsing bits of the session: history, filter and sort. */
function applySession(session: Session | undefined): void {
  if (!session) {
    return;
  }
  state.recents = session.recents ?? [];
  state.filter = knownFilter(session.filter);
  state.sort = knownSort(session.sort);
  state.queueOpen = session.queueOpen ?? false;
}

function knownFilter(value: string | undefined): CollectionFilter {
  return COLLECTION_FILTERS.find((filter) => filter === value) ?? "all";
}

/** A saved order, kept only when this build still knows it. */
function knownSort(value: string | undefined): CollectionSort {
  switch (value) {
    case "size":
    case "plays":
    case "recent":
      return value;
    default:
      return "name";
  }
}

let pendingPlayback: Playback | undefined;
let pendingQueueRevision: number | null = null;

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
  const index = currentId ? order.indexOf(currentId) : -1;
  player.restore({
    ...playback,
    order,
    sourceOrder,
    cursor: Math.max(index, 0),
    positionMs: index < 0 ? 0 : playback.positionMs,
  });
}

/** How long changes are coalesced before the session is written. */
const PERSIST_DELAY_MS = 350;

const AUTOSAVE_MS = 15_000;
const PHONE_CHECKPOINT_MS = 2_000;

let persistTimer: number | null = null;
let autosaveTimer: number | null = null;
let checkpointTimer: number | null = null;
let autosaving = false;
let persistenceWired = false;
let lastSessionContent: string | null = null;
let lastSessionSavedAt = 0;

/** The session as it was last written, so an unchanged one is not rewritten. */
let savedSession: string | null = null;
let sessionWrites: Promise<void> = Promise.resolve();

/** Persists the session on every playback change, and on a slow timer. */
function wirePersistence(): void {
  if (persistenceWired) {
    return;
  }
  persistenceWired = true;
  player.onChange(schedulePersist);
  player.onSeek(schedulePersist);
  autosaveTimer = window.setInterval(() => void autosave(), AUTOSAVE_MS);
  if (isAndroidPlatform || device() !== "desktop") {
    checkpointTimer = window.setInterval(() => {
      if (state.ready && player.snapshot().playing && !checkpointSession().stored) {
        void persistSession();
      }
    }, PHONE_CHECKPOINT_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) void persistSession();
    });
    window.addEventListener("pagehide", () => void persistSession());
  }
}

/** Writes the session soon, coalescing a burst of changes into one write. */
function schedulePersist(): void {
  if (!state.ready) {
    return;
  }
  if (pendingPlayback && player.snapshot().queueRevision !== pendingQueueRevision) {
    pendingPlayback = undefined;
    pendingQueueRevision = null;
  }
  if (isAndroidPlatform || device() !== "desktop") {
    checkpointSession();
  }
  if (persistTimer !== null) {
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
  const pendingCursor = snapshot.currentId && pendingPlayback
    ? pendingPlayback.order.indexOf(snapshot.currentId)
    : -1;
  return {
    playback: pendingPlayback && (!snapshot.currentId || pendingCursor >= 0) ? {
      ...pendingPlayback,
      ...(pendingCursor >= 0 ? {
        cursor: pendingCursor,
        positionMs: Math.round(snapshot.positionMs),
        shuffle: snapshot.shuffle,
        repeat: snapshot.repeat,
        muted: snapshot.muted,
      } : {}),
    } : {
      sourceId: snapshot.sourceId,
      sourceName: snapshot.sourceName,
      sourceOrder: [...snapshot.sourceOrder],
      order: [...snapshot.order],
      cursor: snapshot.cursor,
      positionMs: Math.round(snapshot.positionMs),
      shuffle: snapshot.shuffle,
      repeat: snapshot.repeat,
      muted: snapshot.muted,
    },
    recents: [...state.recents],
    filter: state.filter,
    sort: state.sort,
    queueOpen: state.queueOpen,
  };
}

function phoneRecoveryStorage(): Storage | null {
  if (!isAndroidPlatform && device() === "desktop") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function checkpointSession(): { session: Session; encoded: string; stored: boolean } {
  const session = currentSession();
  const content = JSON.stringify(session);
  if (content !== lastSessionContent) {
    lastSessionContent = content;
    lastSessionSavedAt = Math.max(Date.now(), lastSessionSavedAt + 1);
  }
  session.savedAt = lastSessionSavedAt;
  const encoded = JSON.stringify(session);
  let stored = false;
  try {
    const storage = phoneRecoveryStorage();
    if (storage) {
      storage.setItem(SESSION_RECOVERY_KEY, encoded);
      stored = true;
    }
  } catch {
    // The backend save remains available when web storage is full or disabled.
  }
  return { session, encoded, stored };
}

async function persistSession(): Promise<void> {
  if (!state.ready) {
    return;
  }
  const { session, encoded } = checkpointSession();
  const operation = sessionWrites.then(async () => {
    if (encoded === savedSession) {
      return;
    }
    try {
      await ipc.saveSession(session);
      savedSession = encoded;
    } catch {
      // Persistence is best-effort; a failed write must not disturb playback.
    }
  });
  sessionWrites = operation;
  await operation;
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
  if (checkpointTimer !== null) {
    window.clearInterval(checkpointTimer);
    checkpointTimer = null;
  }
  while (volumeUnsaved) {
    if (!(await saveVolume())) {
      break;
    }
    if (volumeTimer !== null) {
      window.clearTimeout(volumeTimer);
      volumeTimer = null;
    }
  }
  await settingsWrites;
  await persistSession();
  await flushEq();
  // The listen still running is written down before the window goes.
  await flushAnalytics();
}

/** A preset picked by hand, which holds until what is playing moves on. */
let eqManual: { presetId: string; key: string } | null = null;

/** The origin that last set the bands, so the same one is not applied twice. */
let eqApplied: string | null = null;

/** The outputs the engine last admitted to, so a rule can be named. */
let eqOutputsKnown: EqOutput[] = [];
let eqSinkOutputs: EqOutput[] = [];
let eqActiveOutputs: string[] = [];
let eqNativeOutputs = false;
let eqRouteKnown = false;
let eqOutputRefresh = 0;
let eqAwaitingInitialOutput = false;

/** How long a burst of changes is left to settle before the curve is written. */
const EQ_SAVE_MS = 400;
let eqTimer: number | null = null;
let eqUnsaved: Partial<Settings> | null = null;
let eqSaving = 0;
let eqWired = false;

eq.onOutputChange(() => {
  syncEqOrigin();
  emit();
});

function activeEqOutputs(): string[] {
  const selected = eq.outputId;
  if (!selected || selected === "default") {
    return eqActiveOutputs;
  }
  const sink = eqSinkOutputs.find((output) => output.id === selected);
  if (!sink) {
    return [];
  }
  if (!eqNativeOutputs) {
    return [selected];
  }
  const matches = eqOutputsKnown.filter((output) => output.label === sink.label);
  return matches.length === 1 ? [matches[0].id] : [];
}

/** Where the curve in force came from, so the overlay can say what picked it. */
export interface EqOrigin {
  kind: EqContextKind | "device" | "preset" | "manual";
  /** The album, artist, playlist, genre or output the rule matched. */
  label: string;
  presetId: string;
}

/** Everything the overlay reads about the chain and the rules. */
export interface EqStatus {
  blocked: "unsupported" | "cors" | null;
  live: boolean;
  preampDb: number;
  autoPreampDb: number;
  canChooseOutput: boolean;
  outputs: EqOutput[];
  sinkOutputs: EqOutput[];
  activeOutputIds: string[];
  nativeOutputs: boolean;
  routeKnown: boolean;
  origin: EqOrigin | null;
}

export function eqStatus(): EqStatus {
  return {
    blocked: eq.blockedReason,
    live: eq.live,
    preampDb: eq.preampDb,
    autoPreampDb: eq.autoPreampDb(),
    canChooseOutput: eq.canChooseOutput,
    outputs: eqOutputsKnown,
    sinkOutputs: eqSinkOutputs,
    activeOutputIds: activeEqOutputs(),
    nativeOutputs: eqNativeOutputs,
    routeKnown: eqRouteKnown,
    origin: eqOrigin(),
  };
}

/** Changes the curve, applies it at once and writes it a moment later. */
function applyEqPatch(patch: Partial<Settings>): void {
  markSettingsPatch(patch);
  state.settings = { ...state.settings, ...patch };
  eq.apply(state.settings);
  scheduleEqSave(patch);
  emit();
}

function scheduleEqSave(patch: Partial<Settings>): void {
  eqUnsaved = { ...eqUnsaved, ...patch };
  if (eqTimer !== null) {
    window.clearTimeout(eqTimer);
  }
  eqTimer = window.setTimeout(() => {
    eqTimer = null;
    void saveEq();
  }, EQ_SAVE_MS);
}

async function saveEq(): Promise<boolean> {
  const patch = eqUnsaved;
  eqUnsaved = null;
  if (!patch) {
    await settingsWrites;
    return true;
  }
  const versions = currentSettingVersions(patch);
  eqSaving += 1;
  try {
    await queueSettingsWrite(patch, versions, ipc.patchSettings, false);
    return true;
  } catch {
    // The curve matters less than playback, so a failed write is not announced.
    const retry: Partial<Settings> = {};
    for (const key of Object.keys(patch) as (keyof Settings)[]) {
      if (settingVersions[key] === versions[key]) {
        Object.assign(retry, { [key]: patch[key] });
      }
    }
    if (Object.keys(retry).length > 0) {
      eqUnsaved = Object.assign({}, retry, eqUnsaved);
    }
    return false;
  } finally {
    eqSaving -= 1;
    refreshAfterWrites();
  }
}

/** Writes anything the equaliser still owes, for a window that is going away. */
async function flushEq(): Promise<void> {
  if (eqTimer !== null) {
    window.clearTimeout(eqTimer);
    eqTimer = null;
  }
  await settingsWrites;
  await Promise.resolve();
  while (eqUnsaved !== null) {
    if (!(await saveEq())) {
      break;
    }
    if (eqTimer !== null) {
      window.clearTimeout(eqTimer);
      eqTimer = null;
    }
  }
  await settingsWrites;
}

/** Follows what is playing and what is plugged in, so a rule can pick a curve. */
function wireEq(): void {
  if (eqWired) {
    return;
  }
  eqWired = true;
  player.onChange(syncEqOrigin);
  player.onChange(() => eq.resume());
  window.addEventListener("pointerdown", () => eq.resume(), true);
  window.addEventListener("keydown", () => eq.resume(), true);
  void refreshEqOutputs();
  navigator.mediaDevices?.addEventListener("devicechange", () => {
    void refreshEqOutputs();
  });
  window.addEventListener("wave:audio-outputs-changed", () => void refreshEqOutputs());
  window.addEventListener("focus", () => void refreshEqOutputs());
  if (isTauri() && (isAndroidPlatform || /Windows/i.test(navigator.userAgent))) {
    window.setInterval(() => {
      if (!document.hidden || Object.keys(state.settings.eqDeviceRules).length > 0) {
        void refreshEqOutputs();
      }
    }, 5000);
  }
}

export async function refreshEqOutputs(): Promise<void> {
  const request = ++eqOutputRefresh;
  const nativeSupported = isTauri() && (isAndroidPlatform || /Windows/i.test(navigator.userAgent));
  const devices = navigator.mediaDevices;
  const sinksRequest = nativeSupported && document.hidden
    ? Promise.resolve(eqSinkOutputs)
    : (async (): Promise<EqOutput[]> => {
        try {
          const found = await devices?.enumerateDevices?.() ?? [];
          return found
            .filter((device) => device.kind === "audiooutput")
            .map((device, index) => ({
              id: device.deviceId,
              label: device.label || `Output ${index + 1}`,
            }))
            .filter((output) => output.id && output.id !== "default" && output.id !== "communications");
        } catch {
          return [];
        }
      })();
  let native = null;
  if (nativeSupported) {
    try {
      native = await ipc.audioOutputs();
    } catch {
      // Keep the webview fallback.
    }
  }
  if (request !== eqOutputRefresh) {
    return;
  }
  if (native) {
    updateEqOutputs(native.outputs, eqSinkOutputs, native.activeIds, true, native.routeKnown);
  } else if (nativeSupported && eqNativeOutputs) {
    updateEqOutputs(eqOutputsKnown, eqSinkOutputs, [], true, false);
  }
  const sinks = await sinksRequest;
  if (request === eqOutputRefresh) {
    const keepNative = native !== null || (nativeSupported && eqNativeOutputs);
    updateEqOutputs(native?.outputs ?? (keepNative ? eqOutputsKnown : sinks), sinks,
      native?.activeIds ?? [], keepNative, native?.routeKnown ?? false);
  }
}

function updateEqOutputs(
  outputs: EqOutput[], sinks: EqOutput[], active: string[], native: boolean, routeKnown: boolean,
): void {
  const before = JSON.stringify([eqOutputsKnown, eqSinkOutputs, eqActiveOutputs, eqNativeOutputs, eqRouteKnown]);
  eqOutputsKnown = outputs;
  eqSinkOutputs = sinks;
  eqActiveOutputs = active;
  eqNativeOutputs = native;
  eqRouteKnown = routeKnown;
  if (before === JSON.stringify([eqOutputsKnown, eqSinkOutputs, eqActiveOutputs, eqNativeOutputs, eqRouteKnown])) {
    return;
  }
  syncEqOrigin();
  emit();
}

export function setEqEnabled(on: boolean): void {
  applyEqPatch({ eqEnabled: on });
  syncEqOrigin();
}

export function setEqAutoPreamp(on: boolean): void {
  applyEqPatch({ eqAutoPreamp: on });
}

export function setEqPreampDb(db: number): void {
  applyEqPatch({ eqPreampDb: Math.min(Math.max(db, -24), 24) });
}

export function setEqLimiter(on: boolean): void {
  applyEqPatch({ eqLimiter: on });
}

export function setEqOutput(id: string): void {
  applyEqPatch({ eqOutputId: id });
  syncEqOrigin();
}

/** Fills an empty curve with the bands a flat one starts from. */
export function seedEqBands(): void {
  if (state.settings.eqBands.length > 0) {
    return;
  }
  applyEqPatch({ eqBands: DEFAULT_EQ_BANDS.map((band) => ({ ...band })) });
}

export function addEqBand(): void {
  applyEqPatch({
    eqBands: [
      ...state.settings.eqBands,
      { id: newEqId(), kind: "peaking", freq: 1000, gain: 0, q: 1, enabled: true },
    ],
  });
}

export function removeEqBand(id: string): void {
  applyEqPatch({ eqBands: state.settings.eqBands.filter((band) => band.id !== id) });
}

export function updateEqBand(id: string, patch: Partial<EqBand>): void {
  applyEqPatch({
    eqBands: state.settings.eqBands.map((band) =>
      band.id === id ? { ...band, ...patch } : band,
    ),
  });
}

/** Puts the bands back to a flat line, without touching the saved curves. */
export function flattenEq(): void {
  applyEqPatch({
    eqBands: state.settings.eqBands.map((band) => ({ ...band, gain: 0 })),
    eqPreampDb: 0,
  });
}

/** How many curves are kept. Saving one more than this replaces the oldest. */
export const EQ_PRESET_LIMIT = 10;

function filePreset(
  name: string,
  source: EqPresetSource,
  bands: EqBand[],
  autoPreamp: boolean,
  preampDb: number,
  limiter: boolean,
): { presets: EqPreset[]; preset: EqPreset } {
  const trimmed = name.trim() || "Untitled curve";
  const existing = state.settings.eqPresets.find(
    (entry) => entry.name.toLowerCase() === trimmed.toLowerCase(),
  );

  const preset: EqPreset = {
    id: existing?.id ?? newEqId(),
    name: trimmed,
    // An edit keeps the provenance the curve was filed under.
    source: existing?.source ?? source,
    bands,
    autoPreamp,
    preampDb,
    limiter,
  };

  const presets = existing
    ? state.settings.eqPresets.map((entry) => (entry.id === existing.id ? preset : entry))
    : [...state.settings.eqPresets.slice(1 - EQ_PRESET_LIMIT), preset];

  return { presets, preset };
}

export function saveEqPreset(name: string): void {
  const filed = filePreset(
    name,
    "manual",
    state.settings.eqBands.map((band) => ({ ...band })),
    state.settings.eqAutoPreamp,
    state.settings.eqPreampDb,
    state.settings.eqLimiter,
  );
  markManual(filed.preset.id);
  applyEqPatch({ eqPresets: filed.presets, eqActivePresetId: filed.preset.id });
}

/** Files an imported profile as a curve and puts it in force. */
export function importEqProfile(profile: EqProfile, name: string): void {
  const filed = filePreset(
    name,
    "autoeq",
    profile.bands.map((band) => ({ ...band })),
    true,
    0,
    true,
  );
  markManual(filed.preset.id);
  applyEqPatch({
    eqPresets: filed.presets,
    eqBands: filed.preset.bands.map((band) => ({ ...band })),
    eqAutoPreamp: filed.preset.autoPreamp,
    eqPreampDb: filed.preset.preampDb,
    eqLimiter: filed.preset.limiter,
    eqActivePresetId: filed.preset.id,
    eqEnabled: true,
  });
}

export function deleteEqPreset(id: string): void {
  const deviceRules = { ...state.settings.eqDeviceRules };
  for (const [device, presetId] of Object.entries(deviceRules)) {
    if (presetId === id) {
      delete deviceRules[device];
    }
  }
  applyEqPatch({
    eqPresets: state.settings.eqPresets.filter((preset) => preset.id !== id),
    eqContextRules: state.settings.eqContextRules.filter((rule) => rule.presetId !== id),
    eqDeviceRules: deviceRules,
    eqActivePresetId: state.settings.eqActivePresetId === id
      ? null
      : state.settings.eqActivePresetId,
  });
}

/** Puts a saved curve in force. A hand-picked one holds until the song moves on. */
export function applyEqPreset(presetId: string, byHand = true): void {
  const preset = presetById(presetId);
  if (!preset) {
    return;
  }
  if (byHand) {
    markManual(preset.id);
  }
  applyEqPatch({
    eqBands: preset.bands.map((band) => ({ ...band })),
    eqAutoPreamp: preset.autoPreamp,
    eqPreampDb: preset.preampDb,
    eqLimiter: preset.limiter,
    eqActivePresetId: preset.id,
    eqEnabled: true,
  });
}

/**
 * Notes a curve as the one picked by hand, so no rule puts another over it
 * until what is playing moves on.
 */
function markManual(presetId: string): void {
  eqManual = { presetId, key: eqContextKey() };
  eqApplied = "";
}

export function setEqContextRule(kind: EqContextKind, value: string, presetId: string): void {
  const rest = state.settings.eqContextRules.filter(
    (rule) => !(rule.kind === kind && rule.value === value),
  );
  const rule: EqContextRule = { kind, value, presetId };
  applyEqPatch({ eqContextRules: [...rest, rule] });
  syncEqOrigin();
}

export function removeEqContextRule(kind: EqContextKind, value: string): void {
  applyEqPatch({
    eqContextRules: state.settings.eqContextRules.filter(
      (rule) => !(rule.kind === kind && rule.value === value),
    ),
  });
  syncEqOrigin();
}

export function setEqDeviceRule(deviceId: string, presetId: string): void {
  const deviceRules = { ...state.settings.eqDeviceRules };
  if (presetId) {
    deviceRules[deviceId] = presetId;
  } else {
    delete deviceRules[deviceId];
  }
  applyEqPatch({ eqDeviceRules: deviceRules });
  syncEqOrigin();
}

function presetById(id: string | null): EqPreset | undefined {
  return id ? state.settings.eqPresets.find((preset) => preset.id === id) : undefined;
}

/** What the current song and queue key a rule on. */
function eqContextKey(): string {
  const track = currentTrack();
  const snapshot = player.snapshot();
  return [
    snapshot.sourceId ?? "",
    track?.album ?? "",
    track?.artist ?? "",
    track?.genre ?? "",
    ...activeEqOutputs(),
  ].join("\u0000");
}

/**
 * The rule that picks a curve for what is playing, or `null` when none does.
 * Only a rule is ever applied on its own; the active preset says where the
 * curve came from, and the bands themselves are what the user is working on.
 */
function eqRule(): EqOrigin | null {
  const track = currentTrack();
  const sourceId = player.snapshot().sourceId;
  const candidates: { kind: EqContextKind; value: string | null | undefined }[] = [
    { kind: "playlist", value: sourceId },
    { kind: "album", value: track?.album },
    { kind: "artist", value: track?.artist },
    { kind: "genre", value: track?.genre },
  ];

  for (const candidate of candidates) {
    if (!candidate.value) {
      continue;
    }
    const rule = state.settings.eqContextRules.find(
      (entry) => entry.kind === candidate.kind && entry.value === candidate.value,
    );
    if (rule && presetById(rule.presetId)) {
      return { kind: candidate.kind, label: candidate.value, presetId: rule.presetId };
    }
  }

  for (const outputId of activeEqOutputs()) {
    const byDevice = state.settings.eqDeviceRules[outputId];
    if (byDevice && presetById(byDevice)) {
      return { kind: "device", label: outputLabel(outputId), presetId: byDevice };
    }
  }

  return null;
}

/** What picked the curve in force, or `null` when nothing did. */
export function eqOrigin(): EqOrigin | null {
  const manual = presetById(eqManual?.presetId ?? null);
  if (manual) {
    return { kind: "manual", label: manual.name, presetId: manual.id };
  }

  const rule = eqRule();
  if (rule) {
    return rule;
  }

  const active = presetById(state.settings.eqActivePresetId);
  return active ? { kind: "preset", label: active.name, presetId: active.id } : null;
}

function outputLabel(id: string): string {
  return [...eqOutputsKnown, ...eqSinkOutputs].find((output) => output.id === id)?.label ?? "This output";
}

/** Follows what is playing, so a rule picks the curve that goes with it. */
function syncEqOrigin(): void {
  const key = eqContextKey();
  if (eqAwaitingInitialOutput && activeEqOutputs().length > 0) {
    eqAwaitingInitialOutput = false;
    if (eqManual) {
      eqManual.key = key;
    } else {
      const initial = eqRule();
      if (initial && initial.presetId === state.settings.eqActivePresetId) {
        eqApplied = `${initial.kind}\u0000${initial.presetId}`;
        return;
      }
    }
  }
  if (eqManual && eqManual.key !== key) {
    eqManual = null;
  }

  const rule = eqManual ? null : eqRule();
  const signature = rule ? `${rule.kind}\u0000${rule.presetId}` : "";
  if (signature === eqApplied) {
    return;
  }
  eqApplied = signature;
  if (rule) {
    applyEqPreset(rule.presetId, false);
  }
}

/**
 * Notes the rule already in force at launch, so opening the app leaves the
 * curve where it was left rather than putting a preset back over the edits.
 */
function seedEqOrigin(): void {
  eqAwaitingInitialOutput = activeEqOutputs().length === 0;
  const rule = eqRule();
  if (rule && rule.presetId !== state.settings.eqActivePresetId) {
    eqApplied = null;
    syncEqOrigin();
  } else {
    eqApplied = rule ? `${rule.kind}\u0000${rule.presetId}` : "";
  }
}

function newEqId(): string {
  return `eq-${Math.random().toString(36).slice(2, 10)}`;
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
