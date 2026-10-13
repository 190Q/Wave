const DIALOG_MS = 220;

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  /** Defaults to `Cancel`, for questions whose answer is not one. */
  cancelLabel?: string;
  danger?: boolean;
}

/** Set while the dialog is mounted, so the question can be put to the user. */
let ask: ((options: ConfirmOptions) => Promise<boolean>) | null = null;

/** Asks the question and resolves with the answer. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return ask?.(options) ?? Promise.resolve(false);
}

export function mountConfirm(): void {
  const dialog = element<HTMLDialogElement>("confirm-dialog");
  const title = element("confirm-title");
  const message = element("confirm-message");
  const cancel = element<HTMLButtonElement>("confirm-cancel");
  const accept = element<HTMLButtonElement>("confirm-accept");

  if (!dialog || !title || !message || !cancel || !accept) {
    return;
  }

  /** Resolves the question on screen, `null` while there is none. */
  let settle: ((answer: boolean) => void) | null = null;
  let closeTimer: number | null = null;

  const openDialog = (): void => {
    if (closeTimer !== null) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
    // Start collapsed, then let the stylesheet play it in.
    dialog.classList.add("is-closed");
    if (!dialog.open) {
      dialog.showModal();
    }
    void dialog.offsetWidth;
    dialog.classList.remove("is-closed");
  };

  const closeDialog = (answer: boolean): void => {
    if (!dialog.open || dialog.classList.contains("is-closed")) {
      return;
    }
    dialog.classList.add("is-closed");
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      dialog.close();
      const resolve = settle;
      settle = null;
      resolve?.(answer);
    }, DIALOG_MS);
  };

  cancel.addEventListener("click", () => closeDialog(false));
  accept.addEventListener("click", () => closeDialog(true));

  // Escape and a click on the backdrop both mean no.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog(false);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      closeDialog(false);
    }
  });

  ask = (options) =>
    new Promise((resolve) => {
      // A question already on screen is turned down rather than left hanging.
      settle?.(false);

      title.textContent = options.title;
      message.textContent = options.message;
      accept.textContent = options.confirmLabel;
      cancel.textContent = options.cancelLabel ?? "Cancel";
      accept.classList.toggle("pill-danger", options.danger === true);
      settle = resolve;

      openDialog();
    });
}

function element<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
