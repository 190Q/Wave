import type { Playback, Session } from "../types";

export const SESSION_RECOVERY_KEY = "wave:session-recovery";

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validPlayback(value: unknown): value is Playback {
  if (!value || typeof value !== "object") return false;
  const playback = value as Playback;
  return (playback.sourceId === null || typeof playback.sourceId === "string") &&
    typeof playback.sourceName === "string" && strings(playback.sourceOrder) &&
    strings(playback.order) && Number.isSafeInteger(playback.cursor) && playback.cursor >= 0 &&
    (playback.order.length === 0 ? playback.cursor === 0 : playback.cursor < playback.order.length) &&
    Number.isFinite(playback.positionMs) && playback.positionMs >= 0 &&
    typeof playback.shuffle === "boolean" && ["off", "all"].includes(playback.repeat) &&
    typeof playback.muted === "boolean";
}

export function readSessionRecovery(storage: Storage): Session | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(SESSION_RECOVERY_KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const session = value as Partial<Session>;
    const collections = session.collectionPlayback;
    if (
      !Number.isSafeInteger(session.savedAt) || (session.savedAt ?? 0) <= 0 ||
      !validPlayback(session.playback) ||
      (collections !== undefined && (!collections || typeof collections !== "object" ||
        Array.isArray(collections) || !Object.values(collections).every(validPlayback))) ||
      !strings(session.recents) ||
      typeof session.filter !== "string" || typeof session.sort !== "string" ||
      typeof session.queueOpen !== "boolean"
    ) {
      return null;
    }
    return session as Session;
  } catch {
    return null;
  }
}

export function newestSession(saved: Session | undefined, recovery: Session | null): Session | undefined {
  return recovery && (recovery.savedAt ?? 0) > (saved?.savedAt ?? 0) ? recovery : saved;
}
