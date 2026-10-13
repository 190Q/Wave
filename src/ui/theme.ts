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
import { createPanel } from "./drop";
import { fillIcons } from "./icons";
import { themeWipe } from "./wipe";

/** Matches the dialog's open/close transition in the stylesheet. */
const DIALOG_MS = 220;

let appliedAccent = "";
let appliedStage = "";
let stageTimer: number | null = null;
/** Set when the user picks a colour, so the next change is swept in. */
let wipePending = false;

export function applyAccent(colour: string): void {
  const root = document.documentElement;

  if (colour === appliedAccent && colour === appliedStage) {
    wipePending = false;
    return;
  }

  const wipe = wipePending;
  wipePending = false;

  const paintAccent = (): void => {
    appliedAccent = colour;
    root.style.setProperty("--accent", colour);
    root.style.setProperty("--accent-dark", darken(colour, 0.18));
    root.style.setProperty("--accent-dim", mix(colour, "#8f8f9c", 0.4));
    root.style.setProperty("--accent-soft", withAlpha(colour, 0.28));
    root.style.setProperty("--accent-ink", readableInk(colour));
  };

  const apply = (): void => {
    paintAccent();
    root.style.setProperty("--stage-background", stageGradient(colour));
  };

  const commit = (): void => {
    stageTimer = null;
    appliedStage = colour;

    if (!wipe) {
      apply();
      return;
    }

    root.classList.add("is-theming");
    void themeWipe(apply).then(() => root.classList.remove("is-theming"));
  };

  if (appliedStage === "" || wipe) {
    // First paint, or a picked colour: land it inside the sweep.
    commit();
    return;
  }

  if (stageTimer !== null) {
    window.clearTimeout(stageTimer);
  }

  paintAccent();
  stageTimer = window.setTimeout(commit, 160);
}

export function mountTheme(): void {
  const dialog = element<HTMLDialogElement>("theme-dialog");
  const toggle = element("theme-toggle");
  const face = element("theme-toggle-face");
  const dropList = element("theme-drop-list");
  const area = element("picker-area");
  const knob = element("picker-knob");
  const hue = element<HTMLInputElement>("picker-hue");
  const hex = element<HTMLInputElement>("picker-hex");
  const preview = element("picker-preview");
  const apply = element("picker-apply");
  const list = element("theme-list");

  if (
    !dialog ||
    !toggle ||
    !face ||
    !dropList ||
    !area ||
    !knob ||
    !hue ||
    !hex ||
    !preview ||
    !apply ||
    !list
  ) {
    return;
  }

  let draft: Hsv = hexToHsv("#4f6484");
  let dragging = false;

  /** Anchors the scale animation on the theme button, so it pops from there. */
  const setOrigin = (): void => {
    const dialogRect = dialog.getBoundingClientRect();
    const buttonRect = toggle.getBoundingClientRect();
    const x = buttonRect.left + buttonRect.width / 2 - dialogRect.left;
    const y = buttonRect.top + buttonRect.height / 2 - dialogRect.top;
    dialog.style.transformOrigin = `${x}px ${y}px`;
  };

  let closeTimer: number | null = null;

  const openDialog = (): void => {
    if (closeTimer !== null) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
    // Start collapsed, then let the stylesheet play it in.
    dialog.classList.add("is-closed");
    if (!dialog.open) {
      dialog.showModal();
    }
    setOrigin();
    void dialog.offsetWidth;
    dialog.classList.remove("is-closed");
  };

  const closeDialog = (): void => {
    if (!dialog.open || dialog.classList.contains("is-closed")) {
      return;
    }
    setOrigin();
    dialog.classList.add("is-closed");
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      dialog.close();
    }, DIALOG_MS);
  };

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
    wipePending = true;
    void setTheme(hsvToHex(draft));
  });

  const chooseTheme = (value: string): void => {
    wipePending = true;
    if (value !== ADAPTIVE_THEME) {
      draft = hexToHsv(value);
      hue.value = String(Math.round(draft.h));
      paint();
    }
    void setTheme(value);
  };

  list.addEventListener("click", (event) => {
    const value = (event.target as HTMLElement)
      .closest<HTMLElement>("[data-theme]")
      ?.dataset.theme;
    if (value) {
      chooseTheme(value);
    }
  });

  element("theme-close")?.addEventListener("click", () => closeDialog());

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      closeDialog();
    }
  });

  // Escape closes natively; intercept it so the same animation plays.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });

  /** Fills the picker with the current theme and opens the modal. */
  const openPicker = (): void => {
    const { theme } = getState().settings;
    draft = hexToHsv(theme === ADAPTIVE_THEME ? adaptiveColour() : theme);
    hue.value = String(Math.round(draft.h));
    paint();
    renderList(list);
    openDialog();
  };

  // Cramped mode: the dialog cannot fit, so the toggle itself grows downwards
  // and reveals the theme list inside the same shape.
  const panel = createPanel({
    dialog,
    toggle,
    face,
    show: openPicker,
    hide: closeDialog,
    render: () => {
      dropList.innerHTML = themeRowsHtml();
    },
  });

  dropList.addEventListener("click", (event) => {
    const value = (event.target as HTMLElement).closest<HTMLElement>("[data-theme]")?.dataset
      .theme;
    if (value) {
      chooseTheme(value);
    }
  });

  const render = (): void => {
    applyAccent(themeColour());
    renderList(list);
    panel.fit();
    // A new pick adds a colour, so the open list has to be rebuilt and resized.
    if (panel.isOpen) {
      const rebuild = (): void => panel.refresh();
      if (document.documentElement.classList.contains("is-theming")) {
        window.setTimeout(rebuild, 650);
      } else {
        rebuild();
      }
    }
  };

  fillIcons(dialog);
  subscribe(render);
  // The Adaptive swatch has to follow the track, not just the settings.
  player.onChange(render);
  render();
}

function renderList(list: HTMLElement): void {
  list.innerHTML = themeRowsHtml();
}

/** Adaptive followed by the remembered colours, as swatch rows. */
function themeRowsHtml(): string {
  const { theme, recentColours } = getState().settings;

  const entries = [
    { value: ADAPTIVE_THEME, label: "Adaptive", colour: adaptiveColour() },
    ...recentColours.map((colour) => ({ value: colour, label: colour.toUpperCase(), colour })),
  ];

  return entries
    .map(
      (entry) => `
        <button class="theme-swatch${theme === entry.value ? " is-on" : ""}" type="button" data-theme="${escapeHtml(entry.value)}">
          <span class="swatch" style="background: ${escapeHtml(entry.colour)}"></span>
          <span class="swatch-name">${escapeHtml(entry.label)}</span>
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
