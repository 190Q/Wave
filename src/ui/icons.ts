import { icons, setIcon, type IconName } from "../assets/icons/index";

/** Fills every `data-icon` placeholder inside `root`. */
export function fillIcons(root: ParentNode = document): void {
  for (const holder of root.querySelectorAll<HTMLElement>("[data-icon]")) {
    const name = holder.dataset.icon;
    if (name && name in icons) {
      setIcon(holder, name as IconName);
    }
  }
}

export function mountIcons(): void {
  fillIcons(document);
}
