import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { device } from "../lib/device";
import { getState, subscribe } from "../lib/state";
import { dismissPopup } from "./popups";

export function mountMiniPlayer(): void {
  const root = document.documentElement;
  const title = document.getElementById("dock-title");

  const render = (): void => {
    const mini = device() === "desktop" && getState().settings.miniPlayer;
    if (mini && !root.classList.contains("is-mini-player")) {
      dismissPopup();
    }
    root.classList.toggle("is-mini-player", mini);
    title?.setAttribute("aria-hidden", String(!mini));
  };

  title?.addEventListener("pointerdown", (event) => {
    if (!root.classList.contains("is-mini-player") || event.button !== 0 || !isTauri()) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void getCurrentWindow().startDragging().catch(() => {});
  });

  subscribe(render);
  render();
}
