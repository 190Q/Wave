import { openPath } from "@tauri-apps/plugin-opener";

import { forgetCaptured } from "../lib/analytics";
import { escapeHtml, formatTotalDuration, plural } from "../lib/format";
import { analyticsStats, analyticsSwell, clearAnalytics, resetWindowGeometry } from "../lib/ipc";
import { swellWindow } from "../lib/swell";
import { KEYBIND_GROUPS, SLOT_ACTIONS, SLOT_COUNT, slotLabel } from "../lib/keybinds";
import { SEARCH_ALGORITHMS } from "../lib/search";
import {
  captureWindowSlot,
  getState,
  jobRunning,
  rescanLibrary,
  setNotice,
  subscribe,
  updateSettings,
  type AppState,
} from "../lib/state";
import type {
  AnalyticsStats,
  ReduceMotionMode,
  SearchAlgorithm,
  Settings,
  SwellSummary,
  WindowGeometry,
} from "../types";
import { createPanel } from "./drop";
import { fillIcons } from "./icons";
import { placePicker } from "./picker";

const DIALOG_MS = 220;

/** The settings that are plain on/off switches. */
type ToggleKey =
  | "resumeOnLaunch"
  | "rememberWindow"
  | "normalizeVolume"
  | "analyticsEnabled";

const MOTION_OPTIONS: { value: ReduceMotionMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "on", label: "Reduce" },
  { value: "off", label: "Full" },
];

/** Set while the settings panel is mounted, so a shortcut can open it. */
let openSettingsPanel: (() => void) | null = null;

/** Opens the settings dialog, the same as pressing its button. */
export function openSettings(): void {
  openSettingsPanel?.();
}

export function mountSettings(): void {
  const dialog = element<HTMLDialogElement>("settings-dialog");
  const trigger = element("settings-open");
  const closeButton = element("settings-close");
  const saveButton = element<HTMLButtonElement>("settings-save");
  const body = element("settings-body");
  const dropToggle = element("settings-toggle");
  const dropList = element("settings-drop-list");

  if (!dialog || !trigger || !closeButton || !saveButton || !body || !dropToggle || !dropList) {
    return;
  }

  /** What the panel is editing. Committed only on Save, discarded otherwise. */
  let draft: Settings = { ...getState().settings };

  /** Which slot's inline action list is expanded, if any. */
  let openSlot: number | null = null;

  let closeTimer: number | null = null;

  /** What the Wave Swell section shows. Read afresh whenever the panel opens. */
  let listeningStats: AnalyticsStats | null = null;
  let listeningSwell: SwellSummary | null = null;

  /** Anchors the scale animation on the settings button, so it pops from there. */
  const setOrigin = (): void => {
    const dialogRect = dialog.getBoundingClientRect();
    const buttonRect = trigger.getBoundingClientRect();
    const x = buttonRect.left + buttonRect.width / 2 - dialogRect.left;
    const y = buttonRect.top + buttonRect.height / 2 - dialogRect.top;
    dialog.style.transformOrigin = `${x}px ${y}px`;
  };

  const openDialog = (): void => {
    // Already up: reopening would discard the draft and replay the pop.
    if (dialog.open && !dialog.classList.contains("is-closed")) {
      return;
    }
    if (closeTimer !== null) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
    // Every open starts from what is actually stored.
    draft = { ...getState().settings };
    openSlot = null;
    render();
    // Start collapsed, then let the stylesheet play it in.
    dialog.classList.add("is-closed");
    trigger.classList.add("is-open");
    if (!dialog.open) {
      dialog.showModal();
    }
    setOrigin();
    void dialog.offsetWidth;
    dialog.classList.remove("is-closed");
    placeThumb(false);
    void loadAnalytics();
  };

  const closeDialog = (): void => {
    if (!dialog.open || dialog.classList.contains("is-closed")) {
      return;
    }
    openSlot = null;
    setOrigin();
    dialog.classList.add("is-closed");
    trigger.classList.remove("is-open");
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      dialog.close();
    }, DIALOG_MS);
  };

  /** The panel when it fits, and the compact list when it does not. */
  const panel = createPanel({
    dialog,
    body,
    toggle: dropToggle,
    face: trigger,
    show: openDialog,
    hide: closeDialog,
    render: () => {
      dropList.innerHTML = dropRowsHtml(getState().root);
      fillIcons(dropList);
    },
  });

  const placeSlotPicker = (): void => {
    if (openSlot === null) {
      return;
    }
    const anchor = body.querySelector<HTMLElement>(`[data-slot-open="${openSlot}"]`);
    const picker = body.querySelector<HTMLElement>(".slot-picker");
    if (!anchor || !picker) {
      return;
    }

    placePicker(picker, anchor, dialog.getBoundingClientRect());
  };

  const render = (): void => {
    const state = getState();
    body.innerHTML = [
      playbackHtml(draft),
      appearanceHtml(draft),
      windowHtml(draft),
      libraryHtml(state),
      analyticsHtml(draft, listeningStats, listeningSwell),
      searchHtml(draft),
      shortcutsHtml(draft, state.windowSlots, openSlot),
    ].join("");
    placeSlotPicker();
    placeThumb(false);
    paintSave();
  };

  /** Reads the record's size and this year's figures, for the section below. */
  const loadAnalytics = async (): Promise<void> => {
    const year = swellWindow("year");
    try {
      const [stats, swell] = await Promise.all([
        analyticsStats(),
        analyticsSwell(year.from, year.to, year.bucket),
      ]);
      listeningStats = stats;
      listeningSwell = swell;
    } catch {
      listeningStats = null;
      listeningSwell = null;
    }
    if (dialog.open && !dialog.classList.contains("is-closed")) {
      render();
    }
  };

  /** Only what the draft actually changes, so nothing else is written back. */
  const pendingPatch = (): Partial<Settings> =>
    changedSettings(getState().settings, draft);

  /** There is only something to save while the draft differs from storage. */
  const paintSave = (): void => {
    saveButton.hidden = Object.keys(pendingPatch()).length === 0;
  };

  /** Slides the highlight under the chosen segment, rather than jumping. */
  const placeThumb = (animate: boolean): void => {
    const group = body.querySelector<HTMLElement>(".segmented");
    const thumb = group?.querySelector<HTMLElement>(".segmented-thumb");
    const chosen = group?.querySelector<HTMLElement>(".segment.is-on");
    if (!group || !thumb || !chosen) {
      return;
    }


    thumb.classList.toggle("no-anim", !animate);
    thumb.style.width = `${chosen.offsetWidth}px`;
    thumb.style.transform = `translateX(${chosen.offsetLeft}px)`;

    if (!animate) {
      void thumb.offsetWidth;
      thumb.classList.remove("no-anim");
    }
  };

  body.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const toggle = target.closest<HTMLElement>("[data-toggle]");
    if (toggle?.dataset.toggle) {
      const key = toggle.dataset.toggle as ToggleKey;
      const next = { ...draft };
      next[key] = !next[key];
      draft = next;
      paintToggle(toggle, next[key]);
      paintSave();
      return;
    }

    const motion = target.closest<HTMLElement>("[data-motion]");
    if (motion?.dataset.motion) {
      draft = { ...draft, reduceMotion: motion.dataset.motion as ReduceMotionMode };
      paintChoice(motion, ".segmented", "[data-motion]");
      placeThumb(true);
      paintSave();
      return;
    }

    const algorithm = target.closest<HTMLElement>("[data-algorithm]");
    if (algorithm?.dataset.algorithm) {
      draft = { ...draft, searchAlgorithm: algorithm.dataset.algorithm as SearchAlgorithm };
      paintChoice(algorithm, ".choices", "[data-algorithm]");
      paintSave();
      return;
    }

    const slotTrigger = target.closest<HTMLElement>("[data-slot-open]");
    if (slotTrigger?.dataset.slotOpen) {
      const index = Number(slotTrigger.dataset.slotOpen);
      openSlot = openSlot === index ? null : index;
      render();
      return;
    }

    const slotOption = target.closest<HTMLElement>("[data-slot-set]");
    if (slotOption?.dataset.slotSet) {
      const index = Number(slotOption.dataset.slotSet);
      const action = slotOption.dataset.action ?? "";
      const slots = [...draft.shortcutSlots];
      while (slots.length < SLOT_COUNT) {
        slots.push("");
      }
      slots[index] = action;
      draft = { ...draft, shortcutSlots: slots.slice(0, SLOT_COUNT) };
      openSlot = null;
      if (action.startsWith("snap-window")) {
        void captureWindowSlot(index);
      }
      render();
      return;
    }

    const command = target.closest<HTMLElement>("[data-command]");
    if (command?.dataset.command) {
      void runCommand(command.dataset.command);
    }
  });

  /** The commands act at once; only the values wait for Save. */
  const runCommand = async (command: string): Promise<void> => {
    switch (command) {
      case "open-folder": {
        const { root } = getState();
        if (!root) {
          return;
        }
        try {
          await openPath(root);
        } catch {
          setNotice("Could not open the library folder.");
        }
        return;
      }
      case "rescan":
        await rescanLibrary();
        return;
      case "reset-window":
        try {
          await resetWindowGeometry();
          setNotice("Saved window position forgotten.");
        } catch {
          setNotice("Could not forget the saved window.");
        }
        return;
      case "clear-analytics":
        try {
          forgetCaptured();
          await clearAnalytics();
          await loadAnalytics();
          setNotice("Listening record cleared.");
        } catch {
          setNotice("Could not clear the listening record.");
        }
        return;
      default:
        return;
    }
  };

  /** The compact list runs the same commands as the panel, one row each. */
  dropList.addEventListener("click", (event) => {
    const command = (event.target as HTMLElement).closest<HTMLElement>("[data-command]")?.dataset
      .command;
    if (!command) {
      return;
    }
    panel.dismiss();
    void runCommand(command);
  });

  openSettingsPanel = panel.toggle;
  closeButton.addEventListener("click", closeDialog);

  saveButton.addEventListener("click", () => {
    const patch = pendingPatch();
    if (Object.keys(patch).length === 0) {
      return;
    }
    void updateSettings(patch).then((saved) => {
      if (!saved) {
        return;
      }
      setNotice("Settings saved.");
      draft = { ...getState().settings };
      render();
    });
  });

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      closeDialog();
    }
  });

  // Escape closes natively; intercept it so the same animation plays.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (openSlot !== null) {
      openSlot = null;
      render();
      return;
    }
    closeDialog();
  });

  // A scan, a notice or a shortcut can land while the panel is open, so keep it
  // in step. An edited draft is left alone until it has been saved.
  subscribe(() => {
    if (!dialog.open || dialog.classList.contains("is-closed")) {
      return;
    }
    if (Object.keys(pendingPatch()).length === 0) {
      draft = { ...getState().settings };
    }
    render();
  });

  const dismissPicker = (): void => {
    if (openSlot !== null) {
      openSlot = null;
      render();
    }
  };
  body.addEventListener("scroll", dismissPicker);
  window.addEventListener("resize", dismissPicker);
  window.addEventListener("resize", () => placeThumb(false));
}

function paintToggle(button: HTMLElement, on: boolean): void {
  button.classList.toggle("is-on", on);
  button.setAttribute("aria-checked", String(on));
}

/** Moves the highlight within one group of mutually exclusive buttons. */
function paintChoice(button: HTMLElement, container: string, selector: string): void {
  const group = button.closest(container);
  if (!group) {
    return;
  }
  for (const sibling of group.querySelectorAll<HTMLElement>(selector)) {
    sibling.classList.toggle("is-on", sibling === button);
  }
}

/** The values in `to` that differ from `from`, compared field by field. */
function changedSettings(from: Settings, to: Settings): Partial<Settings> {
  const patch: Partial<Settings> = {};
  for (const key of Object.keys(to) as (keyof Settings)[]) {
    if (!sameValue(from[key], to[key])) {
      patch[key] = to[key] as never;
    }
  }
  return patch;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
  }
  return left === right;
}

function playbackHtml(settings: Settings): string {
  return section(
    "Playback",
    `${toggleRow(
      "resumeOnLaunch",
      "Resume on launch",
      "Restore the queue, cursor and position.",
      settings.resumeOnLaunch,
    )}
    ${toggleRow(
      "normalizeVolume",
      "Normalize volume",
      "Measure each song once and play it at a level gain, so a quiet track is not lost next to a loud one.",
      settings.normalizeVolume,
    )}`,
  );
}

function appearanceHtml(settings: Settings): string {
  const segments = MOTION_OPTIONS.map(
    (option) => `
      <button class="segment${settings.reduceMotion === option.value ? " is-on" : ""}" type="button" data-motion="${option.value}">${escapeHtml(option.label)}</button>`,
  ).join("");

  return section(
    "Appearance",
    `<div class="settings-row">
      <div class="settings-text">
        <span class="settings-label">Reduce motion</span>
        <span class="settings-hint">Overrides the system setting. The theme sweep and the queue wash are the two effects people notice most.</span>
      </div>
      <div class="segmented">
        <span class="segmented-thumb" aria-hidden="true"></span>
        ${segments}
      </div>
    </div>`,
  );
}

function windowHtml(settings: Settings): string {
  return section(
    "Window",
    `${toggleRow(
      "rememberWindow",
      "Remember size and position",
      "Save where the window sat and restore it next launch.",
      settings.rememberWindow,
    )}
    <div class="settings-row">
      <div class="settings-text">
        <span class="settings-label">Saved window</span>
        <span class="settings-hint">Forget the remembered size and position, so the defaults apply again.</span>
      </div>
      <button class="pill" type="button" data-command="reset-window">Reset</button>
    </div>`,
  );
}

function libraryHtml(state: AppState): string {
  const notes: string[] = [];
  if (state.scanning) {
    notes.push("Scanning...");
  } else {
    notes.push(`${plural(state.tracks.length, "track")} in the library`);
    if (state.skipped > 0) {
      notes.push(`${state.skipped} non-audio file${state.skipped === 1 ? "" : "s"} skipped`);
    }
  }

  if (state.analysing) {
    notes.push(`Measuring loudness, ${state.analysing.done} of ${state.analysing.total}`);
  } else {
    const measured = state.tracks.filter((track) => track.lufs !== null).length;
    if (measured > 0 && measured < state.tracks.length) {
      notes.push(`${measured} of ${state.tracks.length} measured for volume`);
    }
  }

  const genres = state.genresProgress;
  if (genres && jobRunning(genres)) {
    notes.push(`Looking up genres, ${genres.done} of ${genres.total}`);
  }

  const errors = state.scanErrors.length
    ? `<ul class="settings-errors">${state.scanErrors
        .map((error) => `<li>${escapeHtml(error)}</li>`)
        .join("")}</ul>`
    : "";

  return section(
    "Library",
    `<div class="settings-row is-stacked">
      <span class="settings-label">Library folder</span>
      ${
        state.root
          ? `<p class="folder-path" title="${escapeHtml(state.root)}">${escapeHtml(state.root)}</p>`
          : `<p class="settings-hint">No library folder yet.</p>`
      }
      <div class="settings-actions">
        <button class="pill" type="button" data-command="open-folder"${state.root ? "" : " disabled"}>Open in Explorer</button>
        <button class="pill" type="button" data-command="rescan"${state.scanning ? " disabled" : ""}>Rescan library</button>
      </div>
      <p class="settings-hint">${escapeHtml(notes.join(". "))}</p>
      ${errors}
    </div>`,
  );
}

function analyticsHtml(
  settings: Settings,
  stats: AnalyticsStats | null,
  swell: SwellSummary | null,
): string {
  const notes: string[] = [];
  if (!settings.analyticsEnabled) {
    notes.push("Switched off, so nothing new is written");
  } else if (!stats) {
    notes.push("Could not be read");
  } else if (stats.plays === 0) {
    notes.push("Nothing played yet");
  } else {
    notes.push(plural(stats.plays, "listen"));
    if (stats.firstPlayAt !== null) {
      notes.push(`since ${new Date(stats.firstPlayAt).toLocaleDateString()}`);
    }
    notes.push(formatSize(stats.sizeBytes));
  }

  const figures =
    swell && swell.plays > 0
      ? `<p class="settings-hint">${escapeHtml(swellLine(swell))}</p>`
      : "";

  return section(
    "Wave Swell",
    `${toggleRow(
      "analyticsEnabled",
      "Keep a listening record",
      "Saves what you play, and what you skip or like, to a database on this computer. It is never sent anywhere; it is what Wave Swell, and any future recommendations, are built from.",
      settings.analyticsEnabled,
    )}
    <div class="settings-row is-stacked">
      <span class="settings-label">Local database</span>
      ${
        stats && stats.path
          ? `<p class="folder-path" title="${escapeHtml(stats.path)}">${escapeHtml(stats.path)}</p>`
          : `<p class="settings-hint">The record could not be opened, so nothing is being kept.</p>`
      }
      <p class="settings-hint">${escapeHtml(notes.join(". "))}.</p>
      ${figures}
      <div class="settings-actions">
        <button class="pill" type="button" data-command="clear-analytics"${
          stats && stats.plays > 0 ? "" : " disabled"
        }>Clear</button>
      </div>
    </div>`,
  );
}

/** One line of the year so far, the same shape the pane opens on. */
function swellLine(swell: SwellSummary): string {
  const parts = [
    `${formatTotalDuration(swell.msListened)} listened in ${new Date().getFullYear()}`,
  ];
  if (swell.plays > 0) {
    parts.push(plural(swell.plays, "stream"));
  }
  const artist = swell.topArtists[0];
  if (artist) {
    parts.push(`top artist ${artist.artist}`);
  }
  if (swell.genresExplored > 0) {
    parts.push(`${plural(swell.genresExplored, "genre")} explored`);
  }
  return `${parts.join(", ")}.`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) {
    return `${Math.round(kilobytes)} KB`;
  }
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}

function searchHtml(settings: Settings): string {
  const choices = SEARCH_ALGORITHMS.map(
    (algorithm) => `
      <button class="choice${settings.searchAlgorithm === algorithm.id ? " is-on" : ""}" type="button" data-algorithm="${algorithm.id}">
        <span class="choice-mark" aria-hidden="true"></span>
        <span class="choice-text">
          <span class="settings-label">${escapeHtml(algorithm.label)}</span>
          <span class="settings-hint">${escapeHtml(algorithm.description)}</span>
        </span>
      </button>`,
  ).join("");

  return section(
    "Search",
    `<p class="settings-hint">Used by every search field, including the library filter.</p><div class="choices">${choices}</div>`,
  );
}

function shortcutsHtml(
  settings: Settings,
  windowSlots: (WindowGeometry | null)[],
  openSlot: number | null,
): string {
  const slots = Array.from({ length: SLOT_COUNT }, (_, index) => {
    const assigned = settings.shortcutSlots[index] ?? "";
    const current = SLOT_ACTIONS.find((action) => action.id === assigned);
    const expanded = openSlot === index;
    const name = escapeHtml(slotLabel(index + 1));
    const note = snapNote(assigned, windowSlots[index] ?? null);

    const picker = expanded
      ? `<div class="slot-picker">
          ${[{ id: "", label: "Unassigned" }, ...SLOT_ACTIONS]
            .map(
              (action) => `
            <button class="slot-option${action.id === assigned ? " is-on" : ""}" type="button" data-slot-set="${index}" data-action="${escapeHtml(action.id)}"${action.id === assigned ? ' aria-current="true"' : ""}>${escapeHtml(action.label)}</button>`,
            )
            .join("")}
        </div>`
      : "";

    return `
      <div class="slot-row">
        <div class="slot-head">
          <span class="slot-key">${name}</span>
          <button class="slot-trigger${expanded ? " is-open" : ""}" type="button" data-slot-open="${index}" aria-expanded="${expanded}" aria-label="${name} action">
            <span class="slot-trigger-label">${escapeHtml(current?.label ?? "Unassigned")}</span>
            <span class="sort-chevron" aria-hidden="true"></span>
          </button>
        </div>
        ${note}
        ${picker}
      </div>`;
  }).join("");

  const reference = KEYBIND_GROUPS.map(
    (group) => `
      <div class="keybind-group">
        <h4 class="keybind-title">${escapeHtml(group.title)}</h4>
        ${group.note ? `<p class="settings-hint">${escapeHtml(group.note)}</p>` : ""}
        ${group.binds
          .map(
            (bind) => `
              <div class="keybind-row">
                <span class="keybind-keys">${escapeHtml(bind.keys)}</span>
                <span class="keybind-action">${escapeHtml(bind.action)}</span>
              </div>`,
          )
          .join("")}
      </div>`,
  ).join("");

  return section(
    "Shortcuts",
    `<div class="settings-row is-stacked">
      <span class="settings-label">Action slots</span>
      <p class="settings-hint">Bound to Ctrl+Shift+1 through Ctrl+Shift+9. A snap slot remembers the window as it stands when you pick it.</p>
      ${slots}
    </div>
    <div class="settings-row is-stacked">
      <span class="settings-label">Keybinds</span>
      ${reference}
    </div>`,
  );
}

/** Where a snap slot will put the window, so the choice is not a guess. */
function snapNote(assigned: string, frame: WindowGeometry | null): string {
  if (!assigned.startsWith("snap-window")) {
    return "";
  }
  if (!frame) {
    return `<p class="settings-hint">No frame saved yet</p>`;
  }

  const what =
    assigned === "snap-window-size"
      ? `Resizes back to ${frame.width}x${frame.height}`
      : assigned === "snap-window-position"
        ? `Moves back to ${frame.x},${frame.y}`
        : `Snaps back to ${frame.width}x${frame.height}`;

  return `<p class="settings-hint">${what}</p>`;
}

/** The compact list: the settings that act at once, rather than waiting for Save. */
function dropRowsHtml(root: string | null): string {
  return `
    <button
      class="drop-item"
      type="button"
      data-command="open-folder"
      aria-label="Open in Explorer"
      title="Open in Explorer"${root ? "" : " disabled"}
    >
      <span class="btn-icon" data-icon="folder"></span>
    </button>`;
}

function section(title: string, inner: string): string {
  return `<section class="settings-section">
    <h3 class="settings-title">${escapeHtml(title)}</h3>
    ${inner}
  </section>`;
}

function toggleRow(key: ToggleKey, label: string, hint: string, on: boolean): string {
  return `
    <div class="settings-row">
      <div class="settings-text">
        <span class="settings-label">${escapeHtml(label)}</span>
        <span class="settings-hint">${escapeHtml(hint)}</span>
      </div>
      <button class="switch${on ? " is-on" : ""}" type="button" role="switch" aria-checked="${on}" data-toggle="${key}" aria-label="${escapeHtml(label)}">
        <span class="switch-knob"></span>
      </button>
    </div>`;
}

function element<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
