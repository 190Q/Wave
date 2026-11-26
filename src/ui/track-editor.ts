import { device, isTouch } from "../lib/device";
import { editTrack, getState } from "../lib/state";
import type { TrackMetadata } from "../types";
import { claimPopup, listenForBackdropPress, releasePopup } from "./popups";

const DIALOG_MS = 220;

let openEditor: ((trackId: string) => void) | null = null;

export function openTrackEditor(trackId: string): void {
  openEditor?.(trackId);
}

export function mountTrackEditor(): void {
  const dialog = document.getElementById("track-editor-dialog") as HTMLDialogElement | null;
  const form = document.getElementById("track-editor-form") as HTMLFormElement | null;
  const cancel = document.getElementById("track-editor-cancel") as HTMLButtonElement | null;
  const save = document.getElementById("track-editor-save") as HTMLButtonElement | null;
  const error = document.getElementById("track-editor-error");
  if (!dialog || !form || !cancel || !save || !error) {
    return;
  }

  const field = (name: keyof TrackMetadata): HTMLInputElement =>
    form.elements.namedItem(name) as HTMLInputElement;
  let currentId: string | null = null;
  let saving = false;
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

  openEditor = (trackId) => {
    const track = getState().tracksById.get(trackId);
    if (!track || saving) {
      return;
    }
    if (closeTimer !== null) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
    currentId = trackId;
    for (const name of ["title", "artist", "album", "albumArtist", "genre", "year", "trackNo", "discNo"] as const) {
      field(name).value = String(track[name] ?? "");
    }
    field("title").setCustomValidity("");
    error.hidden = true;
    error.textContent = "";
    claimPopup(close);
    dialog.classList.add("is-closed");
    if (!dialog.open) {
      dialog.showModal();
    }
    void dialog.offsetWidth;
    dialog.classList.remove("is-closed");
    if (!isTouch()) {
      field("title").focus();
    }
  };

  cancel.addEventListener("click", () => {
    if (!saving) {
      close();
    }
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (!saving) {
      close();
    }
  });
  listenForBackdropPress(dialog, () => {
    if (!saving && device() !== "linuxPhone") {
      close();
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!currentId || saving) {
      return;
    }
    const title = field("title").value.trim();
    if (!title) {
      field("title").setCustomValidity("Enter a title.");
      field("title").reportValidity();
      return;
    }
    const text = (name: keyof TrackMetadata): string | null => field(name).value.trim() || null;
    const number = (name: keyof TrackMetadata): number | null =>
      field(name).value === "" ? null : field(name).valueAsNumber;
    const metadata: TrackMetadata = {
      title,
      artist: text("artist"),
      album: text("album"),
      albumArtist: text("albumArtist"),
      genre: text("genre"),
      year: number("year"),
      trackNo: number("trackNo"),
      discNo: number("discNo"),
    };
    saving = true;
    save.disabled = true;
    cancel.disabled = true;
    error.hidden = true;
    void editTrack(currentId, metadata)
      .then(close)
      .catch((reason: unknown) => {
        error.textContent = reason instanceof Error ? reason.message : String(reason);
        error.hidden = false;
      })
      .finally(() => {
        saving = false;
        save.disabled = false;
        cancel.disabled = false;
      });
  });

  field("title").addEventListener("input", () => field("title").setCustomValidity(""));
}
