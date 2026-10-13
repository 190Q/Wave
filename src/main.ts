import "./assets/icons/icons.css";
import { showMainWindow } from "./lib/ipc";
import { mountMotion } from "./lib/motion";
import {
  getState,
  init,
  player,
  setNotice,
  stepTrack,
  subscribe,
  toggleAlwaysOnTop,
  toggleMiniPlayer,
  toggleQueue,
  whenArtworkReady,
} from "./lib/state";
import { stepLater } from "./lib/steps";
import { runSlotAction } from "./ui/actions";
import { mountConfirm } from "./ui/confirm";
import { mountDock, stepVolumeFromKey } from "./ui/dock";
import { mountDockTitle } from "./ui/dock-title";
import { mountHero } from "./ui/hero";
import { mountIcons } from "./ui/icons";
import { mountLibrary } from "./ui/library";
import { mountQueue } from "./ui/queue";
import { mountSettings, openSettings } from "./ui/settings";
import { mountTheme } from "./ui/theme";
import { mountTitlebar } from "./ui/titlebar";
import { chooseFolder, focusSearch, mountTopbar } from "./ui/topbar";

const NOTICE_TIMEOUT_MS = 6000;

function mount(): void {
  mountIcons();
  mountMotion();
  mountTitlebar();
  mountTopbar();
  mountHero();
  mountDock();
  mountDockTitle();
  mountQueue();
  mountLibrary();
  mountConfirm();
  mountTheme();
  mountSettings();
  mountStatus();
  mountShortcuts();
  revealWhenReady();
}

/** The window stays hidden until the theme and current song are applied. */
function revealWhenReady(): void {
  void init()
    .then(() => whenArtworkReady())
    .catch(() => {
      // A failed boot should still reveal the window.
    })
    .finally(() => {
      void showMainWindow();
    });
}

function mountStatus(): void {
  const status = document.getElementById("status");
  if (!status) {
    return;
  }

  let shown: string | null = null;
  let timer: number | null = null;

  const render = (): void => {
    const { notice, ready, scanning, tracks } = getState();

    const message =
      notice ??
      (scanning
        ? "Scanning your library..."
        : !ready
          ? "Starting..."
          : tracks.length === 0
            ? "Import a folder to get started."
            : null);

    // Notices are transient; the standing hints are not.
    if (notice !== shown) {
      shown = notice;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (notice) {
        timer = window.setTimeout(() => setNotice(null), NOTICE_TIMEOUT_MS);
      }
    }

    status.textContent = message ?? "";
    status.hidden = message === null;
  };

  subscribe(render);
  render();
}

function mountShortcuts(): void {
  window.addEventListener("contextmenu", (event) => event.preventDefault());

  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());

  const root = document.documentElement;
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Tab") {
        root.classList.add("is-tabbing");
      }
    },
    true,
  );
  window.addEventListener("pointerdown", () => root.classList.remove("is-tabbing"), true);

  let miniHeld = false;
  let cornerPicked = false;

  window.addEventListener("keyup", (event) => {
    if (event.key !== "m" && event.key !== "M") {
      return;
    }
    const toggles = miniHeld && !cornerPicked;
    miniHeld = false;
    cornerPicked = false;
    if (toggles) {
      void toggleMiniPlayer();
    }
  });

  // Losing focus mid-chord swallows the keyup, so the next `m` starts clean.
  window.addEventListener("blur", () => {
    miniHeld = false;
    cornerPicked = false;
  });

  window.addEventListener("keydown", (event) => {
    const target = event.target;
    // Never steal keys from a field the user is typing in.
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
      return;
    }
    if (target instanceof HTMLTextAreaElement) {
      return;
    }

    if (event.ctrlKey && event.shiftKey && !event.altKey) {
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (digit) {
        const slot = Number(digit) - 1;
        const action = getState().settings.shortcutSlots[slot];
        if (action) {
          event.preventDefault();
          void runSlotAction(action, slot);
          return;
        }
      }
    }

    // A modified key belongs to the OS or to a slot, never to the plain keys.
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }

    const corner =
      miniHeld && !event.repeat ? /^Digit([1-4])$/.exec(event.code)?.[1] : undefined;
    if (corner) {
      event.preventDefault();
      cornerPicked = true;
      void toggleMiniPlayer(Number(corner));
      return;
    }

    switch (event.key) {
      case " ":
        event.preventDefault();
        player.toggle();
        break;
      case "ArrowRight":
        event.preventDefault();
        stepLater(1, stepTrack);
        break;
      case "ArrowLeft":
        event.preventDefault();
        stepLater(-1, stepTrack);
        break;
      case "ArrowUp":
        event.preventDefault();
        stepVolumeFromKey(1);
        break;
      case "ArrowDown":
        event.preventDefault();
        stepVolumeFromKey(-1);
        break;
      case "o":
      case "O":
        event.preventDefault();
        focusSearch();
        break;
      case "s":
      case "S":
        event.preventDefault();
        player.setShuffle(!player.snapshot().shuffle);
        break;
      case "r":
      case "R":
        event.preventDefault();
        player.cycleRepeat();
        break;
      case "q":
      case "Q":
        event.preventDefault();
        toggleQueue();
        break;
      case "i":
      case "I":
        event.preventDefault();
        chooseFolder();
        break;
      case "p":
      case "P":
        event.preventDefault();
        openSettings();
        break;
      case "t":
      case "T":
        event.preventDefault();
        void toggleAlwaysOnTop();
        break;
      case "m":
      case "M":
        event.preventDefault();
        if (!event.repeat) {
          miniHeld = true;
          cornerPicked = false;
        }
        break;
      default:
        break;
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
