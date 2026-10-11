import { getCurrentWindow } from "@tauri-apps/api/window";

import { setIcon } from "../assets/icons/index";

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
    close.addEventListener("click", () => void appWindow.close());

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
