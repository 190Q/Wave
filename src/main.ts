import "./assets/icons/icons.css";
import { showMainWindow } from "./lib/ipc";
import { getState, init, player, setNotice, stepTrack, subscribe, whenArtworkReady } from "./lib/state";
import { stepLater } from "./lib/steps";
import { mountDock } from "./ui/dock";
import { mountDockTitle } from "./ui/dock-title";
import { mountHero } from "./ui/hero";
import { mountIcons } from "./ui/icons";
import { mountLibrary } from "./ui/library";
import { mountQueue } from "./ui/queue";
import { mountTheme } from "./ui/theme";
import { mountTitlebar } from "./ui/titlebar";
import { mountTopbar } from "./ui/topbar";

const NOTICE_TIMEOUT_MS = 6000;

function mount(): void {
  mountIcons();
  mountTitlebar();
  mountTopbar();
  mountHero();
  mountDock();
  mountDockTitle();
  mountQueue();
  mountLibrary();
  mountTheme();
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

  window.addEventListener("keydown", (event) => {
    const target = event.target;
    // Never steal keys from a field the user is typing in.
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
      return;
    }
    if (target instanceof HTMLTextAreaElement) {
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
