import type { NowPlaying } from "../../types";

/** How much the fixture holds, for the frame's own readout. */
export interface SimSummary {
  tracks: number;
  playlists: number;
  likes: number;
}

/**
 * What the frame can ask of the page it holds. The mock installs this on
 * `window.__WAVE_SIM__`, and the frame reaches it directly because the two
 * pages are same-origin.
 */
export interface SimBridge {
  /** Delivers a Tauri event to whatever the app is listening for. */
  emit(event: string, payload?: unknown): void;
  /** Whether load_lyrics hands a song a lyric file. */
  setLyricsAvailable(on: boolean): void;
  /** The song the app last handed to the system's own controls. */
  nowPlaying(): NowPlaying | null;
  summary(): SimSummary;
}

declare global {
  interface Window {
    __WAVE_SIM__?: SimBridge;
  }
}
