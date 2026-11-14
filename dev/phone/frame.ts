import type { Insets } from "../../src/lib/device";
import type { SimBridge } from "../../src/lib/mock/bridge";
import type { MediaControl } from "../../src/types";

interface Preset {
  id: string;
  label: string;
  width: number;
  height: number;
  dpr: number;
  /** The bars the system draws, which is what the app insets itself by. */
  statusBar: number;
  cutout: number;
  gestureBar: number;
}

const PRESETS: Preset[] = [
  { id: "compact", label: "360 x 720 at 3x", width: 360, height: 720, dpr: 3, statusBar: 24, cutout: 12, gestureBar: 20 },
  { id: "pixel", label: "412 x 915 at 2.625x", width: 412, height: 915, dpr: 2.625, statusBar: 28, cutout: 16, gestureBar: 24 },
  { id: "tall", label: "390 x 844 at 3x", width: 390, height: 844, dpr: 3, statusBar: 34, cutout: 18, gestureBar: 21 },
];

/** Fired when the system's insets move. device.ts listens for it. */
const INSETS_EVENT = "wave:insets";

/** The key device.ts remembers the kind under. Both pages share this storage. */
const DEVICE_KEY = "wave:device";

const POLL_MS = 500;
const CLOCK_MS = 30_000;

function main(): void {
  const phone = element("phone");
  const app = element<HTMLIFrameElement>("app");
  const status = element("status");
  const statusTime = element("status-time");
  const cutout = element("cutout");
  const gesture = element("gesture");
  const note = element("note");
  const presetSelect = element<HTMLSelectElement>("preset");
  const kindSelect = element<HTMLSelectElement>("kind");
  const cutoutSelect = element<HTMLSelectElement>("cutout-shape");
  const lyrics = element<HTMLInputElement>("lyrics");
  const reloadButton = element<HTMLButtonElement>("reload");
  const lockNow = element("lock-now");
  const seek = element<HTMLInputElement>("seek");

  if (
    !phone ||
    !app ||
    !status ||
    !statusTime ||
    !cutout ||
    !gesture ||
    !note ||
    !presetSelect ||
    !kindSelect ||
    !cutoutSelect ||
    !lyrics ||
    !reloadButton ||
    !lockNow ||
    !seek
  ) {
    return;
  }

  let preset = PRESETS[0];
  let kind = storedKind();
  let cutoutShape = "notch";
  let seeking = false;

  /** What the system would report for the phone on screen. */
  const insets = (): Insets =>
    kind === "desktop"
      ? { top: 0, right: 0, bottom: 0, left: 0 }
      : {
          top: preset.statusBar + (cutoutShape === "none" ? 0 : preset.cutout),
          right: 0,
          bottom: preset.gestureBar,
          left: 0,
        };

  const bridge = (): SimBridge | undefined => app.contentWindow?.__WAVE_SIM__;

  /** The frame's own Event, so the app's listener runs in its own realm. */
  const dispatch = (frame: Window, name: string): void => {
    const made = new (frame as unknown as { Event: typeof Event }).Event(name);
    frame.dispatchEvent(made);
  };

  /** Paints the insets into the held page, which is what device.ts reads. */
  const applyInsets = (): void => {
    const values = insets();
    phone.style.setProperty("--status-height", `${values.top}px`);
    phone.style.setProperty("--gesture-height", `${values.bottom}px`);
    status.hidden = values.top === 0;
    gesture.hidden = values.bottom === 0;
    cutout.hidden = values.top === 0 || cutoutShape === "none";
    cutout.classList.toggle("is-hole", cutoutShape === "hole");

    const frame = app.contentWindow;
    if (!frame) {
      return;
    }
    frame.__WAVE_INSETS__ = values;
    dispatch(frame, INSETS_EVENT);
  };

  /** The page to hold, carrying what the app reads before it can be told. */
  const screenUrl = (): string => {
    const values = insets();
    const params = new URLSearchParams({
      dpr: String(preset.dpr),
      insetTop: String(values.top),
      insetRight: String(values.right),
      insetBottom: String(values.bottom),
      insetLeft: String(values.left),
    });
    return `app.html?${params.toString()}`;
  };

  const reload = (): void => {
    app.src = screenUrl();
  };

  const paintNote = (): void => {
    const held = bridge()?.summary();
    const values = insets();
    note.textContent = [
      `${preset.width} x ${preset.height} at ${preset.dpr}x`,
      `insets ${values.top}/${values.right}/${values.bottom}/${values.left}`,
      held ? `${held.tracks} tracks, ${held.playlists} playlists, ${held.likes} likes` : "loading the fixture",
      lyrics.checked ? "lyrics on" : "lyrics off",
    ].join(". ");
  };

  const paintLockscreen = (): void => {
    const song = bridge()?.nowPlaying() ?? null;
    lockNow.textContent = song
      ? `${song.title}, ${song.artist || "unknown artist"}${song.playing ? "" : ", paused"}`
      : "Nothing has been reported to the system controls yet.";
    if (!seeking) {
      const fraction = song && song.durationMs > 0 ? song.positionMs / song.durationMs : 0;
      seek.value = String(Math.round(Math.min(Math.max(fraction, 0), 1) * 1000));
    }
  };

  const paint = (): void => {
    paintNote();
    paintLockscreen();
  };

  /** The whole phone, after a preset change or the first paint. */
  const applyPreset = (): void => {
    phone.style.setProperty("--screen-width", `${preset.width}px`);
    phone.style.setProperty("--screen-height", `${preset.height}px`);

    const frame = app.contentWindow;
    if (frame) {
      frame.__WAVE_DPR__ = preset.dpr;
    }
    applyInsets();
    paint();
  };

  const emit = (action: MediaControl["action"], value: number | null = null): void => {
    const control: MediaControl = { action, value };
    bridge()?.emit("media-control", control);
  };

  const paintClock = (): void => {
    const now = new Date();
    statusTime.textContent = `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
  };

  presetSelect.innerHTML = PRESETS.map(
    (entry) => `<option value="${entry.id}">${entry.label}</option>`,
  ).join("");
  presetSelect.value = preset.id;
  kindSelect.value = kind;
  cutoutSelect.value = cutoutShape;

  // The two pages are same-origin, so this is the storage device.ts reads.
  localStorage.setItem(DEVICE_KEY, kind);

  presetSelect.addEventListener("change", () => {
    preset = PRESETS.find((entry) => entry.id === presetSelect.value) ?? PRESETS[0];
    applyPreset();
  });

  cutoutSelect.addEventListener("change", () => {
    cutoutShape = cutoutSelect.value;
    applyInsets();
    paint();
  });

  kindSelect.addEventListener("change", () => {
    kind = kindSelect.value;
    localStorage.setItem(DEVICE_KEY, kind);
    // The frame's own bars follow at once; the held page follows its reload.
    applyInsets();
    paint();
    reload();
  });

  lyrics.addEventListener("change", () => {
    bridge()?.setLyricsAvailable(lyrics.checked);
    paintNote();
  });

  reloadButton.addEventListener("click", reload);

  app.addEventListener("load", () => {
    applyInsets();
    paint();
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-control]")) {
    button.addEventListener("click", () => {
      emit((button.dataset.control ?? "toggle") as MediaControl["action"]);
    });
  }

  // The slider is not repainted while it is being dragged, so it does not fight back.
  seek.addEventListener("pointerdown", () => {
    seeking = true;
  });
  seek.addEventListener("pointerup", () => {
    seeking = false;
  });
  seek.addEventListener("change", () => {
    seeking = false;
    const song = bridge()?.nowPlaying() ?? null;
    if (song && song.durationMs > 0) {
      emit("seekTo", Math.round((Number(seek.value) / 1000) * song.durationMs));
    }
  });

  window.setInterval(paintLockscreen, POLL_MS);
  window.setInterval(paintClock, CLOCK_MS);

  paintClock();
  reload();
  applyPreset();
}

/** The kind last chosen, with anything else read as Android. */
function storedKind(): string {
  const kept = localStorage.getItem(DEVICE_KEY);
  return kept === "linuxPhone" || kept === "desktop" ? kept : "android";
}

function element<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

main();
