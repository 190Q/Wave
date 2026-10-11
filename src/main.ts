import "./assets/icons/icons.css";
import { getState, init, player, setNotice, subscribe } from "./lib/state";
import { mountDock } from "./ui/dock";
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
  mountQueue();
  mountLibrary();
  mountTheme();
  mountStatus();
  mountShortcuts();
  void init();
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
        player.next();
        break;
      case "ArrowLeft":
        event.preventDefault();
        player.previous();
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
