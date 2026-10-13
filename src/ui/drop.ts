import { dialogFits } from "./fit";

/** How far a drop keeps off the bottom of the window. */
const MARGIN = 8;

/** The trigger a drop grows out of; the stylesheet turns it into one shape. */
interface DropTrigger {
  /** The wrapper the shape hangs inside, and where its measurements are set. */
  toggle: HTMLElement;
  /** The button the shape is measured against, and grows out of. */
  face: HTMLElement;
}

interface Drop {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  refresh(): void;
}

/** The markup a panel is built from. */
export interface PanelParts {
  /** The dialog, which opens as a modal while it fits. */
  dialog: HTMLDialogElement;
  /** The dialog's scrolling body, for one that has a body to scroll. */
  body?: HTMLElement | null;
  /** The wrapper the compact drop hangs inside. */
  toggle: HTMLElement;
  /** The button that opens either, and that the drop is measured against. */
  face: HTMLElement;
  /** Puts the modal up, anchored on whatever asked for it. */
  show(anchor: HTMLElement): void;
  /** Takes the modal down. */
  hide(): void;
  /** Fills the compact list. */
  render(): void;
}

export interface Panel {
  /** True while the compact drop is up. */
  readonly isOpen: boolean;
  /** Opens whichever of the two fits, or puts the drop away if it is up. */
  toggle(anchor?: HTMLElement): void;
  /** Re-checks the fit, swapping between the two when the window moves. */
  fit(): void;
  /** Rebuilds the compact list while it is up. */
  refresh(): void;
  /** Puts the compact drop away, for a row that has just run its command. */
  dismiss(): void;
}

/**
 * A panel that is a modal while it fits and the compact drop when it does not,
 * and that swaps between the two as the window moves. All three panels are one
 * of these, so they turn over at the same size and in the same way.
 */
export function createPanel(parts: PanelParts): Panel {
  const { dialog, body, toggle, face, show, hide, render } = parts;
  const drop = createDrop({ toggle, face }, render);

  /** True while the modal is on screen, rather than on its way out. */
  const modalUp = (): boolean => dialog.open && !dialog.classList.contains("is-closed");

  const togglePanel = (anchor: HTMLElement = face): void => {
    if (drop.isOpen) {
      drop.close();
      return;
    }
    // Already up: reopening would only replay the pop.
    if (modalUp()) {
      return;
    }
    if (dialogFits(dialog, body)) {
      show(anchor);
      return;
    }
    drop.open();
  };

  /** Follows the window: whichever of the two fits is the one left standing. */
  const fitPanel = (): void => {
    if (dialogFits(dialog, body)) {
      if (drop.isOpen) {
        drop.close();
        show(face);
      }
      return;
    }
    if (modalUp()) {
      hide();
      drop.open();
    }
  };

  face.addEventListener("click", () => togglePanel());
  window.addEventListener("resize", fitPanel);

  return {
    get isOpen(): boolean {
      return drop.isOpen;
    },
    toggle: togglePanel,
    fit: fitPanel,
    refresh(): void {
      drop.refresh();
    },
    dismiss(): void {
      drop.close();
    },
  };
}

function createDrop(trigger: DropTrigger, render: () => void): Drop {
  const { toggle, face } = trigger;

  let dismiss: (() => void) | null = null;
  let expanded = false;

  /** Where the face's icon starts, so the rows can line up under it. */
  const iconInset = (): number => {
    const icon = face.querySelector<HTMLElement>(".btn-icon");
    if (!icon) {
      return parseFloat(getComputedStyle(face).paddingLeft) || 0;
    }
    return icon.getBoundingClientRect().left - face.getBoundingClientRect().left;
  };

  const fit = (): void => {
    const rect = toggle.getBoundingClientRect();

    toggle.style.setProperty("--drop-h", `${rect.height}px`);
    toggle.style.setProperty("--drop-radius", `${rect.height / 2}px`);
    toggle.style.setProperty("--drop-pad", `${iconInset()}px`);
    toggle.style.setProperty(
      "--drop-max",
      `${Math.max(0, Math.round(window.innerHeight - rect.bottom - MARGIN))}px`,
    );
    toggle.style.setProperty("--drop-left", `${Math.round(rect.left)}px`);
    toggle.style.setProperty("--drop-top", `${Math.round(rect.top)}px`);
  };

  const close = (): void => {
    if (!expanded) {
      return;
    }
    expanded = false;
    toggle.classList.remove("is-open");
    face.setAttribute("aria-expanded", "false");
    dismiss?.();
    dismiss = null;
  };

  const open = (): void => {
    close();

    render();
    expanded = true;
    fit();
    toggle.classList.add("is-open");
    face.setAttribute("aria-expanded", "true");

    // Any of these dismisses it; the opening click is already over by then.
    const onPointerDown = (event: PointerEvent): void => {
      if (!toggle.contains(event.target as Node)) {
        close();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    window.setTimeout(() => {
      document.addEventListener("pointerdown", onPointerDown, true);
    }, 0);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", close, true);
    dismiss = () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", close, true);
    };
  };

  // The trigger moves with the topbar, so the shape has to follow it.
  window.addEventListener("resize", fit);
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(fit).observe(toggle);
  }
  void document.fonts?.ready.then(fit);
  fit();

  return {
    get isOpen(): boolean {
      return expanded;
    },
    open,
    close,
    refresh(): void {
      if (!expanded) {
        return;
      }
      render();
      fit();
    },
  };
}
