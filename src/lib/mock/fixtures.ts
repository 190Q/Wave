import type {
  ImportRecord,
  PendingTrack,
  PersistedState,
  Playlist,
  Session,
  Settings,
  Track,
  WindowGeometry,
} from "../../types";
import { hashText } from "./hash";

/** The folder the fixture pretends to have been scanned from. */
export const ROOT = "D:\\music";

/** When the first song in the fixture was filed, so the orders have a spread. */
const ADDED_BASE = Date.UTC(2026, 0, 5);

const ADJECTIVES = [
  "Paper",
  "Slow",
  "Neon",
  "Golden",
  "Hollow",
  "Silver",
  "Quiet",
  "Electric",
  "Bitter",
  "Velvet",
  "Faded",
  "Crimson",
  "Distant",
  "Amber",
  "Crooked",
  "Silent",
  "Restless",
  "Marble",
  "Copper",
  "Wild",
  "Frozen",
  "Open",
  "Little",
  "Blue",
];

const NOUNS = [
  "Cities",
  "Machines",
  "Harbour",
  "Halo",
  "Static",
  "Orchard",
  "Signal",
  "Lanterns",
  "River",
  "Rooftops",
  "Letters",
  "Mirage",
  "Compass",
  "Rain",
  "Anchor",
  "Windows",
  "Meadow",
  "Parade",
  "Tunnel",
  "Ferry",
  "Embers",
  "Cassette",
  "Antenna",
  "Cathedral",
];

const CODECS = ["mp3", "flac", "m4a", "opus", "ogg"];

interface AlbumPlan {
  artist: string;
  album: string;
  genre: string;
  year: number;
  tracks: number;
}

const PLAN: AlbumPlan[] = [
  { artist: "Vela Nova", album: "Neon Harbour", genre: "Synthwave", year: 2023, tracks: 44 },
  { artist: "Vela Nova", album: "Midnight Transit", genre: "Synthwave", year: 2025, tracks: 38 },
  { artist: "Hollow Coast", album: "Salt and Static", genre: "Indie Rock", year: 2021, tracks: 46 },
  { artist: "Marisol Reyes", album: "Cafe Aurora", genre: "Latin Jazz", year: 2019, tracks: 40 },
  { artist: "The Paper Lanterns", album: "Small Hours", genre: "Indie Pop", year: 2024, tracks: 42 },
  { artist: "Oren Vask", album: "Long Exposure", genre: "Ambient", year: 2018, tracks: 36 },
  { artist: "Ashgrove", album: "Riverbend", genre: "Folk", year: 2022, tracks: 48 },
];

const PENDING_ARTISTS = ["Nadia Bright", "Coastal Kids", "Rue Marlow", "The Long Way Round"];
const PENDING_ALBUMS = ["Afterglow", "Both Sides", "Paper Weather", "Night Ferry"];
const PENDING_GENRES = ["Dream Pop", "Shoegaze", "Downtempo", "Alt Country"];

/** The settings a fresh library starts from, mirrored from the real defaults. */
function defaultSettings(): Settings {
  return {
    theme: "adaptive",
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
    systemMediaControls: true,
    discordPresence: false,
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
  };
}

/** The whole fixture, built once when the stub is installed. */
export function buildFixture(tracks: Track[]): PersistedState {
  return {
    settings: defaultSettings(),
    playlists: buildPlaylists(tracks),
    likes: tracks.filter((_, at) => at % 11 === 3).map((track) => track.id),
    artworkColours: {},
    session: buildSession(tracks),
    window: null,
    windowSlots: [],
    recentImports: buildImports(),
    spotify: null,
    update: null,
  };
}

export function buildTracks(): Track[] {
  const tracks: Track[] = [];
  for (const plan of PLAN) {
    const titles = makeTitles(hashText(plan.album), plan.tracks);
    const discs = plan.tracks > 40 ? 2 : 1;
    const perDisc = Math.ceil(plan.tracks / discs);
    for (const [at, title] of titles.entries()) {
      tracks.push(makeTrack(plan, title, at, perDisc, tracks.length));
    }
  }
  return tracks;
}

function makeTrack(plan: AlbumPlan, title: string, at: number, perDisc: number, index: number): Track {
  const id = `t-${String(index + 1).padStart(4, "0")}`;
  const codec = CODECS[index % CODECS.length];
  const trackNo = (at % perDisc) + 1;
  const discNo = Math.floor(at / perDisc) + 1;
  const folder = `${ROOT}\\${plan.artist}\\${plan.album}`;
  const name = `${String(trackNo).padStart(2, "0")} ${title}`;

  return {
    id,
    path: `${folder}\\${name}.${codec}`,
    title,
    artist: plan.artist,
    album: plan.album,
    albumArtist: plan.artist,
    trackNo,
    discNo,
    year: plan.year,
    genre: plan.genre,
    durationMs: 100_000 + ((index * 7919) % 230_000),
    codec,
    bitrate: codec === "flac" ? 1411 : 320,
    sampleRate: index % 3 === 0 ? 48000 : 44100,
    artworkPath: `${folder}\\${name}.jpg`,
    lyricsPath: index % 4 === 0 ? `${folder}\\${name}.lrc` : null,
    hasEmbeddedArt: false,
    relativePath: `${plan.album}\\${name}.${codec}`,
    lufs: null,
    peak: null,
    addedAt: ADDED_BASE + index * 12 * 3_600_000,
  };
}

function buildPlaylists(tracks: Track[]): Playlist[] {
  const created = Date.UTC(2026, 1, 2);

  const late = sliceIds(tracks, 3, 5, 18);
  const focus = sliceIds(tracks, 17, 7, 24);
  const sunday = sliceIds(tracks, 41, 3, 12);

  // A generated playlist holds what was downloaded plus what is still pending.
  const pending = makePending(12, 0);
  const downloaded = sliceIds(tracks, 8, 11, 18);

  return [
    makePlaylist("pl-late-night", "Late Night Drive", "custom", late, [], created),
    makePlaylist("pl-focus", "Focus", "custom", focus, [], created + 86_400_000),
    makePlaylist("pl-sunday", "Sunday Morning", "custom", sunday, [], created + 172_800_000),
    makePlaylist(
      "pl-for-you",
      "For You",
      "generated",
      downloaded,
      pending,
      created + 259_200_000,
    ),
  ];
}

function makePlaylist(
  id: string,
  name: string,
  kind: Playlist["kind"],
  trackIds: string[],
  pending: PendingTrack[],
  createdAt: number,
): Playlist {
  const entries = [...trackIds, ...pending.map((entry) => entry.id)];
  return { id, name, kind, entries, trackIds, pending, createdAt };
}

/** Pending entries, so one playlist has rows that have not been downloaded. */
export function makePending(count: number, offset: number, seed = 90_210): PendingTrack[] {
  const titles = makeTitles(seed, count);
  return titles.map((title, at) => {
    const artist = PENDING_ARTISTS[at % PENDING_ARTISTS.length];
    const album = PENDING_ALBUMS[at % PENDING_ALBUMS.length];
    return {
      id: `p-${String(offset + at + 1).padStart(3, "0")}`,
      title,
      artists: [artist],
      album,
      albumArtist: artist,
      genres: [PENDING_GENRES[at % PENDING_GENRES.length]],
      isrc: `SIM${String(offset + at).padStart(6, "0")}`,
      coverUrl: null,
      coverPath: `${ROOT}\\${artist}\\${album}\\${title}.jpg`,
      releaseDate: `${2019 + (at % 6)}-0${(at % 9) + 1}-1${at % 9}`,
      trackNumber: at + 1,
      discNumber: 1,
      durationMs: 120_000 + ((at * 3701) % 200_000),
    };
  });
}

function buildSession(tracks: Track[]): Session {
  const order = sliceIds(tracks, 0, 1, 60);
  return {
    playback: {
      sourceId: "all",
      sourceName: "All songs",
      sourceOrder: order,
      order,
      cursor: 0,
      positionMs: 0,
      shuffle: false,
      repeat: "off",
      muted: false,
    },
    recents: ["pl-late-night", "album:neon harbour"],
    filter: "all",
    sort: "name",
    queueOpen: false,
  };
}

function buildImports(): ImportRecord[] {
  return [
    { source: "folder", name: `${ROOT}\\Inbox`, detail: "38 songs" },
    { source: "spotify", name: "Late Night Drive", detail: "18 songs, 2 duplicates skipped" },
  ];
}

/** `count` ids taken from `start`, stepping by `step` and never repeating one. */
export function sliceIds(tracks: Track[], start: number, step: number, count: number): string[] {
  const ids: string[] = [];
  for (let at = 0; ids.length < count && at < tracks.length * 2; at += 1) {
    const id = tracks[(start + at * step) % tracks.length].id;
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/** Unique, real-looking titles, from a seeded shuffle of the two word lists. */
export function makeTitles(seed: number, count: number): string[] {
  const random = mulberry32(seed);
  const used = new Set<string>();
  const titles: string[] = [];

  while (titles.length < count) {
    const title = `${ADJECTIVES[Math.floor(random() * ADJECTIVES.length)]} ${
      NOUNS[Math.floor(random() * NOUNS.length)]
    }`;
    if (used.has(title)) {
      continue;
    }
    used.add(title);
    titles.push(title);
  }
  return titles;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** A frame the window slots can hold, so a snap has something to restore. */
export function savedFrame(at: number): WindowGeometry {
  return {
    width: 1180,
    height: 760,
    x: 80 + at * 24,
    y: 60 + at * 24,
    monitor: null,
    maximized: false,
  };
}
