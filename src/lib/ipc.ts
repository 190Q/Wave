import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import type { ImportOutcome, PersistedState, ScanSummary, Settings } from "../types";


export function loadState(): Promise<PersistedState> {
  return invoke("get_state");
}

export function saveSettings(settings: Settings): Promise<PersistedState> {
  return invoke("set_settings", { settings });
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

export function scanLibrary(): Promise<ScanSummary> {
  return invoke("scan_library");
}

export function importFolder(
  folder: string,
  createPlaylist: boolean,
  playlistName: string | null,
): Promise<ImportOutcome> {
  return invoke("import_folder", { folder, createPlaylist, playlistName });
}

export function artworkColor(trackId: string, path: string): Promise<string> {
  return invoke("artwork_color", { trackId, path });
}

export function loadLyrics(path: string): Promise<string | null> {
  return invoke("load_lyrics", { path });
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
