import type { Track } from "../types";
import { MAX_GAIN } from "./player";

/** What every song is levelled to, in LUFS. -14 is the streaming standard. */
export const NORMALIZE_TARGET_LUFS = -14;

/** A peak this small counts as silence, so the ceiling stays finite. */
const MIN_PEAK = 0.001;

/**
 * The multiplier to play a song at so it lands on the target loudness.
 *
 * The lift is capped so a song cannot be pushed into clipping. A lossy decode
 * can overshoot full scale, and the measured peak is what says by how much; for
 * everything else the element's own cap is the ceiling, which is why a very
 * dynamic track ends up a little under the target rather than being lifted all
 * the way to it.
 */
export function gainFor(track: Track): number {
  const { lufs, peak } = track;
  if (lufs === null || !Number.isFinite(lufs)) {
    return 1;
  }

  const wanted = 10 ** ((NORMALIZE_TARGET_LUFS - lufs) / 20);
  const ceiling = 1 / (MAX_GAIN * Math.max(peak ?? 1, MIN_PEAK));
  return Math.min(wanted, ceiling);
}
