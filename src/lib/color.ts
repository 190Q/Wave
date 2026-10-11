/** Used when a track has no artwork at all. */
export const FALLBACK_COLOR = "#4f6484";

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
    return parseHex(FALLBACK_COLOR);
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

export function lighten(color: string, amount: number): string {
  return mix(color, "#ffffff", amount);
}

export function darken(color: string, amount: number): string {
  return mix(color, "#000000", amount);
}

/** The card treatment: a lifted highlight fading into a deep shadow of the same hue. */
export function cardGradient(color: string): string {
  return `linear-gradient(158deg, ${lighten(color, 0.14)} 0%, ${darken(color, 0.42)} 62%, ${darken(color, 0.68)} 100%)`;
}

/** The stage backdrop: three soft pools of the same colour. */
export function stageGradient(color: string): string {
  return [
    `radial-gradient(46rem 30rem at 12% 4%, ${withAlpha(lighten(color, 0.1), 0.42)}, transparent 68%)`,
    `radial-gradient(52rem 34rem at 88% 38%, ${withAlpha(color, 0.34)}, transparent 70%)`,
    `radial-gradient(58rem 28rem at 50% 104%, ${withAlpha(darken(color, 0.12), 0.5)}, transparent 72%)`,
    `linear-gradient(180deg, ${darken(color, 0.86)} 0%, #07070a 100%)`,
  ].join(", ");
}

/** `#rrggbb` plus an alpha channel, for use inside `rgb()`-style gradients. */
export function withAlpha(color: string, alpha: number): string {
  const { r, g, b } = parseHex(color);
  return `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)} / ${clamp(alpha, 0, 1)})`;
}

/** Relative luminance per WCAG, so text stays legible on any artwork colour. */
export function luminance(color: string): number {
  const { r, g, b } = parseHex(color);
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Ink colour that reads well on top of `color`. */
export function readableInk(color: string): string {
  return luminance(color) > 0.45 ? "#0b0b0f" : "#f6f6f8";
}

export const MIN_ACCENT_BRIGHTNESS = 80;

export function isUsableAccent(hex: string): boolean {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b >= MIN_ACCENT_BRIGHTNESS;
}

/** A stable colour for tracks that have no artwork, derived from their id. */
export function colorFromId(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 360;
  }
  const hue = (hash * 47) % 360;
  return hslToHex(hue, 42, 46);
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
