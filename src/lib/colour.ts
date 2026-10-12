/** Used when a track has no artwork at all. */
export const FALLBACK_COLOUR = "#4f6484";

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Accepts `#abc`, `#aabbcc` and anything unparseable falls back. */
export function parseHex(value: string): Rgb {
  const hex = value.trim().replace(/^#/, "");
  const expanded =
    hex.length === 3
      ? hex
          .split("")
          .map((char) => char + char)
          .join("")
      : hex;

  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    return parseHex(FALLBACK_COLOUR);
  }

  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16),
  };
}

export function toHex({ r, g, b }: Rgb): string {
  const channel = (value: number) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Linear blend. `amount` of 0 keeps `a`, 1 returns `b`. */
export function mix(a: string, b: string, amount: number): string {
  const left = parseHex(a);
  const right = parseHex(b);
  const t = clamp(amount, 0, 1);
  return toHex({
    r: left.r + (right.r - left.r) * t,
    g: left.g + (right.g - left.g) * t,
    b: left.b + (right.b - left.b) * t,
  });
}

export function lighten(colour: string, amount: number): string {
  return mix(colour, "#ffffff", amount);
}

export function darken(colour: string, amount: number): string {
  return mix(colour, "#000000", amount);
}

/** The card treatment: a lifted highlight fading into a deep shadow of the same hue. */
export function cardGradient(colour: string): string {
  return `linear-gradient(158deg, ${lighten(colour, 0.14)} 0%, ${darken(colour, 0.42)} 62%, ${darken(colour, 0.68)} 100%)`;
}

/** The stage backdrop: three soft pools of the theme colour, a touch darker. */
export function stageGradient(colour: string): string {
  const base = darken(colour, 0.35);
  return [
    `radial-gradient(46rem 30rem at 12% 4%, ${withAlpha(lighten(base, 0.1), 0.42)}, transparent 68%)`,
    `radial-gradient(52rem 34rem at 88% 38%, ${withAlpha(base, 0.34)}, transparent 70%)`,
    `radial-gradient(58rem 28rem at 50% 104%, ${withAlpha(darken(base, 0.12), 0.5)}, transparent 72%)`,
    `linear-gradient(180deg, ${darken(base, 0.86)} 0%, #07070a 100%)`,
  ].join(", ");
}

/** `#rrggbb` plus an alpha channel, for use inside `rgb()`-style gradients. */
export function withAlpha(colour: string, alpha: number): string {
  const { r, g, b } = parseHex(colour);
  return `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)} / ${clamp(alpha, 0, 1)})`;
}

/** Relative luminance per WCAG, so text stays legible on any artwork colour. */
export function luminance(colour: string): number {
  const { r, g, b } = parseHex(colour);
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Ink colour that reads well on top of `colour`. */
export function readableInk(colour: string): string {
  return luminance(colour) > 0.45 ? "#0b0b0f" : "#f6f6f8";
}

export const MIN_ACCENT_BRIGHTNESS = 80;

export function isUsableAccent(hex: string): boolean {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b >= MIN_ACCENT_BRIGHTNESS;
}

/** A stable colour for tracks that have no artwork, derived from their id. */
export function colourFromId(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 360;
  }
  const hue = (hash * 47) % 360;
  return hslToHex(hue, 42, 46);
}

export interface Hsv {
  /** Hue in degrees, 0 to 360. */
  h: number;
  /** Saturation, 0 to 1. */
  s: number;
  /** Value, 0 to 1. */
  v: number;
}

export function hexToHsv(hex: string): Hsv {
  const { r, g, b } = parseHex(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let hue = 0;
  if (delta > 0) {
    if (max === rn) {
      hue = 60 * (((gn - bn) / delta) % 6);
    } else if (max === gn) {
      hue = 60 * ((bn - rn) / delta + 2);
    } else {
      hue = 60 * ((rn - gn) / delta + 4);
    }
  }
  if (hue < 0) {
    hue += 360;
  }

  return { h: hue, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const chroma = v * s;
  const section = (((h % 360) + 360) % 360) / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  const [r, g, b] =
    section < 1
      ? [chroma, x, 0]
      : section < 2
        ? [x, chroma, 0]
        : section < 3
          ? [0, chroma, x]
          : section < 4
            ? [0, x, chroma]
            : section < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const offset = v - chroma;
  return toHex({ r: (r + offset) * 255, g: (g + offset) * 255, b: (b + offset) * 255 });
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const section = hue / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  const [r, g, b] =
    section < 1
      ? [chroma, x, 0]
      : section < 2
        ? [x, chroma, 0]
        : section < 3
          ? [0, chroma, x]
          : section < 4
            ? [0, x, chroma]
            : section < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const offset = l - chroma / 2;
  return toHex({ r: (r + offset) * 255, g: (g + offset) * 255, b: (b + offset) * 255 });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
