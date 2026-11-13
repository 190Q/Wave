import type { EqBand, EqBandKind } from "../types";

/** A curve read out of a profile file. */
export interface EqProfile {
  name: string;
  /** The level the file asks for, which is added on top of the automatic one. */
  preampDb: number;
  bands: EqBand[];
  format: "parametric" | "graphic";
}

/** How many bands a graphic curve is folded into. */
const GRAPHIC_BANDS = 31;

/** Where a folded graphic curve starts and ends. */
const GRAPHIC_LOW = 20;
const GRAPHIC_HIGH = 20000;

/** What a band falls back to when the file leaves the value out. */
const DEFAULT_Q = 0.707;
const DEFAULT_FREQ = 1000;

const PREAMP = /^\s*preamp\s*:\s*(-?[\d.]+)\s*dB/i;
const FILTER_LINE = /^\s*filter\s*\d*\s*:\s*(.+)$/i;
const GRAPHIC_LINE = /^\s*graphiceq\s*:\s*(.+)$/i;
const SWITCH = /\b(on|off)\b/i;
const SHAPE = /\b(LSC|HSC|LPQ|HPQ|PK|LP|HP|BP|NO|LS|HS)\b/i;
const FREQUENCY = /\bFc\s+(-?[\d.]+)\s*Hz/i;
const GAIN = /\bGain\s+(-?[\d.]+)\s*dB/i;
const WIDTH = /\bQ\s+([\d.]+)/i;

/** The shape a profile's name maps onto, in the terms Web Audio uses. */
const SHAPES: Record<string, EqBandKind> = {
  PK: "peaking",
  LP: "lowPass",
  LPQ: "lowPass",
  HP: "highPass",
  HPQ: "highPass",
  BP: "bandPass",
  NO: "notch",
  LS: "lowShelf",
  LSC: "lowShelf",
  HS: "highShelf",
  HSC: "highShelf",
};

/**
 * Reads a profile written for AutoEq or Equalizer APO. The two share their
 * syntax, so one reader covers both, and anything it does not recognise is
 * skipped rather than treated as a broken file.
 */
export function parseEqProfile(text: string, name: string): EqProfile | null {
  const lines = text.split(/\r?\n/);
  let preampDb = 0;
  const bands: EqBand[] = [];
  let graphic: string | null = null;

  for (const raw of lines) {
    const line = strip(raw);
    if (line.length === 0) {
      continue;
    }

    const preamp = PREAMP.exec(line);
    if (preamp) {
      preampDb = Number(preamp[1]);
      continue;
    }

    const graphicLine = GRAPHIC_LINE.exec(line);
    if (graphicLine) {
      graphic = graphicLine[1];
      continue;
    }

    const filter = FILTER_LINE.exec(line);
    if (filter) {
      const band = readBand(filter[1], bands.length);
      if (band) {
        bands.push(band);
      }
    }
  }

  if (graphic !== null) {
    const folded = foldGraphic(graphic);
    if (folded) {
      return { name, preampDb, bands: folded, format: "graphic" };
    }
  }

  return bands.length > 0 ? { name, preampDb, bands, format: "parametric" } : null;
}

/** Drops a comment and the whitespace around what is left. */
function strip(line: string): string {
  const withoutComment = line.split("#")[0];
  return withoutComment.trim();
}

/** One `Filter n: ON PK Fc ... Gain ... Q ...` line, or `null` if it is not one. */
function readBand(rest: string, index: number): EqBand | null {
  const shape = SHAPE.exec(rest);
  if (!shape) {
    return null;
  }

  const kind = SHAPES[shape[1].toUpperCase()] ?? "peaking";
  const state = SWITCH.exec(rest);
  const frequency = FREQUENCY.exec(rest);
  const gain = GAIN.exec(rest);
  const width = WIDTH.exec(rest);

  return {
    id: `eq-import-${index + 1}`,
    kind,
    freq: frequency ? Number(frequency[1]) : DEFAULT_FREQ,
    gain: gain ? Number(gain[1]) : 0,
    q: width ? Number(width[1]) : DEFAULT_Q,
    enabled: state ? state[1].toLowerCase() === "on" : true,
  };
}

/**
 * Folds a `GraphicEQ: 20 -3.2; 21 -3.1; ...` curve into a bank of peaking
 * bands. The points are read as decibels over a logarithmic frequency axis and
 * sampled at even spacing, with the width set so the bands meet each other.
 */
function foldGraphic(body: string): EqBand[] | null {
  const points = readGraphicPoints(body);
  if (points.length < 2) {
    return null;
  }

  const low = Math.log(GRAPHIC_LOW);
  const high = Math.log(GRAPHIC_HIGH);
  const step = (high - low) / (GRAPHIC_BANDS - 1);
  const ratio = Math.exp(step);
  // The width that makes evenly spaced bands sum to a flat line.
  const q = Math.sqrt(ratio) / (ratio - 1);

  const bands: EqBand[] = [];
  for (let index = 0; index < GRAPHIC_BANDS; index += 1) {
    const freq = Math.exp(low + step * index);
    bands.push({
      id: `eq-import-${index + 1}`,
      kind: "peaking",
      freq: round(freq),
      gain: round(interpolate(points, freq)),
      q: round(q * 100) / 100,
      enabled: true,
    });
  }
  return bands;
}

/** The frequency and level of every point the curve names, in order. */
function readGraphicPoints(body: string): { freq: number; gain: number }[] {
  const numbers = body.match(/-?[\d.]+/g);
  if (!numbers) {
    return [];
  }

  const points: { freq: number; gain: number }[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    const freq = Number(numbers[index]);
    const gain = Number(numbers[index + 1]);
    if (Number.isFinite(freq) && Number.isFinite(gain) && freq > 0) {
      points.push({ freq, gain });
    }
  }
  points.sort((left, right) => left.freq - right.freq);
  return points;
}

/** The curve's level at a frequency, read straight between the nearest points. */
function interpolate(points: { freq: number; gain: number }[], freq: number): number {
  if (freq <= points[0].freq) {
    return points[0].gain;
  }
  const last = points[points.length - 1];
  if (freq >= last.freq) {
    return last.gain;
  }

  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    if (right.freq < freq) {
      continue;
    }
    const left = points[index - 1];
    const span = Math.log(right.freq) - Math.log(left.freq);
    if (span <= 0) {
      return right.gain;
    }
    const at = (Math.log(freq) - Math.log(left.freq)) / span;
    return left.gain + (right.gain - left.gain) * at;
  }
  return last.gain;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
