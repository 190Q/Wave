import type {
  AnalyticsEvent,
  AnalyticsEventKind,
  Collection,
  MediaType,
  PlayReason,
  PlayRecord,
  Track,
  TrackSnapshot,
} from "../types";
import * as ipc from "./ipc";
import type { Player, PlayerSnapshot } from "./player";

/** What the capture needs from the app, handed over at mount. */
export interface AnalyticsContext {
  player: Player;
  trackById(id: string | null): Track | undefined;
  collectionById(id: string): Collection | undefined;
  /** Whether the user has the record switched on. */
  enabled(): boolean;
}

/** A listen that is still running. */
interface ListenDraft {
  listenId: string;
  trackId: string;
  /** Epoch milliseconds. */
  startedAt: number;
  /** Wall-clock milliseconds actually heard, which is not the playhead. */
  msPlayed: number;
  /** When the last frame was counted, `null` while paused. */
  lastTickAt: number | null;
  /** Set when the song ran to its end, which is what makes it a stream. */
  ended: boolean;
  sourceId: string | null;
  sourceName: string | null;
  sourceKind: string | null;
  shuffle: boolean;
  repeat: string | null;
}

/** What `recordEvent` can be told beyond the kind. */
export interface EventOptions {
  trackIds?: string[];
  playlistId?: string | null;
  value?: string | null;
}

/** How long a burst of writes is left to settle before they are sent. */
const FLUSH_DELAY_MS = 2_000;

/** How often a listen still running is written down, so a crash costs little. */
const CHECKPOINT_MS = 30_000;

/** A frame gap longer than this is a stall, not listening. */
const MAX_TICK_MS = 1_000;

/** Below this, nothing was really heard and no record is worth keeping. */
const MIN_LISTEN_MS = 1_000;

/** Selections larger than this are recorded as one summary row, not one each. */
const BULK_EVENT_LIMIT = 100;

let context: AnalyticsContext | null = null;
let draft: ListenDraft | null = null;
let queued: PlayRecord[] = [];
let lastId: string | null = null;
let lastPlaying = false;
let flushTimer: number | null = null;
let checkpointTimer: number | null = null;
let counter = 0;

/** Starts following the player. Does nothing if it is already following one. */
export function mountAnalytics(next: AnalyticsContext): void {
  if (context) {
    return;
  }
  context = next;
  next.player.onChange(handleChange);
  next.player.onProgress(handleProgress);
  lastId = next.player.currentId;
  lastPlaying = next.player.snapshot().playing;
  // A window that is going away may never see another change event.
  window.addEventListener("pagehide", () => void flushAnalytics());
}

/** Snapshots the library, so a song that is deleted later still has a name. */
export function rememberTracks(tracks: Track[]): void {
  if (!context?.enabled() || tracks.length === 0) {
    return;
  }
  const snapshots = tracks.map(snapshotOf);
  void ipc.rememberTracks(snapshots).catch(() => {
    // The record is a nicety; a failed write must not disturb the library.
  });
}

/** Records a signal that is not a play: a like, a playlist edit, and so on. */
export function recordEvent(kind: AnalyticsEventKind, options: EventOptions = {}): void {
  if (!context?.enabled()) {
    return;
  }

  const { trackIds = [], playlistId = null, value = null } = options;
  const at = now();
  // A handful of songs get a row each; a bulk edit gets one row that says so.
  const events: AnalyticsEvent[] =
    trackIds.length === 0 || trackIds.length > BULK_EVENT_LIMIT
      ? [{ at, kind, trackId: null, playlistId, value }]
      : trackIds.map((trackId) => ({ at, kind, trackId, playlistId, value }));

  void ipc.recordAnalyticsEvents(events).catch(() => {
    // Same as above.
  });
}

/** The current song ran to its end, so its listen is finished. */
export function noteTrackEnded(): void {
  if (!draft) {
    return;
  }
  draft.ended = true;
  close("ended");
}

/** The current song could not be played. */
export function notePlaybackError(): void {
  close("error");
}

export function forgetCaptured(): void {
  draft = null;
  queued = [];
  stopCheckpoint();
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
}

/** Writes everything outstanding. Awaited before the window is allowed to go. */
export async function flushAnalytics(): Promise<void> {
  if (context?.enabled()) {
    // Whatever was still running is written as it stands.
    close("stopped");
  } else {
    draft = null;
  }
  stopCheckpoint();
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }

  const batch = queued;
  queued = [];
  await writeBatch(batch);
}

function handleChange(snapshot: PlayerSnapshot): void {
  if (snapshot.currentId !== lastId) {
    close("skipped");
    lastId = snapshot.currentId;
  }

  if (snapshot.playing !== lastPlaying) {
    lastPlaying = snapshot.playing;
    if (draft) {
      draft.lastTickAt = snapshot.playing ? now() : null;
    }
  }

  if (snapshot.playing && snapshot.currentId && !draft && context?.enabled()) {
    open(snapshot);
  }
}

function handleProgress(): void {
  if (!draft) {
    return;
  }
  if (!context?.enabled()) {
    // Switched off mid-song: the open listen is dropped, not written.
    draft = null;
    stopCheckpoint();
    scheduleFlush();
    return;
  }
  if (draft.lastTickAt === null) {
    return;
  }

  const at = now();
  draft.msPlayed += Math.min(Math.max(at - draft.lastTickAt, 0), MAX_TICK_MS);
  draft.lastTickAt = at;
}

function open(snapshot: PlayerSnapshot): void {
  const track = context?.trackById(snapshot.currentId);
  if (!track) {
    return;
  }

  const at = now();
  draft = {
    listenId: nextListenId(),
    trackId: track.id,
    startedAt: at,
    msPlayed: 0,
    lastTickAt: at,
    ended: false,
    sourceId: snapshot.sourceId,
    sourceName: snapshot.sourceName || null,
    sourceKind: sourceKind(snapshot.sourceId),
    shuffle: snapshot.shuffle,
    repeat: snapshot.repeat,
  };
  startCheckpoint();
}

/** Ends the open listen, keeping it only if something was actually heard. */
function close(fallback: PlayReason): void {
  const current = draft;
  draft = null;
  stopCheckpoint();
  if (!current) {
    return;
  }
  if (!current.ended && current.msPlayed < MIN_LISTEN_MS) {
    // A mis-tap or a click-through: nothing was heard, so there is no listen.
    return;
  }
  if (!context?.enabled()) {
    return;
  }

  queued.push(toRecord(current, current.ended, current.ended ? "ended" : fallback));
  scheduleFlush();
}

function toRecord(current: ListenDraft, ended: boolean, reason: PlayReason): PlayRecord {
  return {
    listenId: current.listenId,
    trackId: current.trackId,
    startedAt: current.startedAt,
    endedAt: reason === "open" ? null : now(),
    msPlayed: Math.round(current.msPlayed),
    durationMs: durationOf(current.trackId),
    completed: ended,
    reason,
    sourceId: current.sourceId,
    sourceName: current.sourceName,
    sourceKind: current.sourceKind,
    shuffle: current.shuffle,
    repeat: current.repeat,
  };
}

function startCheckpoint(): void {
  stopCheckpoint();
  checkpointTimer = window.setInterval(() => void checkpoint(), CHECKPOINT_MS);
}

function stopCheckpoint(): void {
  if (checkpointTimer !== null) {
    window.clearInterval(checkpointTimer);
    checkpointTimer = null;
  }
}

/** Writes the listen in progress as it stands, so a crash loses little of it. */
async function checkpoint(): Promise<void> {
  const current = draft;
  if (!current || !context?.enabled()) {
    return;
  }
  try {
    await ipc.recordPlay(toRecord(current, false, "open"));
  } catch {
    // Best effort; the next checkpoint tries again.
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) {
    return;
  }
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    const batch = queued;
    queued = [];
    void writeBatch(batch);
  }, FLUSH_DELAY_MS);
}

async function writeBatch(batch: PlayRecord[]): Promise<void> {
  for (const play of batch) {
    try {
      await ipc.recordPlay(play);
    } catch {
      // Persistence is best-effort; a failed write must not disturb playback.
    }
  }
}

function sourceKind(sourceId: string | null): string | null {
  if (!sourceId || !context) {
    return null;
  }
  return context.collectionById(sourceId)?.kind ?? null;
}

function durationOf(trackId: string): number {
  return context?.trackById(trackId)?.durationMs ?? 0;
}

function snapshotOf(track: Track): TrackSnapshot {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    albumArtist: track.albumArtist,
    genre: track.genre,
    year: track.year,
    durationMs: track.durationMs,
    mediaType: mediaTypeOf(track),
    codec: track.codec,
  };
}

function mediaTypeOf(track: Track): MediaType {
  if (extensionOf(track.relativePath || track.path) === "m4b") {
    return "audiobook";
  }
  const genre = (track.genre ?? "").toLowerCase();
  if (genre.includes("audiobook")) {
    return "audiobook";
  }
  if (genre.includes("podcast") || genre.includes("spoken word")) {
    return "podcast";
  }
  return "music";
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
}

function nextListenId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function now(): number {
  return Date.now();
}
