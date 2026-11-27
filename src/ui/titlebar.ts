import { getCurrentWindow } from "@tauri-apps/api/window";

import { setIcon } from "../assets/icons/index";
import { isAndroidPlatform } from "../lib/device";
import { resetWindowGeometry, saveWindowGeometry } from "../lib/ipc";
import { flushSession, getState, subscribe } from "../lib/state";

const GEOMETRY_SAVE_DELAY_MS = 500;

export function mountTitlebar(): void {
  const updateVisibility = (): void => {
    const preference = getState().settings.showTitlebar;
    const visibility = preference == null ? "auto" : preference ? "shown" : "hidden";
    if (document.documentElement.dataset.titlebar !== visibility) {
      document.documentElement.dataset.titlebar = visibility;
    }
  };
  subscribe(updateVisibility);
  updateVisibility();

  const minimise = element("window-minimise");
  const maximise = element<HTMLButtonElement>("window-maximise");
  const close = element("window-close");

  const maximiseIcon = maximise?.querySelector<HTMLElement>(".btn-icon") ?? null;

  if (!minimise || !maximise || !maximiseIcon || !close) {
    return;
  }

  try {
    const appWindow = getCurrentWindow();

    const paintMaximise = (maximised: boolean): void => {
      setIcon(maximiseIcon, maximised ? "restore" : "maximise");
      maximise.setAttribute("aria-label", maximised ? "Restore" : "Maximise");
    };

    minimise.addEventListener("click", () => void appWindow.minimize());
    maximise.addEventListener("click", () => void appWindow.toggleMaximize());

    // Shift-clicking the close button forgets the remembered window geometry.
    let resetGeometry = false;
    let geometryTimer: number | null = null;
    close.addEventListener("click", (event) => {
      resetGeometry = event.shiftKey;
      void appWindow.close();
    });
    // Save the session, including where the current track had reached, before
    // the window is allowed to close.
    let closing = false;
    void appWindow.onCloseRequested(async (event) => {
      if (closing) {
        return;
      }
      closing = true;
      event.preventDefault();
      if (geometryTimer !== null) {
        window.clearTimeout(geometryTimer);
        geometryTimer = null;
      }

      try {
        await flushSession();
      } catch {
        // Closing matters more than a failed save.
      }

      try {
        await (resetGeometry ? resetWindowGeometry() : saveWindowGeometry());
      } catch {
        // A failed geometry write should not block the close.
      }

      try {
        await appWindow.destroy();
      } catch {
        // `destroy` can be denied; fall back to a normal close, now unguarded.
        await appWindow.close();
      }
    }).catch(() => {});

    if (!isAndroidPlatform) {
      const saveGeometryLater = (): void => {
        if (closing) {
          return;
        }
        if (geometryTimer !== null) {
          window.clearTimeout(geometryTimer);
        }
        geometryTimer = window.setTimeout(() => {
          geometryTimer = null;
          void saveWindowGeometry().catch(() => {});
        }, GEOMETRY_SAVE_DELAY_MS);
      };
      void appWindow.isMaximized().then(paintMaximise).catch(() => {});
      void appWindow.onResized(() => {
        void appWindow.isMaximized().then(paintMaximise).catch(() => {});
        saveGeometryLater();
      }).catch(() => {});
      void appWindow.onMoved(saveGeometryLater).catch(() => {});
    }
  } catch {
    // Not running inside Tauri, for example `npm run dev` in a browser.
  }
}

function element<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
