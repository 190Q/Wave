import type { SimBridge } from "./bridge";
import {
  convertFileSrc,
  emitEvent,
  invokeCommand,
  nowPlaying,
  registerCallback,
  setLyricsAvailable,
  setUpdateAvailable,
  summary,
  unregisterCallback,
  unregisterListener,
} from "./commands";

/** What @tauri-apps/api reaches for on `window`. */
interface TauriInternals {
  invoke(command: string, args?: Record<string, unknown>, options?: unknown): Promise<unknown>;
  convertFileSrc(path: string, protocol?: string): string;
  transformCallback(callback: (payload: unknown) => void, once?: boolean): number;
  unregisterCallback(id: number): void;
  metadata: {
    currentWindow: { label: string };
    currentWebview: { label: string };
  };
}

const internals: TauriInternals = {
  invoke: (command, args = {}) => invokeCommand(command, args),
  convertFileSrc: (path) => convertFileSrc(path),
  transformCallback: (callback, once = false) => registerCallback(callback, once),
  unregisterCallback: (id) => unregisterCallback(id),
  metadata: {
    currentWindow: { label: "main" },
    currentWebview: { label: "main" },
  },
};

const bridge: SimBridge = {
  emit: emitEvent,
  setLyricsAvailable,
  setUpdateAvailable,
  nowPlaying,
  summary,
};

/**
 * Stands in for the Tauri runtime so the real front end boots in a plain
 * browser. Importing this module installs it, which is what keeps the order
 * right when the simulator's entry imports main.ts next.
 */
export function installStub(): void {
  const target = window as unknown as Record<string, unknown>;
  if (target.__TAURI_INTERNALS__) {
    return;
  }
  target.__TAURI_INTERNALS__ = internals;
  target.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener };
  window.__WAVE_SIM__ = bridge;
}

installStub();
