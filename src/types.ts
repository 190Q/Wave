export interface Track {
  id: string;
  path: string;
  fileName: string;
  title: string;
  /** `null` when the file carries no tag. Never guessed. */
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  genre: string | null;
  durationMs: number;
  codec: string;
  bitrate: number | null;
  sampleRate: number | null;
  /** Copied sidecar image if the index has one, otherwise extracted tag art. */
  artworkPath: string | null;
  /** Copied lyrics sidecar if the index has one. */
  lyricsPath: string | null;
  hasEmbeddedArt: boolean;
  relativePath: string;
}

export interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
  createdAt: number;
}

export interface Settings {
  /** `adaptive`, or a `#rrggbb` the user picked. */
  theme: string;
  volume: number;
  /** The last few custom accents, most recent first. */
  recentColours: string[];
  /** Restores the queue, cursor and position on the next launch. */
  resumeOnLaunch: boolean;
  /** Overrides the system animation preference. */
  reduceMotion: ReduceMotionMode;
  /** Remembers the window size and position between launches. */
  rememberWindow: boolean;
  /** Keeps the window above the others. Toggled by `t`. */
  alwaysOnTop: boolean;
  /** The smallest frame, in a corner of the screen, above the others. */
  miniPlayer: boolean;
  /** Which corner the mini player sits in: 1 to 4, clockwise from the top left. */
  miniCorner: number;
  /** Which matcher every search field uses. */
  searchAlgorithm: SearchAlgorithm;
  /** Nine `Ctrl+Shift+1..9` slots, an action id each. Saved, not yet wired. */
  shortcutSlots: string[];
}

/** How the OS animation preference is treated. */
export type ReduceMotionMode = "system" | "on" | "off";

/** The matchers offered for the search fields. */
export type SearchAlgorithm =
  | "exact"
  | "substring"
  | "prefix"
  | "fuzzy"
  | "ngram"
  | "indexed"
  | "phonetic";

/** The playback session, so a restart resumes where the user left off. */
export interface Playback {
  sourceId: string | null;
  sourceName: string;
  sourceOrder: string[];
  order: string[];
  cursor: number;
  positionMs: number;
  shuffle: boolean;
  repeat: RepeatMode;
  muted: boolean;
}

/** The parts of the browsing session worth remembering between launches. */
export interface Session {
  playback: Playback;
  recents: string[];
  filter: CollectionFilter;
  sort: "name" | "size";
  queueOpen: boolean;
}

/** Which part of a saved window frame a `Ctrl+Shift+<slot>` snap restores. */
export type SnapPart = "frame" | "size" | "position";

/** Where the window sat when it was last closed. */
export interface WindowGeometry {
  width: number;
  height: number;
  x: number;
  y: number;
  monitor: string | null;
  maximized: boolean;
}

export interface PersistedState {
  settings: Settings;
  playlists: Playlist[];
  likes: string[];
  /** Track id -> `#rrggbb`. */
  artworkColours: Record<string, string>;
  session: Session;
  window: WindowGeometry | null;
  windowSlots: (WindowGeometry | null)[];
}

export interface ScanSummary {
  tracks: Track[];
  root: string;
  skipped: number;
  errors: string[];
}

export interface ImportOutcome {
  songs: number;
  images: number;
  lyrics: number;
  skipped: number;
  playlist: string | null;
  errors: string[];
  state: PersistedState;
}

export type RepeatMode = "off" | "all";

export type CollectionKind = "all" | "liked" | "playlist" | "artist" | "album";

export interface Collection {
  id: string;
  kind: CollectionKind;
  name: string;
  subtitle: string;
  trackIds: string[];
}

export interface LyricLine {
  timeMs: number;
  text: string;
}

/** Which slice of the library the sheet is showing. */
export type CollectionFilter = "all" | "playlists" | "artists" | "albums";

export interface ThemeDefinition {
  id: string;
  name: string;
  /** `null` means "follow the current track's artwork". */
  colour: string | null;
}
