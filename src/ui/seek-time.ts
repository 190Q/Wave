import { isTouch } from "../lib/device";
import { formatDuration } from "../lib/format";
import { player } from "../lib/state";
import { claimPopup, releasePopup } from "./popups";

const DIALOG_MS = 220;

let openDialog: (() => void) | null = null;

export function openSeekTime(): void {
  openDialog?.();
}

export function parseSeekTime(value: string): number | null {
  const parts = value.trim().split(":");
  if (parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    return null;
  }
  const numbers = parts.map(Number);
  if (numbers.slice(1).some((part) => part >= 60)) {
    return null;
  }
  const milliseconds = numbers.reduce((total, part) => total * 60 + part, 0) * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

export function mountSeekTime(): void {
  const dialog = document.getElementById("seek-dialog") as HTMLDialogElement | null;
  const form = document.getElementById("seek-form") as HTMLFormElement | null;
  const input = document.getElementById("seek-input") as HTMLInputElement | null;
  const hint = document.getElementById("seek-hint");
  const error = document.getElementById("seek-error");
  const cancel = document.getElementById("seek-cancel");
  if (!dialog || !form || !input || !hint || !error || !cancel) {
    return;
  }

  let currentId: string | null = null;
  let closeTimer: number | null = null;

  const close = (): void => {
    if (!dialog.open || dialog.classList.contains("is-closed")) {
      return;
    }
    dialog.classList.add("is-closed");
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      dialog.close();
      currentId = null;
      releasePopup(close);
    }, DIALOG_MS);
  };

  const clearError = (): void => {
    error.hidden = true;
    error.textContent = "";
    input.setCustomValidity("");
    input.removeAttribute("aria-invalid");
  };

  openDialog = () => {
    const snapshot = player.snapshot();
    if (!snapshot.currentId) {
      return;
    }
    if (closeTimer !== null) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
    currentId = snapshot.currentId;
    input.value = formatDuration(snapshot.positionMs);
    hint.textContent = `Enter seconds, m:ss or h:mm:ss${snapshot.durationMs > 0 ? `, up to ${formatDuration(snapshot.durationMs)}` : ""}.`;
    clearError();
    claimPopup(close);
    dialog.classList.add("is-closed");
    if (!dialog.open) {
      dialog.showModal();
    }
    void dialog.offsetWidth;
    dialog.classList.remove("is-closed");
    input.focus();
    if (!isTouch()) {
      input.select();
    }
  };

  cancel.addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      close();
    }
  });
  input.addEventListener("input", clearError);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const snapshot = player.snapshot();
    if (!currentId || snapshot.currentId !== currentId) {
      close();
      return;
    }
    const position = parseSeekTime(input.value);
    const message = position === null
      ? "Enter a time in seconds, m:ss or h:mm:ss."
      : snapshot.durationMs > 0 && position > snapshot.durationMs
        ? `Enter a time up to ${formatDuration(snapshot.durationMs)}.`
        : "";
    if (message) {
      error.textContent = message;
      error.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.setCustomValidity(message);
      if (document.documentElement.classList.contains("is-mini-player")) {
        input.reportValidity();
      } else {
        input.focus();
      }
      return;
    }
    player.seek(position!);
    close();
  });
  player.onChange((snapshot) => {
    if (currentId && snapshot.currentId !== currentId) {
      close();
    }
  });
}
