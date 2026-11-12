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

/** Forgets the claim, once a popup has finished closing. */
export function releasePopup(dismiss: Dismiss): void {
  if (showing === dismiss) {
    showing = null;
  }
}
