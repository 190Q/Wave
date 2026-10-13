/** How long a fade takes, shared by the transport and a track switch. */
export const FADE_MS = 300;

/** Slow at both ends, so a fade arrives and leaves without a click. */
export function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}
