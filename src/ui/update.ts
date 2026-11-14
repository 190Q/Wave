import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { device } from "../lib/device";
import { escapeHtml } from "../lib/format";
import { getState, installUpdate, setNotice, subscribe } from "../lib/state";
import type { UpdateInfo, UpdateProgress } from "../types";
import { claimPopup, releasePopup } from "./popups";

/** Matches the dialog's open/close transition in the stylesheet. */
const DIALOG_MS = 220;

/** Set while the popup is mounted, so the settings panel can open it. */
let openUpdatePanel: (() => void) | null = null;

/** Opens the update popup, the same as clicking the notice. */
export function openUpdate(): void {
  openUpdatePanel?.();
}

export function mountUpdate(): void {
  const dialog = element<HTMLDialogElement>("update-dialog");
  const closeButton = element("update-close");
  const body = element("update-body");
  const releaseButton = element<HTMLButtonElement>("update-release");
  const installButton = element<HTMLButtonElement>("update-install");
  const toast = element("update-toast");
  const toastText = element("update-toast-text");
  const toastOpen = element("update-toast-open");
  const toastClose = element("update-toast-close");

  if (
    !dialog ||
    !closeButton ||
    !body ||
    !releaseButton ||
    !installButton ||
    !toast ||
    !toastText ||
    !toastOpen ||
    !toastClose
  ) {
    return;
  }

  /** The version whose notice has been dismissed, so it is not put back up. */
  let dismissed = "";
  /** The `updateFoundAt` a notification has already gone out for. */
  let announcedAt = 0;
  /** Set when the window was away as the notification went out. */
  let waitingForFocus = false;
  /** Set once the window has been in front, so a launch is not counted as away. */
  let seen = false;
  let closeTimer: number | null = null;

  /** The popup's contents for whatever is known right now. */
  const render = (): void => {
    const { update, updateChecking, updateProgress, updateError } = getState();

    if (!update) {
      const line = updateError ?? (updateChecking ? "Looking for a newer version..." : "Wave is up to date.");
      body.innerHTML = `<p class="update-hint">${escapeHtml(line)}</p>`;
      releaseButton.hidden = true;
      installButton.hidden = true;
      return;
    }

    body.innerHTML = [
      versionsHtml(update, getState().appVersion),
      featuresHtml(update),
      update.automatic ? "" : manualHintHtml(),
      updateProgress ? progressHtml(updateProgress) : "",
      updateError ? `<p class="update-hint is-error">${escapeHtml(updateError)}</p>` : "",
    ].join("");

    // Nothing can be chosen while it is coming down.
    const installing = updateProgress !== null;
    releaseButton.hidden = installing;
    releaseButton.textContent = update.automatic ? "View the release" : "Open the release page";
    releaseButton.classList.toggle("pill-strong", !update.automatic);
    installButton.hidden = installing || !update.automatic;
  };

  const openDialog = (): void => {
    if (closeTimer !== null) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
    waitingForFocus = false;
    claimPopup(closeDialog);
    render();
    // Start collapsed, then let the stylesheet play it in.
    dialog.classList.add("is-closed");
    if (!dialog.open) {
      dialog.showModal();
    }
    void dialog.offsetWidth;
    dialog.classList.remove("is-closed");
  };

  const closeDialog = (): void => {
    if (!dialog.open || dialog.classList.contains("is-closed")) {
      return;
    }
    dialog.classList.add("is-closed");
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      dialog.close();
      releasePopup(closeDialog);
    }, DIALOG_MS);
  };

  /** Shows the notice while there is an update the user has not put away. */
  const paintNotice = (): void => {
    const { update } = getState();
    const show = update !== null && update.version !== dismissed;
    toast.hidden = !show;
    if (show && update) {
      toastText.textContent = `Wave ${update.version} is available.`;
    }
  };

  /** Puts the newer release in the system's own notifications. */
  const announce = async (info: UpdateInfo): Promise<void> => {
    // The plugin cannot report a click on a desktop notification, so one sent
    // while the window is away opens the popup when the user comes back. A
    // window that has never been in front is a launch, which is not away.
    waitingForFocus = seen && !document.hasFocus();

    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        granted = (await requestPermission()) === "granted";
      }
      if (!granted) {
        return;
      }
      sendNotification({
        title: `Wave ${info.version} is available`,
        body: info.features[0] ?? "Open Wave to see what is new.",
      });
    } catch {
      // Not running inside Tauri, or the system refused the notification.
    }
  };

  subscribe(() => {
    const { update, updateFoundAt } = getState();
    // Only a check made by this session announces anything, so a version the
    // last session already found is not put up again on every launch.
    if (update && updateFoundAt !== 0 && updateFoundAt !== announcedAt) {
      announcedAt = updateFoundAt;
      void announce(update);
    }
    paintNotice();
    if (dialog.open && !dialog.classList.contains("is-closed")) {
      render();
    }
  });

  closeButton.addEventListener("click", closeDialog);

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && device() !== "android") {
      closeDialog();
    }
  });

  // Escape closes natively; intercept it so the same animation plays.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });

  releaseButton.addEventListener("click", () => {
    const url = getState().update?.url;
    if (url) {
      void openUrl(url).catch(() => {
        setNotice("The release page could not be opened.");
      });
    }
  });

  installButton.addEventListener("click", () => {
    void installUpdate();
  });

  toastOpen.addEventListener("click", openDialog);

  toastClose.addEventListener("click", () => {
    dismissed = getState().update?.version ?? "";
    paintNotice();
  });

  void getCurrentWindow()
    .onFocusChanged(({ payload: focused }) => {
      if (!focused) {
        return;
      }
      seen = true;
      if (waitingForFocus) {
        openDialog();
      }
    })
    .catch(() => {
      // Not running inside Tauri, for example `npm run dev` in a browser.
    });

  openUpdatePanel = openDialog;
  paintNotice();
}

/** The line naming the version running and the one on offer. */
function versionsHtml(info: UpdateInfo, current: string): string {
  const parts = [`Wave ${info.version} is available.`];
  if (current && current !== info.version) {
    parts.push(`You are on ${current}.`);
  }
  const released = releaseDate(info.publishedAt);
  if (released) {
    parts.push(`Released ${released}.`);
  }
  return `<p class="update-versions">${escapeHtml(parts.join(" "))}</p>`;
}

function releaseDate(publishedAt: string): string {
  const at = new Date(publishedAt);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleDateString();
}

/** What the release lists as new, when it lists anything. */
function featuresHtml(info: UpdateInfo): string {
  if (info.features.length === 0) {
    return "";
  }
  const rows = info.features.map((feature) => `<li>${escapeHtml(feature)}</li>`).join("");
  return `<p class="update-label">New in this release</p><ul class="update-features">${rows}</ul>`;
}

/** Why this copy cannot replace itself. */
function manualHintHtml(): string {
  return `<p class="update-hint">This copy was installed by a package manager, so Wave cannot replace it on its own. Take the newer release and install it the same way.</p>`;
}

/** How far the download has got. */
function progressHtml(progress: UpdateProgress): string {
  const percent =
    progress.total > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0;
  const size =
    progress.total > 0
      ? `${formatBytes(progress.received)} of ${formatBytes(progress.total)}`
      : formatBytes(progress.received);

  return `<div class="update-progress"><span class="update-progress-bar" style="width: ${percent}%"></span></div>
    <p class="update-hint">Downloading, ${escapeHtml(size)}. Wave restarts itself when it is ready.</p>`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) {
    return `${Math.round(kilobytes)} KB`;
  }
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}

function element<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
