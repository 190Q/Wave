/** `3:07`, or `0:00` for anything unusable. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0:00";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  const word = count === 1 ? singular : (pluralForm ?? `${singular}s`);
  return `${count} ${word}`;
}

export function songCount(count: number): string {
  return plural(count, "song");
}

/** `1 hr 4 min`, for collection totals. */
export function formatTotalDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0 min";
  }
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `${minutes} min`;
  }
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
}

/** Titles, artists and folder names all come from files we do not control. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Joins the non-empty parts, for `artist, album, year` style meta lines. */
export function joinMeta(parts: (string | number | null | undefined)[], separator = ", "): string {
  return parts
    .filter((part) => part !== null && part !== undefined && String(part).trim() !== "")
    .join(separator);
}
