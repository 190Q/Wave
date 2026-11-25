import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { setBackground, setScreenBlanked } from "./activity";
import { device, isAndroidPlatform, isWebKitGtk } from "./device";

export function mountActivity(): void {
  if (device() === "linuxPhone") {
    let revision = 0;
    const background = (value: boolean): void => {
      revision += 1;
      setBackground(value);
    };
    window.addEventListener("blur", () => background(true));
    window.addEventListener("focus", () => background(false));
    window.addEventListener("pointerdown", () => background(false), true);
    window.addEventListener("keydown", () => background(false), true);
    if (isTauri()) {
      const current = getCurrentWindow();
      void current.onFocusChanged(({ payload }) => background(!payload)).then(() => {
        const previous = revision;
        return current.isFocused().then((focused) => {
          if (revision === previous) background(!focused);
        });
      }).catch(() => {});
    }
  }

  if (isTauri() && isWebKitGtk && !isAndroidPlatform) {
    let revision = 0;
    void listen<boolean>("screen-blanked", ({ payload }) => {
      revision += 1;
      setScreenBlanked(payload);
    }).then(() => {
      const previous = revision;
      return invoke<boolean>("screen_blanked").then((blanked) => {
        if (revision === previous) setScreenBlanked(blanked);
      });
    }).catch(() => {});
  }
}
