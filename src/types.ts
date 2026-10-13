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
  /** Integrated loudness in LUFS, `null` until the song has been measured. */
  lufs: number | null;
  /** True peak, linear: `1` is full scale. */
  peak: number | null;
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
  /** Levels every song to the same loudness when it plays. */
  normalizeVolume: boolean;
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
  /** The last few imports, newest first. */
  recentImports: ImportRecord[];
  /** The last Spotify setup answer, so a restart does not start from nothing. */
  spotify: SpotifyStatus | null;
}

/** One entry in the import history. */
export interface ImportRecord {
  /** Where it came from. */
  source: "spotify" | "folder";
  /** The playlist or folder it brought in. */
  name: string;
  /** A short summary, such as `12 songs`. */
  detail: string;
}

/** What the backend reports about the Spotify credentials and the tools. */
export interface SpotifyStatus {
  /** Where the config `.env` has to live. */
  envPath: string;
  /** The Redirect URI the Spotify app has to list, character for character. */
  redirectUri: string;
  /** Both variables are present in the file. */
  configured: boolean;
  /** Spotify accepted the client ID and secret. */
  accepted: boolean;
  ytDlp: boolean;
  /** How yt-dlp was found, empty when it was not. */
  ytDlpSource: string;
  ffmpeg: boolean;
  /** What to tell the user, in one line. */
  message: string;
}

/** How far along a Spotify import is. */
export interface ImportProgress {
  phase:
    | "authorising"
    | "resolving"
    | "downloading"
    | "importing"
    | "lyrics"
    | "covers"
    | "done"
    | "failed";
  /** Tracks handled so far, including the one underway. */
  done: number;
  total: number;
  /** The track being worked on. */
  label: string;
  message: string;
  failures: string[];
  /** Tracks left alone because the library already had them. */
  reused: number;
}

/** How a lyrics fetch went. */
export interface LyricsOutcome {
  /** Looked up and written. */
  fetched: number;
  /** Of those, the ones with timings, which the player can scroll. */
  synced: number;
  /** Already had lyrics, so they were left alone. */
  skipped: number;
  /** LRCLIB had nothing for them. */
  missing: number;
  /** No artist tag to look them up by. */
  untagged: number;
  errors: string[];
}

/** How a covers fetch went. */
export interface CoversOutcome {
  /** Written and linked. */
  restored: number;
  /** Of those, the ones the file already carried. */
  embedded: number;
  /** Of those, fetched from a service. */
  online: number;
  /** Already had a cover, so they were left alone. */
  skipped: number;
  /** Nothing found anywhere. */
  missing: number;
  /** No artist to look them up by. */
  untagged: number;
  errors: string[];
}

/** What a Spotify link holds, and how much of it the library already has. */
export interface ImportPlan {
  name: string;
  total: number;
  /** Tracks matched in the library on title, artist and album. */
  duplicates: number;
  /** A few of them, so the prompt can name what it found. */
  examples: string[];
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

/** One song's loudness, sent as soon as it is measured. */
export interface LoudnessUpdate {
  id: string;
  lufs: number;
  peak: number;
  /** Songs handled so far, including this one. */
  done: number;
  /** How many songs needed a reading when the pass started. */
  total: number;
  /** Songs the library already had a reading for. */
  skipped: number;
  failures: string[];
}

/** How a loudness pass went. */
export interface LoudnessOutcome {
  /** Measured this time. */
  measured: number;
  /** Left alone, because the library already had a reading for them. */
  skipped: number;
  failures: string[];
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
