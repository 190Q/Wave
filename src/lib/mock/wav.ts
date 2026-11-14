/** 8 bit mono at 8 kHz: the smallest PCM the webview will decode. */
const SAMPLE_RATE = 8000;

/** How many lengths are kept, so a long session does not hold every one. */
const CACHE_LIMIT = 6;

const cache = new Map<number, string>();

/**
 * A silent WAV of the given length, as a data URL the audio element accepts.
 * Silence keeps the file small while the duration stays real, so metadata
 * arrives and seeking works.
 */
export function silentWav(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  const kept = cache.get(seconds);
  if (kept !== undefined) {
    return kept;
  }

  const url = build(seconds);
  cache.set(seconds, url);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  return url;
}

function build(seconds: number): string {
  const samples = SAMPLE_RATE * seconds;
  const buffer = new ArrayBuffer(44 + samples);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples, true);

  // 8 bit PCM is unsigned, so silence sits at the middle of the range.
  new Uint8Array(buffer, 44).fill(128);

  return `data:audio/wav;base64,${base64(new Uint8Array(buffer))}`;
}

function writeAscii(view: DataView, at: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(at + index, text.charCodeAt(index));
  }
}

/** btoa takes a binary string, and spreading a whole file would blow the stack. */
function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
  }
  return btoa(binary);
}
