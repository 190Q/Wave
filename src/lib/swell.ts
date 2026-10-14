import { analyticsSwell } from "./ipc";
import type { ArtistSprint, SwellBucket, SwellPeriod, SwellSummary } from "../types";

/** What the feature is called. */
export const SWELL_NAME = "Wave Swell";

/** The periods the pane offers, shortest first. */
export const SWELL_PERIODS: SwellPeriod[] = ["month", "year", "all"];

/** A window is worth showing once it has either of these. */
export const SWELL_MIN_STREAMS = 20;
export const SWELL_MIN_MS = 30 * 60_000;

export interface SwellWindow {
  period: SwellPeriod;
  /** Epoch milliseconds, inclusive. */
  from: number;
  /** Epoch milliseconds, exclusive. */
  to: number;
  /** How the sprint chart groups the window. */
  bucket: SwellBucket;
}

export interface SwellLoad {
  summaries: Partial<Record<SwellPeriod, SwellSummary>>;
  /** The shortest period that has enough to show, or `year` when none has. */
  period: SwellPeriod;
}

/** One bar of the sprint chart. */
export interface SprintBar {
  key: string;
  count: number;
  /** `0` to `1` of the tallest bar anywhere in the chart. */
  fraction: number;
}

export function swellWindow(period: SwellPeriod, now: Date = new Date()): SwellWindow {
  switch (period) {
    case "month": {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return { period, from: from.getTime(), to: to.getTime(), bucket: "day" };
    }
    case "year": {
      const from = new Date(now.getFullYear(), 0, 1);
      const to = new Date(now.getFullYear() + 1, 0, 1);
      return { period, from: from.getTime(), to: to.getTime(), bucket: "month" };
    }
    default:
      // Everything up to this moment, which is all the record can hold.
      return { period, from: 0, to: now.getTime() + 1, bucket: "month" };
  }
}

export function swellPeriodLabel(period: SwellPeriod): string {
  switch (period) {
    case "month":
      return "This month";
    case "year":
      return "This year";
    default:
      return "All time";
  }
}

/** The window itself, named: `October 2026`, `2026`, `All time`. */
export function swellHeading(window: SwellWindow, now: Date = new Date()): string {
  switch (window.period) {
    case "month":
      return now.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    case "year":
      return String(now.getFullYear());
    default:
      return "All time";
  }
}

export function swellHasEnough(summary: SwellSummary): boolean {
  return summary.plays >= SWELL_MIN_STREAMS || summary.msListened >= SWELL_MIN_MS;
}

/** How far off a window is, measured whichever way is nearer to the mark. */
export function swellProgress(summary: SwellSummary): string {
  const byPlays = summary.plays / SWELL_MIN_STREAMS;
  const byTime = summary.msListened / SWELL_MIN_MS;
  if (byPlays >= byTime) {
    return `${summary.plays} of ${SWELL_MIN_STREAMS} plays`;
  }
  const minutes = Math.round(summary.msListened / 60_000);
  return `${minutes} of ${Math.round(SWELL_MIN_MS / 60_000)} minutes`;
}

/** Reads all three windows at once, so the switcher never has to wait. */
export async function loadSwell(now: Date = new Date()): Promise<SwellLoad> {
  const windows = SWELL_PERIODS.map((period) => swellWindow(period, now));
  const summaries = await Promise.all(
    windows.map((window) => analyticsSwell(window.from, window.to, window.bucket)),
  );

  const loaded: Partial<Record<SwellPeriod, SwellSummary>> = {};
  windows.forEach((window, index) => {
    loaded[window.period] = summaries[index];
  });

  const ready = SWELL_PERIODS.find((period) => {
    const summary = loaded[period];
    return summary !== undefined && swellHasEnough(summary);
  });

  return { summaries: loaded, period: ready ?? "year" };
}

export function swellAxis(window: SwellWindow, summary: SwellSummary | undefined): string[] {
  switch (window.bucket) {
    case "day":
      return dayKeys(new Date(window.from), new Date(window.to));
    case "month":
      return window.period === "all"
        ? collectedKeys(summary)
        : monthKeys(new Date(window.from), new Date(window.to));
    default:
      return collectedKeys(summary);
  }
}

/** The tallest bar anywhere in the chart, so every row shares one scale. */
export function sprintMax(summary: SwellSummary): number {
  let max = 0;
  for (const sprint of summary.artistSprint) {
    for (const point of sprint.points) {
      max = Math.max(max, point.count);
    }
  }
  return max;
}

/** One artist's series, padded out to the whole axis. */
export function sprintSeries(sprint: ArtistSprint, axis: string[], max: number): SprintBar[] {
  const counts = new Map(sprint.points.map((point) => [point.key, point.count]));
  return axis.map((key) => {
    const count = counts.get(key) ?? 0;
    return { key, count, fraction: max > 0 ? count / max : 0 };
  });
}

/** What a bucket is called in a tooltip. */
export function bucketLabel(key: string, bucket: SwellBucket): string {
  if (bucket === "year") {
    return key;
  }
  const [year, month, day] = key.split("-").map(Number);
  if (bucket === "month") {
    return new Date(year, (month ?? 1) - 1, 1).toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
  }
  return new Date(year, (month ?? 1) - 1, day ?? 1).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function dayKeys(from: Date, to: Date): string[] {
  const keys: string[] = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (cursor.getTime() < to.getTime() && keys.length < 400) {
    keys.push(dayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

function monthKeys(from: Date, to: Date): string[] {
  const keys: string[] = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
  while (cursor.getTime() < to.getTime() && keys.length < 600) {
    keys.push(monthKey(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return keys;
}

/** Whatever buckets the record actually has, oldest first. */
function collectedKeys(summary: SwellSummary | undefined): string[] {
  const keys = new Set<string>();
  for (const sprint of summary?.artistSprint ?? []) {
    for (const point of sprint.points) {
      keys.add(point.key);
    }
  }
  return [...keys].sort();
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
