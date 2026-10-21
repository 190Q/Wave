import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

import type {
  AnalyticsEvent,
  AnalyticsStats,
  CoversOutcome,
  DeezerStatus,
  GenerateOutcome,
  GenresOutcome,
  ImportOutcome,
  ImportPlan,
  LibraryInfo,
  LoudnessOutcome,
  LyricsOutcome,
  PersistedState,
  PlayRecord,
  PlaylistMode,
  RecommendationSeeds,
  RecommendStatus,
  ScanSummary,
  Session,
  Settings,
  SnapPart,
  SpotifyStatus,
  SwellBucket,
  SwellSummary,
  TopSong,
  TrackSnapshot,
  YoutubeStatus,
} from "../types";


export function loadState(): Promise<PersistedState> {
  return invoke("get_state");
}

export function saveSettings(settings: Settings): Promise<PersistedState> {
  return invoke("set_settings", { settings });
}

/** Persists the playback and browsing session. */
export function saveSession(session: Session): Promise<PersistedState> {
  return invoke("set_session", { session });
}

/** Remembers the current window size and position for the next launch. */
export function saveWindowGeometry(): Promise<void> {
  return invoke("save_window_geometry");
}

/** Forgets the remembered window geometry, so the defaults apply again. */
export function resetWindowGeometry(): Promise<void> {
  return invoke("reset_window_geometry");
}

/** Remembers the window's current frame against a `Ctrl+Shift+1..9` slot. */
export function saveWindowSlot(slot: number): Promise<PersistedState> {
  return invoke("save_window_slot", { slot });
}

/** Snaps the window back to the frame saved against a slot, or to one half of it. */
export function applyWindowSlot(slot: number, part: SnapPart): Promise<void> {
  return invoke("apply_window_slot", { slot, part });
}

/** Moves the mini player into a corner, without changing the mini player setting. */
export function placeMiniPlayer(corner: number): Promise<PersistedState> {
  return invoke("place_mini_player", { corner });
}

/** Reveals the main window once the shell is ready to be seen. */
export function showMainWindow(): Promise<void> {
  return invoke("show_main_window");
}

export function createPlaylist(name: string): Promise<PersistedState> {
  return invoke("create_playlist", { name });
}

export function renamePlaylist(id: string, name: string): Promise<PersistedState> {
  return invoke("rename_playlist", { id, name });
}

export function deletePlaylist(id: string): Promise<PersistedState> {
  return invoke("delete_playlist", { id });
}

/** Whether the listening record holds enough to generate a playlist from. */
export function recommendStatus(): Promise<RecommendStatus> {
  return invoke("recommend_status");
}

/** Fills a new playlist from the catalogue, by taste or by one genre. */
export function generatePlaylist(mode: PlaylistMode, genre: string | null): Promise<GenerateOutcome> {
  return invoke("generate_playlist", { mode, genre });
}

/** Downloads a generated playlist's pending entries. An empty list means all of them. */
export function downloadPlaylist(playlistId: string, entryIds: string[]): Promise<ImportOutcome> {
  return invoke("download_playlist", { playlistId, entryIds });
}

export function addToPlaylist(id: string, trackIds: string[]): Promise<PersistedState> {
  return invoke("add_to_playlist", { id, trackIds });
}

export function removeFromPlaylist(id: string, trackIds: string[]): Promise<PersistedState> {
  return invoke("remove_from_playlist", { id, trackIds });
}

export function reorderPlaylist(id: string, trackIds: string[]): Promise<PersistedState> {
  return invoke("reorder_playlist", { id, trackIds });
}

export function toggleLike(trackId: string): Promise<PersistedState> {
  return invoke("toggle_like", { trackId });
}

/** Likes or unlikes several songs in one write. */
export function setLikes(trackIds: string[], liked: boolean): Promise<PersistedState> {
  return invoke("set_likes", { trackIds, liked });
}

/** Deletes songs from the library, with their copies and their playlist entries. */
export function deleteTracks(trackIds: string[]): Promise<PersistedState> {
  return invoke("delete_tracks", { trackIds });
}

export function scanLibrary(): Promise<ScanSummary> {
  return invoke("scan_library");
}

/** What the library holds on disk, for the settings panel. */
export function libraryInfo(): Promise<LibraryInfo> {
  return invoke("library_info");
}

/** Opens the library folder in the file manager of whatever system this is. */
export function openLibraryFolder(): Promise<void> {
  return invoke("open_library_folder");
}

/** Measures the loudness of the given songs, so playback can level them. */
export function analyseLoudness(trackIds: string[]): Promise<LoudnessOutcome> {
  return invoke("analyse_loudness", { trackIds });
}

export function importFolder(
  folder: string,
  createPlaylist: boolean,
  playlistName: string | null,
): Promise<ImportOutcome> {
  return invoke("import_folder", { folder, createPlaylist, playlistName });
}

/** Reads the config and asks Spotify whether the credentials work. */
export function spotifyStatus(): Promise<SpotifyStatus> {
  return invoke("spotify_status");
}

/** Opens the folder holding the config `.env`, writing the template first. */
export function openSpotifyConfig(): Promise<void> {
  return invoke("open_spotify_config");
}

/**
 * Reads a Spotify link and reports which of its tracks the library already has,
 * so the dialog can ask about them before anything is downloaded.
 */
export function spotifyPlan(url: string): Promise<ImportPlan> {
  return invoke("spotify_plan", { url });
}

/** Downloads a Spotify playlist or track into the library. */
export function importSpotify(url: string, downloadDuplicates: boolean): Promise<ImportOutcome> {
  return invoke("spotify_import", { url, downloadDuplicates });
}

/** Reads the config and reports what Deezer needs: the download tools, nothing else. */
export function deezerStatus(): Promise<DeezerStatus> {
  return invoke("deezer_status");
}

/**
 * Reads a Deezer link and reports which of its tracks the library already has,
 * so the dialog can ask about them before anything is downloaded.
 */
export function deezerPlan(url: string): Promise<ImportPlan> {
  return invoke("deezer_plan", { url });
}

/** Downloads a Deezer playlist, album or track into the library. */
export function importDeezer(url: string, downloadDuplicates: boolean): Promise<ImportOutcome> {
  return invoke("deezer_import", { url, downloadDuplicates });
}

/**
 * Reads a YouTube link and reports which of its videos the library already has.
 */
export function youtubePlan(url: string): Promise<ImportPlan> {
  return invoke("youtube_plan", { url });
}

/** Downloads the exact videos a pasted YouTube link points at. */
export function importYoutube(url: string, downloadDuplicates: boolean): Promise<ImportOutcome> {
  return invoke("youtube_import", { url, downloadDuplicates });
}

/** Reads the config and reports what a pasted link needs: the download tools. */
export function youtubeStatus(): Promise<YoutubeStatus> {
  return invoke("youtube_status");
}

export async function pickWaveList(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    title: "Import a Wave playlist",
    filters: [{ name: "Wave playlist", extensions: ["wavelist"] }],
  });
  return typeof selected === "string" ? selected : null;
}

export function importWaveList(path: string): Promise<ImportOutcome> {
  return invoke("import_wavelist", { path });
}

export async function exportWaveList(name: string, trackIds: string[]): Promise<number | null> {
  const safeName = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "") || "Playlist";
  const path = await save({
    title: "Export a Wave playlist",
    defaultPath: `${safeName}.wavelist`,
    filters: [{ name: "Wave playlist", extensions: ["wavelist"] }],
  });
  if (!path) {
    return null;
  }
  return invoke("export_wavelist", { path, name, trackIds });
}

/** Looks lyrics up for the given songs and files them with the library. */
export function fetchLyrics(trackIds: string[]): Promise<LyricsOutcome> {
  return invoke("fetch_lyrics", { trackIds });
}

/** Restores missing cover art for the given songs. */
export function fetchCovers(trackIds: string[]): Promise<CoversOutcome> {
  return invoke("fetch_covers", { trackIds });
}

/** Looks the genre of the given songs up and writes it into their files. */
export function fetchGenres(trackIds: string[]): Promise<GenresOutcome> {
  return invoke("fetch_genres", { trackIds });
}

export function artworkColour(trackId: string, path: string): Promise<string> {
  return invoke("artwork_colour", { trackId, path });
}

export function loadLyrics(trackId: string): Promise<string | null> {
  return invoke("load_lyrics", { trackId });
}

/** Native folder picker. Returns `null` when the user cancels. */
export async function pickFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Add a music folder",
  });
  return typeof selected === "string" ? selected : null;
}

/** Raw artwork bytes, delivered over IPC rather than as a file URL. */
export function artworkBytes(path: string): Promise<ArrayBuffer> {
  return invoke("artwork_bytes", { path });
}

/** Composed cover for a collection, from up to four artwork paths. */
export function coverBytes(paths: string[]): Promise<ArrayBuffer> {
  return invoke("cover_bytes", { paths });
}

export function rememberTracks(tracks: TrackSnapshot[]): Promise<void> {
  return invoke("analytics_remember_tracks", { tracks });
}

/** Writes a listen, or updates the row the same listen already has. */
export function recordPlay(play: PlayRecord): Promise<void> {
  return invoke("analytics_record_play", { play });
}

/** Records signals that are not plays: likes, playlist edits and the like. */
export function recordAnalyticsEvents(events: AnalyticsEvent[]): Promise<void> {
  return invoke("analytics_record_events", { events });
}

export function analyticsSwell(
  from: number,
  to: number,
  bucket: SwellBucket,
): Promise<SwellSummary> {
  return invoke("analytics_swell", { from, to, bucket });
}

/** The ranked songs in a window, each with its stream count. */
export function analyticsTopSongs(
  from: number,
  to: number,
  limit?: number,
): Promise<TopSong[]> {
  return invoke("analytics_top_songs", { from, to, limit });
}

/** The affinity data a recommender would start from. */
export function analyticsRecommendationSeeds(limit?: number): Promise<RecommendationSeeds> {
  return invoke("analytics_recommendation_seeds", { limit });
}

/** What the local listening record holds. */
export function analyticsStats(): Promise<AnalyticsStats> {
  return invoke("analytics_stats");
}

/** Drops every row of the listening record. */
export function clearAnalytics(): Promise<void> {
  return invoke("analytics_clear");
}
