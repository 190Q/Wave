import { parseEqProfile } from "../lib/autoeq";
import { hexToHsv, hsvToHex } from "../lib/colour";
import { MAX_EQ_FREQ, MAX_EQ_GAIN, MIN_EQ_FREQ, MIN_EQ_GAIN } from "../lib/eq";
import { escapeHtml } from "../lib/format";
import { reduceMotionActive } from "../lib/motion";
import { scoreItems } from "../lib/search";
import {
  EQ_PRESET_LIMIT,
  addEqBand,
  applyEqPreset,
  deleteEqPreset,
  eqChain,
  eqStatus,
  flattenEq,
  getState,
  importEqProfile,
  player,
  removeEqBand,
  removeEqContextRule,
  saveEqPreset,
  seedEqBands,
  setEqAutoPreamp,
  setEqContextRule,
  setEqDeviceRule,
  setEqEnabled,
  setEqLimiter,
  setEqOutput,
  setEqPreampDb,
  setNotice,
  subscribe,
  updateEqBand,
  type AppState,
  type EqOrigin,
  type EqStatus,
} from "../lib/state";
import type { EqBand, EqBandKind, EqContextKind, EqPreset } from "../types";
import { highlightHtml } from "./highlight";
import { fillIcons } from "./icons";
import { placePicker, windowFrame } from "./picker";
import { claimPopup, releasePopup } from "./popups";

/** Matches the panel's open and close transition in the stylesheet. */
const EQ_MODAL_MS = 300;

/** The decibels the canvas shows above and below the flat line. */
const MIN_DB = -18;
const MAX_DB = 18;

/** How wide a band node is drawn, and how close a pointer has to land to take it. */
const NODE_RADIUS = 6;
const GRAB_RADIUS = 16;

/** The shapes a band can take, in the words a curve is usually described in. */
const SHAPES: { value: EqBandKind; label: string }[] = [
  { value: "peaking", label: "Peak" },
  { value: "lowShelf", label: "Low shelf" },
  { value: "highShelf", label: "High shelf" },
  { value: "lowPass", label: "Low pass" },
  { value: "highPass", label: "High pass" },
  { value: "bandPass", label: "Band pass" },
  { value: "notch", label: "Notch" },
];

const GRID_FREQUENCIES = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const GRID_DECIBELS = [-12, -6, 0, 6, 12];

/** How far a dropdown list keeps off the window edges, and the gap under its button. */
const LIST_MARGIN = 8;
const LIST_GAP = 6;

/** Matches the list's own drop transition in the stylesheet. */
const LIST_MS = 200;

/** What a dropdown offers, and which of them is in force. */
interface DropChoices {
  chosen: string;
  options: { value: string; label: string }[];
}

/** A dropdown key is the kind of thing it sets, then the subject it applies to. */
function splitKey(key: string): [string, string] {
  const at = key.indexOf("|");
  return at < 0 ? [key, ""] : [key.slice(0, at), key.slice(at + 1)];
}

function shapeLabel(kind: EqBandKind): string {
  return SHAPES.find((shape) => shape.value === kind)?.label ?? "Peak";
}

function bandColour(accent: string, index: number): string {
  const { h, s, v } = hexToHsv(accent);
  return hsvToHex({
    h: h + index * 137.5,
    s: Math.max(s, 0.45),
    v: Math.max(v, 0.7),
  });
}

/** Set while the overlay is mounted, so the settings row can open it. */
let openEqPanel: (() => void) | null = null;

/** Opens the equaliser, the same as pressing the button in the settings panel. */
export function openEq(): void {
  openEqPanel?.();
}

export function mountEq(): void {
  const modal = element("eq-modal");
  const panel = element("eq-panel");
  const body = element("eq-body");
  const closeButton = element("eq-close");
  const power = element<HTMLButtonElement>("eq-power");
  const originText = element("eq-origin");
  const file = element<HTMLInputElement>("eq-file");

  if (!modal || !panel || !body || !closeButton || !power || !originText || !file) {
    return;
  }

  body.innerHTML = shellHtml();
  const canvas = element<HTMLCanvasElement>("eq-canvas");
  const bands = element("eq-bands");
  const side = element("eq-side");
  const readout = element("eq-readout");
  if (!canvas || !bands || !side || !readout) {
    return;
  }
  const context = canvas.getContext("2d");

  /** The band the canvas is working on, if any. */
  let selected: string | null = null;
  /** The band a pointer is dragging, if any. */
  let dragging: string | null = null;
  let closeTimer: number | null = null;
  let frame: number | null = null;
  let spectrum: Uint8Array<ArrayBuffer> | null = null;

  /** What the strips and the side panel were last built from, so they are not rebuilt for nothing. */
  let bandsShape = "";
  let sideShape = "";

  let colours = { accent: "#4f6484", dim: "#8f8f9c", soft: "rgb(59 74 99 / 0.28)" };

  /** The band the pointer is on in the list, so the curve can show it. */
  let hovered: string | null = null;

  // The dropdowns. A select opens a list the system draws, which cannot be
  // themed, so the lists here are built by hand and hung off their button.

  const picker = document.createElement("div");
  picker.className = "eq-picker";
  picker.hidden = true;
  modal.append(picker);

  let pickerOwner: HTMLElement | null = null;
  let pickerTimer: number | null = null;

  const dropChoices = (key: string): DropChoices | null => {
    const settings = getState().settings;
    const none = { value: "", label: "None" };
    const presets = settings.eqPresets.map((preset) => ({ value: preset.id, label: preset.name }));

    if (key === "output") {
      const outputs = eqStatus().outputs.map((output) => ({ value: output.id, label: output.label }));
      return { chosen: settings.eqOutputId, options: [{ value: "", label: "System default" }, ...outputs] };
    }

    if (key === "output-rule") {
      return { chosen: settings.eqDeviceRules[settings.eqOutputId] ?? "", options: [none, ...presets] };
    }

    const [kind, subject] = splitKey(key);
    if (kind === "shape") {
      const band = settings.eqBands.find((entry) => entry.id === subject);
      return {
        chosen: band?.kind ?? "",
        options: SHAPES.map((shape) => ({ value: shape.value, label: shape.label })),
      };
    }

    const rule = settings.eqContextRules.find(
      (entry) => entry.kind === kind && entry.value === subject,
    );
    return { chosen: rule?.presetId ?? "", options: [none, ...presets] };
  };

  const applyDropChoice = (key: string, value: string): void => {
    if (key === "output") {
      setEqOutput(value);
      return;
    }
    if (key === "output-rule") {
      setEqDeviceRule(getState().settings.eqOutputId, value);
      return;
    }

    const [kind, subject] = splitKey(key);
    if (kind === "shape") {
      updateEqBand(subject, { kind: value as EqBandKind });
      return;
    }
    if (value) {
      setEqContextRule(kind as EqContextKind, subject, value);
    } else {
      removeEqContextRule(kind as EqContextKind, subject);
    }
  };

  const hidePicker = (): void => {
    pickerTimer = null;
    picker.hidden = true;
    picker.classList.remove("is-closed");
    picker.replaceChildren();
  };

  const closePicker = (): void => {
    if (pickerOwner === null) {
      return;
    }
    pickerOwner.setAttribute("aria-expanded", "false");
    pickerOwner = null;

    if (reduceMotionActive()) {
      hidePicker();
      return;
    }
    picker.classList.add("is-closed");
    if (pickerTimer !== null) {
      window.clearTimeout(pickerTimer);
    }
    pickerTimer = window.setTimeout(hidePicker, LIST_MS);
  };

  const openPicker = (key: string, trigger: HTMLElement): void => {
    if (pickerOwner === trigger) {
      closePicker();
      return;
    }

    if (pickerTimer !== null) {
      window.clearTimeout(pickerTimer);
      pickerTimer = null;
    }
    pickerOwner?.setAttribute("aria-expanded", "false");
    pickerOwner = null;
    const choices = dropChoices(key);
    if (!choices) {
      hidePicker();
      return;
    }

    picker.replaceChildren(
      ...choices.options.map((option) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `eq-option${option.value === choices.chosen ? " is-on" : ""}`;
        button.textContent = option.label;
        button.addEventListener("click", () => {
          closePicker();
          applyDropChoice(key, option.value);
        });
        return button;
      }),
    );

    picker.classList.add("is-closed");
    picker.hidden = false;
    pickerOwner = trigger;
    placeList(trigger);
    trigger.setAttribute("aria-expanded", "true");

    void picker.offsetWidth;
    requestAnimationFrame(() => {
      if (pickerOwner === trigger) {
        picker.classList.remove("is-closed");
      }
    });
  };

  const placeList = (trigger: HTMLElement): void => {
    const rect = trigger.getBoundingClientRect();
    const room = window.innerWidth - 2 * LIST_MARGIN;

    picker.style.width = "max-content";
    picker.style.maxWidth = `${room}px`;

    const roomBelow = window.innerHeight - rect.bottom - LIST_GAP - LIST_MARGIN;
    const roomAbove = rect.top - LIST_GAP - LIST_MARGIN;
    picker.style.maxHeight = `${Math.max(LIST_MARGIN, roomBelow, roomAbove)}px`;

    const width = Math.min(Math.max(picker.offsetWidth, rect.width), room);
    const height = picker.offsetHeight;
    const above = roomBelow < height && roomAbove > roomBelow;
    const top = above ? rect.top - LIST_GAP - height : rect.bottom + LIST_GAP;
    const left = Math.min(
      Math.max(rect.left, LIST_MARGIN),
      window.innerWidth - width - LIST_MARGIN,
    );

    picker.style.width = `${width}px`;
    picker.style.left = `${left}px`;
    picker.style.top = `${Math.max(LIST_MARGIN, top)}px`;
    picker.style.transformOrigin = above ? "bottom left" : "top left";
    picker.style.setProperty("--eq-drop-shift", above ? "0.4rem" : "-0.4rem");
  };

  const namePicker = document.createElement("div");
  namePicker.className = "slot-picker import-picker";
  namePicker.hidden = true;
  modal.append(namePicker);

  let nameField: HTMLInputElement | null = null;
  let nameMatches: EqPreset[] = [];
  let nameActive = -1;

  const closeNames = (): void => {
    namePicker.hidden = true;
    namePicker.replaceChildren();
    nameField?.classList.remove("is-open");
    nameField?.setAttribute("aria-expanded", "false");
    nameField = null;
    nameMatches = [];
    nameActive = -1;
  };

  const paintNameActive = (): void => {
    const rows = Array.from(namePicker.querySelectorAll<HTMLElement>(".slot-option"));
    rows.forEach((row, index) => row.classList.toggle("is-highlighted", index === nameActive));
    rows[nameActive]?.scrollIntoView({ block: "nearest" });
  };

  const paintNames = (query: string): void => {
    if (!nameField) {
      return;
    }
    const settings = getState().settings;
    nameMatches = scoreItems(
      settings.eqPresets,
      query,
      settings.searchAlgorithm,
      (preset) => [preset.name],
      settings.eqPresets,
    )
      .slice(0, 5)
      .map((entry) => entry.item);
    nameActive = nameMatches.length > 0 ? 0 : -1;

    namePicker.innerHTML =
      nameMatches.length > 0
        ? nameMatches
            .map(
              (preset, index) => `
          <button type="button" class="slot-option" data-name-option="${index}">
            <span class="slot-option-name">${highlightHtml(preset.name, query, settings.searchAlgorithm)}</span>
          </button>`,
            )
            .join("")
        : `<p class="import-picker-empty">No saved curve matches.</p>`;

    paintNameActive();
    placePicker(namePicker, nameField, windowFrame(), "above");
  };

  const openNames = (field: HTMLInputElement): void => {
    closeNames();
    if (field.value.trim().length === 0) {
      return;
    }
    nameField = field;
    namePicker.hidden = false;
    field.classList.add("is-open");
    field.setAttribute("aria-expanded", "true");
    paintNames(field.value);
  };

  const chooseName = (index: number): void => {
    const preset = nameMatches[index];
    if (!preset || !nameField) {
      return;
    }
    nameField.value = preset.name;
    closeNames();
  };

  namePicker.addEventListener("pointerdown", (event) => event.preventDefault());
  namePicker.addEventListener("click", (event) => {
    const option = (event.target as HTMLElement).closest<HTMLElement>("[data-name-option]");
    if (option) {
      chooseName(Number(option.dataset.nameOption));
    }
  });

  side.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.id === "eq-preset-name") {
      openNames(event.target);
    }
  });

  side.addEventListener("input", (event) => {
    const field = event.target;
    if (!(field instanceof HTMLInputElement) || field.id !== "eq-preset-name") {
      return;
    }
    if (field.value.trim().length === 0) {
      closeNames();
      return;
    }
    if (nameField !== field) {
      openNames(field);
      return;
    }
    paintNames(field.value);
  });

  side.addEventListener("focusout", (event) => {
    if (event.target === nameField) {
      closeNames();
    }
  });

  side.addEventListener("keydown", (event) => {
    if (event.target !== nameField || namePicker.hidden) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeNames();
      return;
    }
    if (["ArrowDown", "ArrowUp", "Tab"].includes(event.key)) {
      event.preventDefault();
      if (nameMatches.length > 0) {
        const step = event.key === "ArrowUp" || event.shiftKey ? -1 : 1;
        nameActive = (nameActive + step + nameMatches.length) % nameMatches.length;
        paintNameActive();
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      chooseName(nameActive);
    }
  });

  const dropButton = (key: string, label: string): string => {
    const choices = dropChoices(key);
    const chosen = choices?.options.find((option) => option.value === choices.chosen);
    return `
      <button class="eq-drop" type="button" data-drop="${escapeHtml(key)}" aria-haspopup="listbox" aria-expanded="false" aria-label="${escapeHtml(label)}">
        <span class="eq-drop-label">${escapeHtml(chosen?.label ?? "None")}</span>
        <span class="sort-chevron" aria-hidden="true"></span>
      </button>`;
  };

  // The canvas, and the axes it draws the curve against.

  const range = (): { low: number; high: number } => {
    const freqs = eqChain.frequencies;
    return freqs.length > 1
      ? { low: freqs[0], high: freqs[freqs.length - 1] }
      : { low: MIN_EQ_FREQ, high: MAX_EQ_FREQ };
  };

  const xFor = (freq: number, width: number): number => {
    const { low, high } = range();
    const at = (Math.log(clamp(freq, low, high)) - Math.log(low)) / (Math.log(high) - Math.log(low));
    return at * width;
  };

  const freqAt = (x: number, width: number): number => {
    const { low, high } = range();
    const at = clamp(width > 0 ? x / width : 0, 0, 1);
    return Math.exp(Math.log(low) + at * (Math.log(high) - Math.log(low)));
  };

  const yFor = (db: number, height: number): number =>
    ((MAX_DB - clamp(db, MIN_DB, MAX_DB)) / (MAX_DB - MIN_DB)) * height;

  const dbAt = (y: number, height: number): number =>
    MAX_DB - clamp(height > 0 ? y / height : 0.5, 0, 1) * (MAX_DB - MIN_DB);

  const sizeCanvas = (): { width: number; height: number } | null => {
    const ctx = context;
    const rect = canvas.getBoundingClientRect();
    if (!ctx || rect.width < 1 || rect.height < 1) {
      return null;
    }
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { width, height };
  };

  const readColours = (): void => {
    const styles = getComputedStyle(document.documentElement);
    colours = {
      accent: styles.getPropertyValue("--accent").trim() || "#4f6484",
      dim: styles.getPropertyValue("--accent-dim").trim() || "#8f8f9c",
      soft: styles.getPropertyValue("--accent-soft").trim() || "rgb(59 74 99 / 0.28)",
    };
  };

  /** Draws the grid, the spectrum and the curve the filters are actually set to. */
  const draw = (): void => {
    const ctx = context;
    const size = sizeCanvas();
    if (!ctx || !size) {
      return;
    }
    const { width, height } = size;
    ctx.clearRect(0, 0, width, height);

    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgb(255 255 255 / 0.07)";
    for (const freq of GRID_FREQUENCIES) {
      const x = Math.round(xFor(freq, width)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (const db of GRID_DECIBELS) {
      const y = Math.round(yFor(db, height)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgb(255 255 255 / 0.18)";
    const flat = Math.round(yFor(0, height)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, flat);
    ctx.lineTo(width, flat);
    ctx.stroke();

    const analyser = eqChain.analyserNode;
    if (analyser && eqChain.live && !reduceMotionActive()) {
      const bins = analyser.frequencyBinCount;
      if (!spectrum || spectrum.length !== bins) {
        spectrum = new Uint8Array(bins);
      }
      analyser.getByteFrequencyData(spectrum);
      const rate = analyser.context.sampleRate;
      const { low, high } = range();

      ctx.fillStyle = colours.soft;
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let index = 0; index < bins; index += 1) {
        const freq = (index * rate) / (bins * 2);
        if (freq < low) {
          continue;
        }
        if (freq > high) {
          break;
        }
        ctx.lineTo(xFor(freq, width), height - (spectrum[index] / 255) * height);
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();
    }

    const curve = eqChain.curve();
    const freqs = eqChain.frequencies;
    ctx.lineWidth = 2;
    if (curve.length > 1 && freqs.length === curve.length) {
      ctx.strokeStyle = colours.accent;
      ctx.beginPath();
      for (let index = 0; index < curve.length; index += 1) {
        const x = xFor(freqs[index], width);
        const y = yFor(curve[index], height);
        if (index === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    } else {
      ctx.strokeStyle = colours.dim;
      ctx.beginPath();
      ctx.moveTo(0, flat);
      ctx.lineTo(width, flat);
      ctx.stroke();
    }

    const bands = getState().settings.eqBands.map((band, index) => ({ band, index }));
    const rank = (id: string): number => (id === selected ? 2 : id === hovered ? 1 : 0);
    bands.sort((left, right) => rank(left.band.id) - rank(right.band.id));

    for (const { band, index } of bands) {
      const colour = bandColour(colours.accent, index);
      const x = xFor(band.freq, width);
      const y = yFor(band.enabled ? band.gain : 0, height);
      const emphasis = band.id === selected || band.id === hovered;
      const radius = emphasis ? NODE_RADIUS + 2 : NODE_RADIUS;

      if (band.id === hovered) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 5, 0, Math.PI * 2);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = colour;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = band.enabled ? colour : colours.dim;
      if (band.enabled) {
        ctx.fillStyle = colour;
        ctx.fill();
      }
      ctx.stroke();
    }
  };

  /** A canvas with no box has nothing to draw on, so the loop parks instead. */
  const canvasSized = (): boolean => {
    const rect = canvas.getBoundingClientRect();
    return rect.width >= 1 && rect.height >= 1;
  };

  /** The curve is redrawn every frame, so the spectrum moves with the sound. */
  const tick = (): void => {
    frame = null;
    if (modal.hidden || !canvasSized()) {
      return;
    }
    draw();
    frame = requestAnimationFrame(tick);
  };

  const startDrawing = (): void => {
    if (reduceMotionActive()) {
      // Nothing moves on its own, so one pass over the curve is enough.
      draw();
      return;
    }
    if (frame === null) {
      frame = requestAnimationFrame(tick);
    }
  };

  const stopDrawing = (): void => {
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
  };

  // The graph is off the screen on a phone, and comes back if the window is
  // resized onto a layout that shows it.
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      if (!modal.hidden) {
        startDrawing();
      }
    }).observe(canvas);
  }

  // Pointing at the curve.

  const pointAt = (event: MouseEvent): { x: number; y: number; width: number; height: number } => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    };
  };

  const bandAt = (x: number, y: number, width: number, height: number): EqBand | null => {
    let found: EqBand | null = null;
    let nearest = GRAB_RADIUS;
    for (const band of getState().settings.eqBands) {
      const distance = Math.hypot(
        xFor(band.freq, width) - x,
        yFor(band.enabled ? band.gain : 0, height) - y,
      );
      if (distance < nearest) {
        nearest = distance;
        found = band;
      }
    }
    return found;
  };

  canvas.addEventListener("pointerdown", (event) => {
    const point = pointAt(event);
    const band = bandAt(point.x, point.y, point.width, point.height);
    if (!band) {
      selected = null;
      paint();
      return;
    }
    selected = band.id;
    dragging = band.id;
    canvas.style.cursor = "grab";
    canvas.setPointerCapture(event.pointerId);
    canvas.focus();
    paint();
  });

  /** The cursor a pointer sitting at this spot should carry. */
  const cursorAt = (point: { x: number; y: number; width: number; height: number }): string =>
    bandAt(point.x, point.y, point.width, point.height) ? "pointer" : "";

  canvas.addEventListener("pointermove", (event) => {
    const point = pointAt(event);
    if (dragging !== null) {
      updateEqBand(dragging, {
        freq: Math.round(freqAt(point.x, point.width)),
        gain: Math.round(dbAt(point.y, point.height) * 10) / 10,
      });
      return;
    }
    canvas.style.cursor = cursorAt(point);
  });

  canvas.addEventListener("pointerleave", () => {
    if (dragging === null) {
      canvas.style.cursor = "";
    }
  });

  const endDrag = (event: PointerEvent): void => {
    if (dragging === null) {
      return;
    }
    dragging = null;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    canvas.style.cursor = cursorAt(pointAt(event));
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (modal.hidden) {
        return;
      }
      const target = event.target as HTMLElement;
      if (canvas.contains(target)) {
        return;
      }
      // A strip takes the selection over; anything else lets it go.
      const row = target.closest<HTMLElement>("[data-band-row]");
      const next = row?.dataset.bandRow ?? null;
      if (next === selected) {
        return;
      }
      selected = next;
      paint();
    },
    true,
  );

  canvas.addEventListener(
    "wheel",
    (event) => {
      const band = selectedBand();
      if (!band) {
        return;
      }
      event.preventDefault();
      const step = event.deltaY < 0 ? 1.15 : 1 / 1.15;
      updateEqBand(band.id, { q: Math.round(clamp(band.q * step, 0.1, 18) * 100) / 100 });
    },
    { passive: false },
  );

  canvas.addEventListener("dblclick", (event) => {
    const point = pointAt(event);
    const band = bandAt(point.x, point.y, point.width, point.height);
    if (band) {
      updateEqBand(band.id, { enabled: !band.enabled });
    }
  });

  /** The keys the canvas keeps for the selected band. */
  const BAND_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "Backspace"];

  canvas.addEventListener("keydown", (event) => {
    const band = selectedBand();
    if (!band || !BAND_KEYS.includes(event.key)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const fine = event.shiftKey ? 0.1 : 1;
    switch (event.key) {
      case "ArrowUp":
        updateEqBand(band.id, { gain: clamp(band.gain + fine, MIN_EQ_GAIN, MAX_EQ_GAIN) });
        return;
      case "ArrowDown":
        updateEqBand(band.id, { gain: clamp(band.gain - fine, MIN_EQ_GAIN, MAX_EQ_GAIN) });
        return;
      case "ArrowLeft":
        updateEqBand(band.id, { freq: Math.round(clamp(band.freq / 1.05, MIN_EQ_FREQ, MAX_EQ_FREQ)) });
        return;
      case "ArrowRight":
        updateEqBand(band.id, { freq: Math.round(clamp(band.freq * 1.05, MIN_EQ_FREQ, MAX_EQ_FREQ)) });
        return;
      default:
        removeEqBand(band.id);
        selected = null;
        return;
    }
  });

  const selectedBand = (): EqBand | undefined =>
    getState().settings.eqBands.find((band) => band.id === selected);

  // The strips under the curve.

  const bandRow = (band: EqBand, index: number): string => `
    <div class="eq-band${band.enabled ? "" : " is-off"}"
      data-band-row="${escapeHtml(band.id)}" style="--eq-band-colour: ${bandColour(colours.accent, index)}">
      <button class="eq-band-mark" type="button" data-band-toggle="${escapeHtml(band.id)}"
        aria-label="${band.enabled ? "Switch this band off" : "Switch this band on"}"></button>
      <button class="eq-drop eq-band-shape" type="button" data-drop="shape|${escapeHtml(band.id)}" aria-haspopup="listbox" aria-expanded="false" aria-label="Band shape">
        <span class="eq-drop-label">${escapeHtml(shapeLabel(band.kind))}</span>
        <span class="sort-chevron" aria-hidden="true"></span>
      </button>
      <label class="eq-band-field is-freq">
        <input class="eq-band-input" type="number" min="20" max="20000" step="1"
          data-band-freq="${escapeHtml(band.id)}" aria-label="Frequency" />
        <span class="eq-band-unit">Hz</span>
      </label>
      <label class="eq-band-field is-gain">
        <input class="eq-band-input" type="number" min="-24" max="24" step="0.1"
          data-band-gain="${escapeHtml(band.id)}" aria-label="Gain" />
        <span class="eq-band-unit">dB</span>
      </label>
      <label class="eq-band-field is-q">
        <input class="eq-band-input" type="number" min="0.1" max="18" step="0.01"
          data-band-q="${escapeHtml(band.id)}" aria-label="Width" />
        <span class="eq-band-unit">Q</span>
      </label>
      <button class="pill icon-only eq-band-remove" type="button" data-band-remove="${escapeHtml(band.id)}" aria-label="Remove band">
        <span class="btn-icon" data-icon="close"></span>
      </button>
    </div>`;

  const paintBands = (list: EqBand[]): void => {
    const shape = `${colours.accent}|${list
      .map((band) => `${band.id}:${band.kind}:${band.enabled}`)
      .join("|")}`;
    if (shape !== bandsShape) {
      bandsShape = shape;
      if (selected && !list.some((band) => band.id === selected)) {
        selected = null;
      }
      if (hovered && !list.some((band) => band.id === hovered)) {
        hovered = null;
      }
      bands.innerHTML = list.map((band, index) => bandRow(band, index)).join("");
      fillIcons(bands);
    }
    for (const band of list) {
      const row = bands.querySelector<HTMLElement>(`[data-band-row="${band.id}"]`);
      row?.classList.toggle("is-on", band.id === selected);
      setValue(bands, `[data-band-freq="${band.id}"]`, String(Math.round(band.freq)));
      setValue(bands, `[data-band-gain="${band.id}"]`, band.gain.toFixed(1));
      setValue(bands, `[data-band-q="${band.id}"]`, band.q.toFixed(2));
    }
  };

  bands.addEventListener("pointerover", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-band-row]");
    const id = row?.dataset.bandRow ?? null;
    if (id === hovered) {
      return;
    }
    hovered = id;
    if (reduceMotionActive()) {
      draw();
    }
  });

  bands.addEventListener("pointerleave", () => {
    if (hovered === null) {
      return;
    }
    hovered = null;
    if (reduceMotionActive()) {
      draw();
    }
  });

  bands.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const drop = target.closest<HTMLElement>("[data-drop]");
    if (drop?.dataset.drop) {
      openPicker(drop.dataset.drop, drop);
      return;
    }

    const toggle = target.closest<HTMLElement>("[data-band-toggle]");
    if (toggle?.dataset.bandToggle) {
      const band = getState().settings.eqBands.find((entry) => entry.id === toggle.dataset.bandToggle);
      if (band) {
        updateEqBand(band.id, { enabled: !band.enabled });
      }
      return;
    }

    const remove = target.closest<HTMLElement>("[data-band-remove]");
    if (remove?.dataset.bandRemove) {
      removeEqBand(remove.dataset.bandRemove);
    }
  });

  bands.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    const { bandFreq, bandGain, bandQ } = target.dataset;
    if (bandFreq) {
      updateEqBand(bandFreq, { freq: clamp(Number(target.value), MIN_EQ_FREQ, MAX_EQ_FREQ) });
      return;
    }
    if (bandGain) {
      updateEqBand(bandGain, { gain: clamp(Number(target.value), MIN_EQ_GAIN, MAX_EQ_GAIN) });
      return;
    }
    if (bandQ) {
      updateEqBand(bandQ, { q: clamp(Number(target.value), 0.1, 18) });
    }
  });

  // The panel beside the curve.

  const sideHtml = (state: AppState, status: EqStatus): string => {
    const settings = state.settings;

    const field = (label: string, key: string, title: string): string => `
      <div class="eq-field">
        <span class="eq-note" title="${escapeHtml(title)}">${escapeHtml(label)}</span>
        ${dropButton(key, label)}
      </div>`;

    const followRows: string[] = [];
    const followRow = (kind: EqContextKind, label: string, value: string | null | undefined): void => {
      if (!value) {
        return;
      }
      followRows.push(field(`${label}: ${shorten(value)}`, `${kind}|${value}`, value));
    };

    followRow("playlist", "Playlist", player.snapshot().sourceName || null);
    followRow("album", "Album", currentTrack()?.album);
    followRow("artist", "Artist", currentTrack()?.artist);
    followRow("genre", "Genre", currentTrack()?.genre);

    const named = status.outputs.some((output) => !/^Output \d+$/.test(output.label));
    const outputRows = status.canChooseOutput
      ? `
        ${field("Send audio to", "output", "Send audio to")}
        ${settings.eqOutputId ? field("Curve for it", "output-rule", "Curve for this output") : ""}
        <p class="eq-note">${
          named
            ? "A curve can follow the output in use."
            : "This system will not name its outputs without microphone access, so only the default can be picked."
        }</p>`
      : `<p class="eq-note">This build cannot pick an output device, so a curve cannot follow one.</p>`;

    const presetRows =
      settings.eqPresets.length === 0
        ? `<p class="eq-note">No saved curves yet.</p>`
        : settings.eqPresets
            .map(
              (preset) => `
        <div class="eq-preset${preset.id === settings.eqActivePresetId ? " is-on" : ""}">
          <button class="eq-preset-name" type="button" data-preset-apply="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</button>
          <span class="eq-preset-tag">${preset.source === "autoeq" ? "imported" : "saved"}</span>
          <button class="pill icon-only" type="button" data-preset-delete="${escapeHtml(preset.id)}" aria-label="Delete ${escapeHtml(preset.name)}">
            <span class="btn-icon" data-icon="close"></span>
          </button>
        </div>`,
            )
            .join("");

    return `
      <div class="eq-group">
        <span class="eq-group-title">Level</span>
        <div class="eq-field">
          <label for="eq-preamp">Trim</label>
          <input class="eq-input" id="eq-preamp" type="number" min="-24" max="24" step="0.1" aria-label="Preamp trim" />
        </div>
        <div class="eq-field">
          <label for="eq-auto">Automatic preamp</label>
          <button class="switch${settings.eqAutoPreamp ? " is-on" : ""}" id="eq-auto" type="button" role="switch" aria-checked="${settings.eqAutoPreamp}" aria-label="Automatic preamp">
            <span class="switch-knob"></span>
          </button>
        </div>
        <div class="eq-field">
          <label for="eq-limiter">Safety limiter</label>
          <button class="switch${settings.eqLimiter ? " is-on" : ""}" id="eq-limiter" type="button" role="switch" aria-checked="${settings.eqLimiter}" aria-label="Safety limiter">
            <span class="switch-knob"></span>
          </button>
        </div>
      </div>

      <div class="eq-group">
        <span class="eq-group-title">Curves</span>
        <div class="eq-preset">
          <input class="eq-input is-wide" id="eq-preset-name" type="text" placeholder="Name this curve"
            aria-label="Curve name" aria-expanded="false" autocomplete="off" spellcheck="false" />
          <button class="pill" type="button" id="eq-preset-save">Save</button>
        </div>
        <button class="pill" type="button" id="eq-import">Import a profile</button>
        ${presetRows}
        ${
          settings.eqPresets.length >= EQ_PRESET_LIMIT
            ? `<p class="eq-note">${EQ_PRESET_LIMIT} is the most that are kept, so saving another replaces the oldest.</p>`
            : ""
        }
      </div>

      <div class="eq-group">
        <span class="eq-group-title">Follows what plays</span>
        ${followRows.join("") || `<p class="eq-note">Nothing is playing, so there is nothing to key a curve on.</p>`}
      </div>

      <div class="eq-group">
        <span class="eq-group-title">Follows the output</span>
        ${outputRows}
      </div>`;
  };

  const paintSide = (state: AppState, status: EqStatus): void => {
    const shape = JSON.stringify([
      state.settings.eqPresets.map((preset) => [preset.id, preset.name, preset.source]),
      state.settings.eqActivePresetId,
      state.settings.eqContextRules,
      state.settings.eqDeviceRules,
      state.settings.eqOutputId,
      state.settings.eqAutoPreamp,
      state.settings.eqLimiter,
      status.outputs,
      status.canChooseOutput,
      player.snapshot().sourceName,
      currentTrack()?.album ?? "",
      currentTrack()?.artist ?? "",
      currentTrack()?.genre ?? "",
    ]);
    if (shape !== sideShape) {
      sideShape = shape;
      side.innerHTML = sideHtml(state, status);
      fillIcons(side);
    }
    setValue(side, "#eq-preamp", state.settings.eqPreampDb.toFixed(1));
  };

  side.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const drop = target.closest<HTMLElement>("[data-drop]");
    if (drop?.dataset.drop) {
      openPicker(drop.dataset.drop, drop);
      return;
    }

    if (target.closest("#eq-auto")) {
      setEqAutoPreamp(!getState().settings.eqAutoPreamp);
      return;
    }
    if (target.closest("#eq-limiter")) {
      setEqLimiter(!getState().settings.eqLimiter);
      return;
    }
    if (target.closest("#eq-preset-save")) {
      const field = side.querySelector<HTMLInputElement>("#eq-preset-name");
      saveEqPreset(field?.value ?? "");
      if (field) {
        field.value = "";
      }
      closeNames();
      return;
    }
    if (target.closest("#eq-import")) {
      file.click();
      return;
    }

    const apply = target.closest<HTMLElement>("[data-preset-apply]");
    if (apply?.dataset.presetApply) {
      applyEqPreset(apply.dataset.presetApply);
      return;
    }

    const remove = target.closest<HTMLElement>("[data-preset-delete]");
    if (remove?.dataset.presetDelete) {
      deleteEqPreset(remove.dataset.presetDelete);
    }
  });

  side.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.id === "eq-preamp") {
      setEqPreampDb(Number(target.value));
    }
  });

  // Anything that moves a button would leave its list behind.
  side.addEventListener("scroll", closePicker);
  side.addEventListener("scroll", closeNames);
  window.addEventListener("resize", closePicker);
  window.addEventListener("resize", closeNames);
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target as Node;
      if (pickerOwner === null || pickerOwner.contains(target) || picker.contains(target)) {
        return;
      }
      closePicker();
    },
    true,
  );

  body.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("#eq-add")) {
      addEqBand();
      return;
    }
    if (target.closest("#eq-flat")) {
      flattenEq();
    }
  });

  // The whole picture, rebuilt from what is stored.

  const paintPower = (status: EqStatus): void => {
    const on = getState().settings.eqEnabled;
    power.classList.toggle("is-on", on);
    power.setAttribute("aria-checked", String(on));
    power.textContent = on ? "On" : "Off";
    power.disabled = status.blocked !== null;
  };

  const paintOrigin = (status: EqStatus): void => {
    if (status.blocked === "cors") {
      originText.textContent = "This system will not let Wave read the audio, so the equaliser is off.";
      return;
    }
    if (status.blocked === "unsupported") {
      originText.textContent = "This build has no audio filter support, so the equaliser is off.";
      return;
    }
    const origin = status.origin;
    originText.textContent = origin
      ? `Picked by ${originWord(origin)}: ${origin.label}`
      : "Nothing is picking a curve, so the bands are yours.";
  };

  const paintReadout = (status: EqStatus): void => {
    const parts: string[] = [];
    const band = selectedBand();
    if (band) {
      parts.push(`Selected ${Math.round(band.freq)} Hz, ${band.gain.toFixed(1)} dB, Q ${band.q.toFixed(2)}`);
    }
    if (status.live) {
      parts.push(`Preamp ${status.preampDb.toFixed(1)} dB`);
      if (getState().settings.eqAutoPreamp) {
        parts.push(`automatic level ${status.autoPreampDb.toFixed(1)} dB`);
      }
    }
    readout.textContent =
      parts.length > 0
        ? `${parts.join(". ")}.`
        : "Drag a node for level and frequency, scroll over one for its width, double-click it to switch it off.";
  };

  const paint = (): void => {
    if (modal.hidden) {
      return;
    }
    closePicker();
    closeNames();

    const state = getState();
    const status = eqStatus();

    readColours();
    paintPower(status);
    paintOrigin(status);
    paintBands(state.settings.eqBands);
    paintSide(state, status);
    paintReadout(status);
    if (reduceMotionActive()) {
      draw();
    }
  };

  // Opening and closing.

  const finishClose = (): void => {
    closeTimer = null;
    modal.hidden = true;
    releasePopup(close);
  };

  const close = (): void => {
    if (modal.hidden || modal.classList.contains("is-closed")) {
      return;
    }
    closePicker();
    closeNames();
    selected = null;
    stopDrawing();
    if (reduceMotionActive()) {
      finishClose();
      return;
    }
    modal.classList.add("is-closed");
    closeTimer = window.setTimeout(finishClose, EQ_MODAL_MS);
  };

  const open = (): void => {
    if (closeTimer !== null) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
    if (!modal.hidden && !modal.classList.contains("is-closed")) {
      return;
    }

    claimPopup(close);
    modal.hidden = false;
    // A first look at the equaliser starts from a full set of bands.
    seedEqBands();
    paint();

    if (reduceMotionActive()) {
      modal.classList.remove("is-closed");
    } else {
      // Start collapsed, then let the stylesheet play it out to the window.
      modal.classList.add("is-closed");
      void panel.offsetWidth;
      modal.classList.remove("is-closed");
    }
    startDrawing();
  };

  openEqPanel = open;
  closeButton.addEventListener("click", close);
  power.addEventListener("click", () => setEqEnabled(!getState().settings.eqEnabled));

  file.addEventListener("change", () => {
    const chosen = file.files?.[0];
    if (!chosen) {
      return;
    }
    const name = chosen.name.replace(/\.[^.]+$/, "");
    void chosen
      .text()
      .then((text) => {
        const profile = parseEqProfile(text, name);
        if (!profile) {
          setNotice("That file does not hold a curve Wave can read.");
          return;
        }
        importEqProfile(profile, name);
        setNotice(`Imported ${name}.`);
      })
      .catch(() => setNotice("That file could not be read."))
      .finally(() => {
        file.value = "";
      });
  });

  /** The keys the window still gets while the overlay is up. */
  const PASSTHROUGH = [" ", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

  window.addEventListener(
    "keydown",
    (event) => {
      if (modal.hidden) {
        return;
      }
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      // Held here so a shortcut cannot open a second panel over this one.
      if (!PASSTHROUGH.includes(event.key)) {
        event.stopPropagation();
      }
    },
    true,
  );

  window.addEventListener("resize", () => {
    if (reduceMotionActive() && !modal.hidden) {
      draw();
    }
  });

  subscribe(paint);
  // The curve a rule picks follows the song, so the panel has to follow it too.
  player.onChange(paint);
}

function shellHtml(): string {
  return `
    <section class="eq-graph">
      <canvas class="eq-canvas" id="eq-canvas" tabindex="0" aria-label="Frequency response"></canvas>
      <p class="settings-hint eq-readout" id="eq-readout"></p>
    </section>

    <section class="eq-bands-wrap">
      <div class="eq-bands" id="eq-bands"></div>
      <div class="eq-band-actions">
        <button class="pill" type="button" id="eq-add">Add band</button>
        <button class="pill" type="button" id="eq-flat">Flatten</button>
      </div>
    </section>

    <aside class="eq-side" id="eq-side"></aside>`;
}

/** The word the overlay uses for whatever picked the curve. */
function originWord(origin: EqOrigin): string {
  switch (origin.kind) {
    case "manual":
      return "you";
    case "device":
      return "the output";
    case "preset":
      return "the saved curve";
    default:
      return `the ${origin.kind}`;
  }
}

/** A name long enough to fill the row is cut, with the full one in the title. */
function shorten(value: string): string {
  return value.length > 22 ? `${value.slice(0, 21)}...` : value;
}

function currentTrack(): ReturnType<typeof getState>["tracks"][number] | undefined {
  const id = player.currentId;
  return id ? getState().tracksById.get(id) : undefined;
}

/** Sets an input's value, unless the user is the one filling it in. */
function setValue(root: HTMLElement, selector: string, value: string): void {
  const input = root.querySelector<HTMLInputElement>(selector);
  if (input && document.activeElement !== input && input.value !== value) {
    input.value = value;
  }
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) {
    return low;
  }
  return Math.min(Math.max(value, low), high);
}

function element<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
