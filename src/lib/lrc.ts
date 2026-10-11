import type { LyricLine } from "../types";

/** `[mm:ss]`, `[mm:ss.xx]` and `[mm:ss:xx]` all appear in the wild. */
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const OFFSET_TAG = /\[offset:\s*([+-]?\d+)\s*\]/i;

export function parseLrc(source: string): LyricLine[] {
  const offset = source.match(OFFSET_TAG);
  const offsetMs = offset ? Number(offset[1]) : 0;

  const lines: LyricLine[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const tags = [...raw.matchAll(TIME_TAG)];
    if (tags.length === 0) {
      continue;
    }

    const text = raw.replace(TIME_TAG, "").trim();
    if (!text) {
      continue;
    }

    for (const tag of tags) {
      const minutes = Number(tag[1]);
      const seconds = Number(tag[2]);
      // `[00:12.5]` is half a second, `[00:12.50]` is fifty hundredths.
      const fraction = tag[3] ? Number(`0.${tag[3]}`) : 0;
      lines.push({
        timeMs: Math.max(0, (minutes * 60 + seconds + fraction) * 1000 - offsetMs),
        text,
      });
    }
  }

  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

/** Index of the line that should be highlighted, or -1 before the first one. */
export function activeLyricIndex(lines: LyricLine[], positionMs: number): number {
  let active = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].timeMs <= positionMs) {
      active = index;
    } else {
      break;
    }
  }
  return active;
}
