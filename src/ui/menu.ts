import { insets, isTouch, ZERO_INSETS } from "../lib/device";
import { escapeHtml } from "../lib/format";
import { claimPopup, listenForPress, releasePopup } from "./popups";

export interface MenuItem {
  label: string;
  action: () => void;
  /** Rendered in the warning colour, for destructive entries. */
  danger?: boolean;
  disabled?: boolean;
  /** Marks the currently selected entry, for menus that act as a picker. */
  active?: boolean;
}

/** Where a menu opened from a right-click should appear, in viewport pixels. */
export interface MenuPoint {
  x: number;
  y: number;
}

let open: HTMLElement | null = null;
let dismiss: (() => void) | null = null;

export function openMenu(
  anchor: HTMLElement,
  items: MenuItem[],
  at?: MenuPoint,
  options?: { fitViewport?: boolean },
): void {
  closeMenu();

  if (items.length === 0) {
    return;
  }

  claimPopup(closeMenu);

  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = items
    .map((item, index) => {
      const classes = ["menu-item"];
      if (item.danger) {
        classes.push("is-danger");
      }
      if (item.active) {
        classes.push("is-active");
      }
      return `<button type="button" role="menuitem" class="${classes.join(" ")}" data-index="${index}"${item.disabled ? " disabled" : ""}>${escapeHtml(item.label)}</button>`;
    })
    .join("");

  menu.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>(".menu-item");
    if (!button || button.hasAttribute("disabled")) {
      return;
    }
    const item = items[Number(button.dataset.index)];
    closeMenu();
    item?.action();
  });

  document.body.appendChild(menu);
  position(menu, anchor, at, options?.fitViewport === true);

  const onOutsidePress = (event: Event) => {
    if (!event.defaultPrevented && !menu.contains(event.target as Node)) {
      closeMenu();
    }
  };
  const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>(".menu-item:not([disabled])"));

  /** Which entry the arrow keys are on, `-1` while nothing is picked yet. */
  let active = -1;

  const highlight = (index: number): void => {
    active = Math.max(0, Math.min(index, buttons.length - 1));
    buttons.forEach((button, position) => {
      button.classList.toggle("is-highlighted", position === active);
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeMenu();
      return;
    }

    if (buttons.length === 0) {
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const down = event.key === "ArrowDown";
      // The first press picks an end, so nothing has to be highlighted first.
      const next = active === -1 ? (down ? 0 : buttons.length - 1) : active + (down ? 1 : -1);
      // Kept from the window handler, which would step the volume instead.
      event.preventDefault();
      event.stopPropagation();
      highlight(next);
      return;
    }

    if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      event.stopPropagation();
      buttons[active].click();
    }
  };
  const onMove = () => closeMenu();

  const onScroll = (event: Event) => {
    if (!menu.contains(event.target as Node)) {
      closeMenu();
    }
  };

  // Deferred so the click that opened the menu does not immediately close it.
  let removeOutsidePress = (): void => {};
  const pointerTimer = window.setTimeout(() => {
    removeOutsidePress = listenForPress(document, onOutsidePress, true);
  }, 0);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onMove);
  window.addEventListener("scroll", onScroll, true);

  dismiss = () => {
    window.clearTimeout(pointerTimer);
    removeOutsidePress();
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("resize", onMove);
    window.removeEventListener("scroll", onScroll, true);
  };
  open = menu;
}

export function closeMenu(): void {
  dismiss?.();
  dismiss = null;
  open?.remove();
  open = null;
  releasePopup(closeMenu);
}

function position(menu: HTMLElement, anchor: HTMLElement, at: MenuPoint | undefined, fitViewport: boolean): void {
  const touchFit = fitViewport && isTouch();
  const margin = touchFit ? 4 : 8;
  const safe = touchFit ? insets() : ZERO_INSETS;

  if (touchFit) {
    menu.style.maxWidth = `${Math.max(0, window.innerWidth - margin * 2 - safe.left - safe.right)}px`;
    menu.style.maxHeight = `${Math.max(0, window.innerHeight - margin * 2 - safe.top - safe.bottom)}px`;
  }

  // Measure before placing, so the flip decision uses the real size.
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const minLeft = margin + safe.left;
  const maxLeft = Math.max(minLeft, window.innerWidth - width - margin - safe.right);
  const minTop = margin + safe.top;
  const maxTop = Math.max(minTop, window.innerHeight - height - margin - safe.bottom);

  // A pointer position hangs the menu off the cursor; an anchor off its corner.
  const rect = anchor.getBoundingClientRect();
  let left = at ? at.x : rect.right - width;
  let top = at ? at.y : rect.bottom + margin;

  if (top > maxTop) {
    top = at ? at.y - height : rect.top - height - margin;
  }
  left = Math.min(Math.max(minLeft, left), maxLeft);
  top = Math.min(Math.max(minTop, top), maxTop);

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}
