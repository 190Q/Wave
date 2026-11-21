import type { AudioCut } from "../types";
import { parseLrc } from "./lrc";

export interface EditableLyric {
  timeMs: number | null;
  text: string;
}

export interface EditableLyrics {
  metadata: string[];
  lines: EditableLyric[];
}

export function readEditableLyrics(source: string): EditableLyrics {
  const metadata: string[] = [];
  const lines: EditableLyric[] = [];
  const offset = source.match(/\[offset:\s*[+-]?\d+\s*\]/i)?.[0] ?? "";
  for (const raw of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (/^\s*\[offset:/i.test(raw)) continue;
    if (/^\s*\[[a-z][a-z0-9]*:/i.test(raw) && !/^\s*\[\d/.test(raw)) {
      metadata.push(raw);
      continue;
    }
    let timed = parseLrc(`${offset}\n${raw}`);
    if (timed.length === 0 && /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(raw)) {
      timed = parseLrc(`${offset}\n${raw} _`).map((line) => ({ ...line, text: "" }));
    }
    if (timed.length > 0) {
      lines.push(...timed);
    } else if (raw.trim()) {
      lines.push({ timeMs: null, text: raw });
    }
  }
  return { metadata, lines };
}

export function formatEditTime(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor(value % 60_000 / 1000);
  const fraction = value % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(3, "0")}`;
}

export function parseEditTime(value: string): number | null {
  const match = /^(\d{1,3}):([0-5]?\d)(?:[.:](\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  return (Number(match[1]) * 60 + Number(match[2])) * 1000
    + Number((match[3] ?? "").padEnd(3, "0"));
}

export function validateCuts(cuts: AudioCut[], durationMs: number): string | null {
  let previousEnd = 0;
  for (const cut of [...cuts].sort((a, b) => a.startMs - b.startMs)) {
    if (!Number.isFinite(cut.startMs) || !Number.isFinite(cut.endMs)
      || cut.startMs < previousEnd || cut.startMs < 0 || cut.endMs <= cut.startMs || cut.endMs > durationMs) {
      return "Cut ranges must be within the audio and must not overlap.";
    }
    previousEnd = cut.endMs;
  }
  if (cuts.reduce((total, cut) => total + cut.endMs - cut.startMs, 0) >= durationMs && cuts.length > 0) {
    return "The cuts cannot remove the entire song.";
  }
  return null;
}

export function timeAfterCuts(timeMs: number, cuts: AudioCut[]): number {
  let removed = 0;
  for (const cut of [...cuts].sort((a, b) => a.startMs - b.startMs)) {
    if (timeMs <= cut.startMs) break;
    removed += Math.min(timeMs, cut.endMs) - cut.startMs;
  }
  return Math.max(0, timeMs - removed);
}

export function writeEditableLyrics(lyrics: EditableLyrics, cuts: AudioCut[] = []): string {
  const lines = lyrics.lines.map((line) => line.timeMs === null
    ? line.text
    : `[${formatEditTime(timeAfterCuts(line.timeMs, cuts))}]${line.text}`);
  return [...lyrics.metadata, ...lines].join("\n").trimEnd() + "\n";
}
