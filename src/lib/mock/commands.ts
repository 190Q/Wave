import type {
  CoversOutcome,
  GenerateOutcome,
  GenresOutcome,
  ImportOutcome,
  ImportPlan,
  LoudnessOutcome,
  LyricsOutcome,
  NowPlaying,
  PendingTrack,
  PersistedState,
  PlaylistMode,
  RecommendationSeeds,
  ScanSummary,
  Session,
  Settings,
  SwellSummary,
  TopSong,
  Track,
  UpdateInfo,
} from "../../types";
import { artworkJpeg, coverJpeg } from "./artwork";
import type { SimSummary } from "./bridge";
import { buildFixture, buildTracks, makePending, ROOT, savedFrame, sliceIds } from "./fixtures";
import { hashText } from "./hash";
import { silentWav } from "./wav";

/** Extensions the stub hands back as a silent tone rather than as a path. */
const AUDIO_EXTENSIONS = new Set(["mp3", "flac", "m4a", "opus", "ogg", "wav", "aac"]);

const RANKED_LIMIT = 100;

/** Where the frame's lyrics switch is kept, so a reload keeps it. */
const LYRICS_KEY = "wave:sim:lyrics";

let tracks = buildTracks();
let persisted = buildFixture(tracks);
let updateAvailable = false;
let nowPlayingSong: NowPlaying | null = null;
let playlistCount = persisted.playlists.length;
let nextListener = 1;
let nextCallback = 1;

/** The callbacks the app registered through transformCallback, by id. */
const callbacks = new Map<number, (payload: unknown) => void>();
/** Event name -> listener id -> callback id. */
const listeners = new Map<string, Map<number, number>>();

/** The whole fixture, cloned so the app cannot write into the stub's copy. */
export function snapshot(): PersistedState {
  return structuredClone(persisted);
}

/** A handle the app can call later, which is how the event system is wired. */
export function registerCallback(callback: (payload: unknown) => void, once = false): number {
  const id = nextCallback;
  nextCallback += 1;
  callbacks.set(
    id,
    once
      ? (payload) => {
          callbacks.delete(id);
          callback(payload);
        }
      : callback,
  );
  return id;
}

export function unregisterCallback(id: number): void {
  callbacks.delete(id);
}

/** Delivers a Tauri event to everything listening for it. */
export function emitEvent(event: string, payload: unknown = null): void {
  const held = listeners.get(event);
  if (!held) {
    return;
  }
  for (const [id, callback] of [...held]) {
    callbacks.get(callback)?.({ event, id, payload });
  }
}

/** Drops a listener the app has stopped caring about. */
export function unregisterListener(event: string, id: number): void {
  listeners.get(event)?.delete(id);
}

function lyricsAvailable(): boolean {
  return window.localStorage.getItem(LYRICS_KEY) === "1";
}

export function setLyricsAvailable(on: boolean): void {
  window.localStorage.setItem(LYRICS_KEY, on ? "1" : "0");
}

export function setUpdateAvailable(on: boolean): void {
  updateAvailable = on;
}

export function nowPlaying(): NowPlaying | null {
  return nowPlayingSong;
}

export function summary(): SimSummary {
  return {
    tracks: tracks.length,
    playlists: persisted.playlists.length,
    likes: persisted.likes.length,
  };
}

/**
 * The release the stub offers when the frame asks for one, so the notice, the
 * popup and the settings section can all be seen without a device.
 */
function offeredUpdate(): UpdateInfo {
  return {
    version: "0.3.0",
    url: "https://github.com/190Q/Wave/releases/latest",
    features: [
      "Phone updates come from GitHub releases",
      "A notice no longer covers the library",
      "The queue scales with the screen",
    ],
    publishedAt: new Date(Date.now() - 86_400_000).toISOString(),
    assetName: "Wave_0.3.0_arm64.apk",
    assetUrl: "https://example.com/Wave_0.3.0_arm64.apk",
    automatic: true,
  };
}

/**
 * A file URL, standing in for the asset protocol. Audio paths become a silent
 * WAV of the same length, so the element reports a real duration.
 */
export function convertFileSrc(path: string): string {
  if (!AUDIO_EXTENSIONS.has(extensionOf(path))) {
    return path;
  }
  const track = tracks.find((entry) => entry.path === path);
  return silentWav(track?.durationMs ?? 180_000);
}

export async function invokeCommand(
  command: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  if (Object.prototype.hasOwnProperty.call(handlers, command)) {
    return handlers[command](args);
  }
  if (command.startsWith("plugin:")) {
    // A plugin command the app reached for and the stub does not model.
    console.warn(`[wave simulator] no stub for ${command}`);
    return null;
  }
  throw new Error(`The simulator has no stub for "${command}".`);
}

type Handler = (args: Record<string, unknown>) => unknown;

const handlers: Record<string, Handler> = {
  get_state: () => snapshot(),

  set_now_playing: ({ song }) => {
    nowPlayingSong = isObject(song) ? (song as unknown as NowPlaying) : null;
  },

  api_report: () => undefined,

  set_settings: ({ settings }) => {
    if (isObject(settings)) {
      persisted.settings = { ...persisted.settings, ...(settings as Partial<Settings>) };
    }
    return snapshot();
  },

  set_session: ({ session }) => {
    if (isObject(session)) {
      persisted.session = session as unknown as Session;
    }
    return snapshot();
  },

  save_window_geometry: () => {
    persisted.window = savedFrame(0);
  },

  reset_window_geometry: () => {
    persisted.window = null;
  },

  save_window_slot: ({ slot }) => {
    const at = count(slot);
    const slots = [...persisted.windowSlots];
    while (slots.length <= at) {
      slots.push(null);
    }
    slots[at] = savedFrame(at);
    persisted.windowSlots = slots;
    return snapshot();
  },

  apply_window_slot: ({ slot }) => {
    if (!persisted.windowSlots[count(slot)]) {
      throw new Error("No window frame is saved for that slot.");
    }
  },

  place_mini_player: ({ corner }) => {
    persisted.settings = { ...persisted.settings, miniPlayer: true, miniCorner: count(corner) };
    return snapshot();
  },

  show_main_window: () => undefined,

  create_playlist: ({ name }) => {
    playlistCount += 1;
    persisted.playlists = [
      ...persisted.playlists,
      {
        id: `pl-${playlistCount}`,
        name: text(name) || "New playlist",
        kind: "custom",
        entries: [],
        trackIds: [],
        pending: [],
        createdAt: Date.now(),
      },
    ];
    return snapshot();
  },

  rename_playlist: ({ id, name }) => {
    const wanted = text(name);
    persisted.playlists = persisted.playlists.map((entry) =>
      entry.id === text(id) && wanted ? { ...entry, name: wanted } : entry,
    );
    return snapshot();
  },

  delete_playlist: ({ id }) => {
    persisted.playlists = persisted.playlists.filter((entry) => entry.id !== text(id));
    return snapshot();
  },

  recommend_status: () => null,

  generate_playlist: ({ mode, genre }) => generate(text(mode) === "genre" ? "genre" : "taste", text(genre)),

  download_playlist: ({ playlistId, entryIds }) => download(text(playlistId), list(entryIds)),

  add_to_playlist: ({ id, trackIds }) => {
    const wanted = list(trackIds);
    persisted.playlists = persisted.playlists.map((entry) => {
      if (entry.id !== text(id)) {
        return entry;
      }
      const fresh = wanted.filter((trackId) => !entry.trackIds.includes(trackId));
      return { ...entry, trackIds: [...entry.trackIds, ...fresh], entries: [...entry.entries, ...fresh] };
    });
    return snapshot();
  },

  remove_from_playlist: ({ id, trackIds }) => {
    const drop = new Set(list(trackIds));
    persisted.playlists = persisted.playlists.map((entry) =>
      entry.id === text(id)
        ? {
            ...entry,
            trackIds: entry.trackIds.filter((trackId) => !drop.has(trackId)),
            entries: entry.entries.filter((entryId) => !drop.has(entryId)),
          }
        : entry,
    );
    return snapshot();
  },

  reorder_playlist: ({ id, trackIds }) => {
    const order = list(trackIds);
    persisted.playlists = persisted.playlists.map((entry) =>
      entry.id === text(id)
        ? { ...entry, trackIds: order, entries: [...order, ...entry.pending.map((pending) => pending.id)] }
        : entry,
    );
    return snapshot();
  },

  toggle_like: ({ trackId }) => {
    const id = text(trackId);
    persisted.likes = persisted.likes.includes(id)
      ? persisted.likes.filter((entry) => entry !== id)
      : [...persisted.likes, id];
    return snapshot();
  },

  set_likes: ({ trackIds, liked }) => {
    const wanted = new Set(list(trackIds));
    const kept = persisted.likes.filter((entry) => !wanted.has(entry));
    persisted.likes = flag(liked) ? [...kept, ...wanted] : kept;
    return snapshot();
  },

  delete_tracks: ({ trackIds }) => {
    const drop = new Set(list(trackIds));
    tracks = tracks.filter((track) => !drop.has(track.id));
    persisted.likes = persisted.likes.filter((id) => !drop.has(id));
    persisted.playlists = persisted.playlists.map((entry) => ({
      ...entry,
      trackIds: entry.trackIds.filter((id) => !drop.has(id)),
      entries: entry.entries.filter((id) => !drop.has(id)),
    }));
    return snapshot();
  },

  scan_library: () => scanSummary(),

  // Left null, so the panels that read it take their own "could not be read" path.
  library_info: () => null,

  open_library_folder: () => undefined,
  analyse_loudness: (): LoudnessOutcome => ({ measured: 0, skipped: 0, failures: [] }),

  import_folder: () => importOutcome(["The simulator does not import from disk."]),
  import_picked_files: () => importOutcome(["The simulator does not import from disk."]),
  scan_phone_music: () => importOutcome(["The simulator does not import from disk."]),
  spotify_status: () => spotifyStatus(),
  open_spotify_config: () => undefined,
  open_import_log: () => undefined,
  import_log_path: () => `${ROOT}\\import.log`,
  spotify_plan: () => plan(),
  spotify_import: () => importOutcome(["The simulator does not download."]),
  deezer_status: () => toolStatus(),
  deezer_plan: () => plan(),
  deezer_import: () => importOutcome(["The simulator does not download."]),
  youtube_plan: () => plan(),
  youtube_import: () => importOutcome(["The simulator does not download."]),
  youtube_status: () => toolStatus(),
  import_wavelist: () => importOutcome(["The simulator does not download."]),
  export_wavelist: ({ trackIds }) => list(trackIds).length,

  fetch_lyrics: ({ trackIds }) => fetchLyrics(list(trackIds)),
  fetch_covers: ({ trackIds }) => fetchCovers(list(trackIds)),
  fetch_genres: ({ trackIds }) => fetchGenres(list(trackIds)),

  artwork_colour: ({ trackId, path }) => colourFor(text(path) || text(trackId)),
  load_lyrics: ({ trackId }) => (lyricsAvailable() ? lyricsFor(text(trackId)) : null),
  artwork_bytes: ({ path }) => artworkJpeg(text(path)),
  cover_bytes: ({ paths }) => coverJpeg(list(paths)),

  analytics_remember_tracks: () => undefined,
  analytics_record_play: () => undefined,
  analytics_record_events: () => undefined,
  analytics_swell: ({ from, to }) => swellSummary(count(from), count(to)),
  analytics_top_songs: ({ limit }) => topSongs(count(limit) || 10),
  analytics_play_counts: () => playCounts(),
  analytics_recommendation_seeds: (): RecommendationSeeds => emptySeeds(),
  analytics_stats: () => null,
  analytics_clear: () => undefined,

  check_update: () => (updateAvailable ? offeredUpdate() : null),
  update_status: () => (updateAvailable ? offeredUpdate() : null),
  install_update: () => undefined,

  "plugin:app|version": () => "0.2.0",
  "plugin:event|listen": ({ event, handler }) => listen(text(event), count(handler)),
  "plugin:event|unlisten": ({ event, eventId }) => {
    unregisterListener(text(event), count(eventId));
  },
  "plugin:event|emit": ({ event, payload }) => emitEvent(text(event), payload),
  "plugin:event|emit_to": ({ event, payload }) => emitEvent(text(event), payload),
  "plugin:window|is_maximized": () => false,
  "plugin:window|is_focused": () => true,
  "plugin:window|minimize": () => undefined,
  "plugin:window|toggle_maximize": () => undefined,
  "plugin:window|close": () => undefined,
  "plugin:window|destroy": () => undefined,
  "plugin:window|set_focus": () => undefined,
  // The pickers are the one thing a browser cannot stand in for, so they cancel.
  "plugin:dialog|open": () => null,
  "plugin:dialog|save": () => null,
  "plugin:opener|open_url": () => undefined,
  "plugin:opener|open_path": () => undefined,
  "plugin:opener|reveal_item_in_dir": () => undefined,
  "plugin:notification|is_permission_granted": () => false,
};

function listen(event: string, callback: number): number {
  const id = nextListener;
  nextListener += 1;
  const held = listeners.get(event) ?? new Map<number, number>();
  held.set(id, callback);
  listeners.set(event, held);
  return id;
}

function scanSummary(): ScanSummary {
  return {
    changed: structuredClone(tracks),
    removed: [],
    total: tracks.length,
    root: ROOT,
    skipped: 0,
    errors: [],
  };
}

function generate(mode: PlaylistMode, genre: string): GenerateOutcome {
  playlistCount += 1;
  const id = `pl-${playlistCount}`;
  const pending = makePending(10, 200 + playlistCount, 4_242 + playlistCount);
  const held = sliceIds(tracks, playlistCount * 5, 9, 15);

  persisted.playlists = [
    ...persisted.playlists,
    {
      id,
      name: mode === "genre" && genre ? `${genre} mix` : "For You",
      kind: "generated",
      entries: [...held, ...pending.map((entry) => entry.id)],
      trackIds: held,
      pending,
      createdAt: Date.now(),
    },
  ];
  return { playlistId: id, state: snapshot() };
}

function download(playlistId: string, entryIds: string[]): ImportOutcome {
  const playlist = persisted.playlists.find((entry) => entry.id === playlistId);
  if (!playlist) {
    return importOutcome([`No playlist with the id "${playlistId}".`]);
  }

  const wanted = entryIds.length > 0 ? new Set(entryIds) : null;
  const moving = playlist.pending.filter((entry) => wanted === null || wanted.has(entry.id));
  if (moving.length === 0) {
    return importOutcome([]);
  }

  const arrived = moving.map((entry) => trackFromPending(entry));
  const ids = new Set(arrived.map((track) => track.id));

  tracks = [...tracks, ...arrived];
  persisted.playlists = persisted.playlists.map((entry) =>
    entry.id === playlistId
      ? {
          ...entry,
          trackIds: [...entry.trackIds, ...arrived.map((track) => track.id)],
          pending: entry.pending.filter((pending) => !ids.has(pending.id)),
        }
      : entry,
  );

  return {
    songs: arrived.length,
    images: 0,
    lyrics: 0,
    skipped: 0,
    duplicates: 0,
    similar: 0,
    playlist: playlist.name,
    errors: [],
    state: snapshot(),
  };
}

function trackFromPending(entry: PendingTrack): Track {
  const folder = `${ROOT}\\${entry.albumArtist}\\${entry.album}`;
  return {
    id: entry.id,
    path: `${folder}\\${entry.title}.mp3`,
    title: entry.title,
    artist: entry.artists[0] ?? null,
    album: entry.album,
    albumArtist: entry.albumArtist,
    trackNo: entry.trackNumber,
    discNo: entry.discNumber,
    year: Number(entry.releaseDate.slice(0, 4)) || null,
    genre: entry.genres[0] ?? null,
    durationMs: entry.durationMs ?? 180_000,
    codec: "mp3",
    bitrate: 320,
    sampleRate: 44100,
    artworkPath: `${folder}\\${entry.title}.jpg`,
    lyricsPath: null,
    hasEmbeddedArt: false,
    relativePath: `${entry.album}\\${entry.title}.mp3`,
    lufs: null,
    peak: null,
    addedAt: Date.now(),
  };
}

function fetchLyrics(trackIds: string[]): LyricsOutcome {
  const wanted = new Set(trackIds);
  let fetched = 0;
  tracks = tracks.map((track) => {
    if (!wanted.has(track.id) || track.lyricsPath) {
      return track;
    }
    fetched += 1;
    return { ...track, lyricsPath: `${track.path.replace(/\.[^.]+$/, "")}.lrc` };
  });
  return {
    fetched,
    synced: fetched,
    skipped: trackIds.length - fetched,
    missing: 0,
    untagged: 0,
    errors: [],
  };
}

function fetchCovers(trackIds: string[]): CoversOutcome {
  const wanted = new Set(trackIds);
  const held = tracks.filter((track) => wanted.has(track.id));
  const missing = held.filter((track) => !track.artworkPath);
  return {
    restored: 0,
    embedded: 0,
    online: 0,
    skipped: held.length - missing.length,
    missing: missing.length,
    untagged: 0,
    errors: [],
  };
}

function fetchGenres(trackIds: string[]): GenresOutcome {
  const wanted = new Set(trackIds);
  const held = tracks.filter((track) => wanted.has(track.id));
  return {
    tagged: 0,
    skipped: held.filter((track) => track.genre).length,
    missing: 0,
    untagged: held.filter((track) => !track.artist).length,
    paused: 0,
    gaveUp: false,
    remaining: 0,
    errors: [],
  };
}

function spotifyStatus() {
  return {
    envPath: `${ROOT}\\..\\config\\.env`,
    redirectUri: "http://127.0.0.1:1420/callback",
    configured: false,
    accepted: false,
    ytDlp: false,
    ytDlpSource: "",
    ffmpeg: false,
    deno: false,
    denoSource: "",
    message: "The simulator has no Spotify credentials.",
  };
}

function toolStatus() {
  return {
    envPath: `${ROOT}\\..\\config\\.env`,
    ytDlp: false,
    ytDlpSource: "",
    ffmpeg: false,
    deno: false,
    denoSource: "",
    message: "The simulator has no download tools.",
  };
}

function plan(): ImportPlan {
  return { name: "Simulated playlist", total: 12, duplicates: 0, examples: [] };
}

function importOutcome(errors: string[]): ImportOutcome {
  return {
    songs: 0,
    images: 0,
    lyrics: 0,
    skipped: 0,
    duplicates: 0,
    similar: 0,
    playlist: null,
    errors,
    state: snapshot(),
  };
}

/** Lyrics timed against a song of at least a hundred seconds. */
function lyricsFor(trackId: string): string {
  const title = tracks.find((track) => track.id === trackId)?.title ?? "Untitled";
  const lines = [
    title,
    "The lights are on in every window",
    "and the harbour keeps its own time",
    "I counted every slow machine",
    "until the static turned to rain",
    "Nothing here is in a hurry",
    "so I let the evening run",
    "and the last of the amber",
    "faded out with the tide",
  ];
  return lines.map((line, at) => `[00:${String(at * 6 + 2).padStart(2, "0")}.00] ${line}`).join("\n");
}

/** A usable accent, kept bright enough that the app will not discard it. */
function colourFor(seed: string): string {
  const value = hashText(seed || "wave");
  const red = 80 + (value & 0x3f);
  const green = 90 + ((value >> 6) & 0x3f);
  const blue = 110 + ((value >> 12) & 0x3f);
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

function channel(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function playCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  tracks.forEach((track, at) => {
    if (at % 3 === 0) {
      counts[track.id] = 1 + ((at * 7) % 24);
    }
  });
  return counts;
}

interface RankedPlay {
  track: Track;
  plays: number;
}

interface RankedName {
  name: string;
  plays: number;
  ms: number;
}

/** The songs that have been streamed, most played first. */
function rankedPlays(): RankedPlay[] {
  const counts = playCounts();
  const ranked: RankedPlay[] = [];
  for (const [trackId, plays] of Object.entries(counts)) {
    const track = tracks.find((entry) => entry.id === trackId);
    if (track) {
      ranked.push({ track, plays });
    }
  }
  return ranked.sort((left, right) => right.plays - left.plays);
}

function topSongs(limit: number): TopSong[] {
  return rankedPlays()
    .slice(0, limit)
    .map((entry) => ({
      trackId: entry.track.id,
      title: entry.track.title,
      artist: entry.track.artist,
      album: entry.track.album,
      plays: entry.plays,
      ms: entry.plays * entry.track.durationMs,
    }));
}

function rankBy(ranked: RankedPlay[], name: (entry: RankedPlay) => string): RankedName[] {
  const groups = new Map<string, RankedName>();
  for (const entry of ranked) {
    const key = name(entry);
    const held = groups.get(key) ?? { name: key, plays: 0, ms: 0 };
    held.plays += entry.plays;
    held.ms += entry.plays * entry.track.durationMs;
    groups.set(key, held);
  }
  return [...groups.values()].sort((left, right) => right.plays - left.plays);
}

function swellSummary(from: number, to: number): SwellSummary {
  const ranked = rankedPlays();
  const plays = ranked.reduce((total, entry) => total + entry.plays, 0);
  const msListened = ranked.reduce((total, entry) => total + entry.plays * entry.track.durationMs, 0);

  const topArtists = rankBy(ranked, (entry) => entry.track.artist ?? "Unknown artist");
  const topGenres = rankBy(ranked, (entry) => entry.track.genre ?? "Unknown genre");
  const topAlbums = rankBy(ranked, (entry) => entry.track.album ?? "Unknown album");

  return {
    from,
    to,
    minutesListened: Math.round(msListened / 60_000),
    msListened,
    plays,
    listens: plays,
    uniqueTracks: ranked.length,
    uniqueArtists: topArtists.length,
    firstPlayAt: from,
    lastPlayAt: to,
    byMediaType: [{ mediaType: "music", plays, ms: msListened }],
    topSongs: topSongs(RANKED_LIMIT),
    topArtists: topArtists.map((entry) => ({ artist: entry.name, plays: entry.plays, ms: entry.ms })),
    artistSprint: topArtists.slice(0, 5).map((entry) => ({
      artist: entry.name,
      points: [
        { key: "2026-01", count: Math.max(1, Math.round(entry.plays / 4)) },
        { key: "2026-02", count: Math.max(1, Math.round(entry.plays / 3)) },
        { key: "2026-03", count: Math.max(1, Math.round(entry.plays / 2)) },
      ],
    })),
    topGenres: topGenres.map((entry) => ({ genre: entry.name, plays: entry.plays, ms: entry.ms })),
    genresExplored: topGenres.length,
    topAlbums: topAlbums.map((entry) => ({
      album: entry.name,
      albumArtist: null,
      plays: entry.plays,
      ms: entry.ms,
    })),
  };
}

function emptySeeds(): RecommendationSeeds {
  return { artists: [], genres: [], tracks: [], coPlayed: [], liked: [], skipped: [], recent: [] };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function flag(value: unknown): boolean {
  return value === true;
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
}
