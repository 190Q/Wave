import {
  darken,
  hexToHsv,
  hsvToHex,
  mix,
  readableInk,
  stageGradient,
  withAlpha,
  type Hsv,
} from "../lib/colour";
import { escapeHtml } from "../lib/format";
import {
  ADAPTIVE_THEME,
  adaptiveColour,
  getState,
  player,
  setTheme,
  subscribe,
  themeColour,
} from "../lib/state";
import { fillIcons } from "./icons";

/** Pushes the current accent into the CSS custom properties the stylesheet uses. */
export function applyAccent(colour: string): void {
  const root = document.documentElement;
  root.style.setProperty("--accent", colour);
  // Hover state for toggled controls, and the translucent progress fill.
  root.style.setProperty("--accent-dark", darken(colour, 0.18));
  // Hover state for a toggled control: the theme colour, greyed out a little.
  root.style.setProperty("--accent-dim", mix(colour, "#8f8f9c", 0.4));
  root.style.setProperty("--accent-soft", withAlpha(colour, 0.28));
  root.style.setProperty("--accent-ink", readableInk(colour));
  root.style.setProperty("--stage-background", stageGradient(colour));
}

export function mountTheme(): void {
  const dialog = element<HTMLDialogElement>("theme-dialog");
  const toggle = element("theme-toggle");
  const area = element("picker-area");
  const knob = element("picker-knob");
  const hue = element<HTMLInputElement>("picker-hue");
  const hex = element<HTMLInputElement>("picker-hex");
  const preview = element("picker-preview");
  const apply = element("picker-apply");
  const list = element("theme-list");

  if (!dialog || !toggle || !area || !knob || !hue || !hex || !preview || !apply || !list) {
    return;
  }

  let draft: Hsv = hexToHsv("#4f6484");
  let dragging = false;

  const paint = (): void => {
    const colour = hsvToHex(draft);

    area.style.background =
      `linear-gradient(to top, #000, transparent), ` +
      `linear-gradient(to right, #fff, hsl(${draft.h} 100% 50%))`;
    knob.style.left = `${draft.s * 100}%`;
    knob.style.top = `${(1 - draft.v) * 100}%`;
    preview.style.background = colour;

    if (document.activeElement !== hex) {
      hex.value = colour;
    }
  };

  const pickFrom = (event: PointerEvent): void => {
    const rect = area.getBoundingClientRect();
    draft = {
      h: draft.h,
      s: clamp((event.clientX - rect.left) / rect.width),
      v: clamp(1 - (event.clientY - rect.top) / rect.height),
    };
    paint();
  };

  area.addEventListener("pointerdown", (event) => {
    dragging = true;
    area.setPointerCapture(event.pointerId);
    pickFrom(event);
  });
  area.addEventListener("pointermove", (event) => {
    if (dragging) {
      pickFrom(event);
    }
  });

  const stopDrag = (event: PointerEvent): void => {
    dragging = false;
    if (area.hasPointerCapture(event.pointerId)) {
      area.releasePointerCapture(event.pointerId);
    }
  };
  area.addEventListener("pointerup", stopDrag);
  area.addEventListener("pointercancel", stopDrag);

  hue.addEventListener("input", () => {
    draft = { ...draft, h: Number(hue.value) };
    paint();
  });

  hex.addEventListener("input", () => {
    const value = hex.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
      draft = hexToHsv(value);
      hue.value = String(Math.round(draft.h));
      paint();
    }
  });

  apply.addEventListener("click", () => {
    void setTheme(hsvToHex(draft));
    dialog.close();
  });

  list.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-theme]");
    const value = button?.dataset.theme;
    if (!value) {
      return;
    }
    void setTheme(value);
    if (value !== ADAPTIVE_THEME) {
      draft = hexToHsv(value);
      hue.value = String(Math.round(draft.h));
      paint();
    }
  });

  element("theme-close")?.addEventListener("click", () => dialog.close());

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });

  toggle.addEventListener("click", () => {
    const { theme } = getState().settings;
    draft = hexToHsv(theme === ADAPTIVE_THEME ? adaptiveColour() : theme);
    hue.value = String(Math.round(draft.h));
    paint();
    renderList(list);
    dialog.showModal();
  });

  const render = (): void => {
    applyAccent(themeColour());
    renderList(list);
  };

  fillIcons(dialog);
  subscribe(render);
  // The Adaptive swatch has to follow the track, not just the settings.
  player.onChange(render);
  render();
}

function renderList(list: HTMLElement): void {
  const { theme, recentColours } = getState().settings;

  const entries = [
    { value: ADAPTIVE_THEME, label: "Adaptive", colour: adaptiveColour() },
    ...recentColours.map((colour) => ({ value: colour, label: colour.toUpperCase(), colour })),
  ];

  list.innerHTML = entries
    .map(
      (entry) => `
        <button class="theme-swatch${theme === entry.value ? " is-on" : ""}" type="button" data-theme="${escapeHtml(entry.value)}">
          <span class="swatch" style="background: ${escapeHtml(entry.colour)}"></span>
          <span>${escapeHtml(entry.label)}</span>
        </button>`,
    )
    .join("");
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function element<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
