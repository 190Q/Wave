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
  theme: string;
  volume: number;
}

export interface PersistedState {
  settings: Settings;
  playlists: Playlist[];
  likes: string[];
  /** Track id -> `#rrggbb`. */
  artworkColors: Record<string, string>;
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
export type CollectionFilter = "all" | "liked" | "playlists" | "artists" | "albums";

export interface ThemeDefinition {
  id: string;
  name: string;
  /** `null` means "follow the current track's artwork". */
  color: string | null;
}
