/** How far a picker keeps off the edge of the frame it is placed inside. */
const MARGIN = 8;

/** The gap between a trigger and the picker hanging off it. */
const GAP = 6;

/** Below this, a side counts as having no room and the other one is preferred. */
const MIN_ROOM = 96;

/** The edges a picker is kept inside. */
export interface Frame {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Which side of its trigger a picker would rather hang off. */
export type PickerSide = "above" | "below";

/** The window, for a picker that is free to hang outside the dialog it sits in. */
export function windowFrame(): Frame {
  return { top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0 };
}

/**
 * Places a picker against its trigger: on the side it prefers, flipped to the
 * other one when that side is too tight and the other has more room. It takes
 * the trigger's width, is capped to the room it has, and never covers the
 * trigger.
 */
export function placePicker(
  picker: HTMLElement,
  trigger: HTMLElement,
  frame: Frame,
  preferred: PickerSide = "below",
): void {
  const rect = trigger.getBoundingClientRect();
  const width = trigger.offsetWidth;

  const roomAbove = rect.top - frame.top - GAP - MARGIN;
  const roomBelow = frame.bottom - rect.bottom - GAP - MARGIN;

  let above = preferred === "above";
  const room = above ? roomAbove : roomBelow;
  if (room < MIN_ROOM && (above ? roomBelow : roomAbove) > room) {
    above = !above;
  }

  picker.style.maxHeight = `${Math.max(MIN_ROOM, above ? roomAbove : roomBelow)}px`;
  const height = picker.offsetHeight;

  const top = above
    ? Math.max(frame.top + MARGIN, rect.top - GAP - height)
    : Math.min(frame.bottom - MARGIN - height, rect.bottom + GAP);
  const left = Math.min(Math.max(rect.left, frame.left + MARGIN), frame.right - width - MARGIN);

  picker.style.width = `${width}px`;
  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;
}
