/** Told to a popup when another one has taken the screen. */
type Dismiss = () => void;

/** The popup holding the screen, `null` while there is none. */
let showing: Dismiss | null = null;

/**
 * Marks a popup as the one on screen. Whatever held the screen before it is
 * told to go, so only the newest popup is ever left standing. A popup already
 * on screen claims it again rather than dismissing itself.
 */
export function claimPopup(dismiss: Dismiss): void {
  const previous = showing;
  showing = dismiss;
  if (previous !== null && previous !== dismiss) {
    previous();
  }
}

export function claimPopupIfFree(dismiss: Dismiss): void {
  if (showing === null) {
    showing = dismiss;
  }
}

export function isOtherPopupShowing(dismiss: Dismiss): boolean {
  return showing !== null && showing !== dismiss;
}

/** Forgets the claim, once a popup has finished closing. */
export function releasePopup(dismiss: Dismiss): void {
  if (showing === dismiss) {
    showing = null;
  }
}

export function dismissPopup(): void {
  showing?.();
}

export function listenForPress(
  target: EventTarget,
  listener: (event: Event) => void,
  capture = false,
): () => void {
  target.addEventListener("pointerdown", listener, capture);
  target.addEventListener("touchstart", listener, { capture, passive: true });
  target.addEventListener("click", listener, capture);
  return () => {
    target.removeEventListener("pointerdown", listener, capture);
    target.removeEventListener("touchstart", listener, capture);
    target.removeEventListener("click", listener, capture);
  };
}

export function listenForBackdropPress(backdrop: HTMLElement, dismiss: Dismiss): void {
  const onPress = (event: Event): void => {
    if (event.target !== backdrop) return;
    // A click after dragging can be retargeted to the backdrop.
    if (event.type === "click" && (event as MouseEvent).detail !== 0) return;
    if (
      (event.type === "pointerdown" || event.type === "mousedown")
      && (event as MouseEvent).button !== 0
    ) return;
    dismiss();
  };
  listenForPress(backdrop, onPress);
  backdrop.addEventListener("mousedown", onPress);
}
