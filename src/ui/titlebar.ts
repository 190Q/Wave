import { getCurrentWindow } from "@tauri-apps/api/window";

import { setIcon } from "../assets/icons/index";
import { resetWindowGeometry, saveWindowGeometry } from "../lib/ipc";
import { flushSession } from "../lib/state";

export function mountTitlebar(): void {
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
    });

    void appWindow.isMaximized().then(paintMaximise);
    void appWindow.onResized(() => {
      void appWindow.isMaximized().then(paintMaximise);
    });
  } catch {
    // Not running inside Tauri, for example `npm run dev` in a browser.
  }
}

function element<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
