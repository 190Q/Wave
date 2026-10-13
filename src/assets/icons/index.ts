import add from "./add.svg?raw";
import appIcon from "./app-icon.svg?raw";
import close from "./close.svg?raw";
import closeWindow from "./close-window.svg?raw";
import covers from "./covers.svg?raw";
import folder from "./folder.svg?raw";
import grip from "./grip.svg?raw";
import importIcon from "./import.svg?raw";
import library from "./library.svg?raw";
import like from "./like.svg?raw";
import likeFilled from "./like-filled.svg?raw";
import lyrics from "./lyrics.svg?raw";
import maximise from "./maximise.svg?raw";
import minimise from "./minimise.svg?raw";
import next from "./next.svg?raw";
import pause from "./pause.svg?raw";
import play from "./play.svg?raw";
import previous from "./previous.svg?raw";
import queue from "./queue.svg?raw";
import repeat from "./repeat.svg?raw";
import restore from "./restore.svg?raw";
import search from "./search.svg?raw";
import settings from "./settings.svg?raw";
import shuffle from "./shuffle.svg?raw";
import theme from "./theme.svg?raw";

export const icons = {
  add,
  "app-icon": appIcon,
  close,
  "close-window": closeWindow,
  covers,
  folder,
  grip,
  import: importIcon,
  library,
  like,
  "like-filled": likeFilled,
  lyrics,
  maximise,
  minimise,
  next,
  pause,
  play,
  previous,
  queue,
  repeat,
  restore,
  search,
  settings,
  shuffle,
  theme,
} as const;

export type IconName = keyof typeof icons;

/** Raw SVG markup for an icon. */
export function iconMarkup(name: IconName): string {
  return icons[name];
}

/** A fresh SVG element for an icon, ready to be inserted into the DOM. */
export function createIcon(name: IconName): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = icons[name].trim();
  const svg = template.content.firstElementChild;
  if (!(svg instanceof SVGSVGElement)) {
    throw new Error(`Icon "${name}" did not parse into an SVG element`);
  }
  return svg;
}

/** Swaps the icon shown by an element, replacing whatever was there before. */
export function setIcon(target: Element, name: IconName): void {
  target.replaceChildren(createIcon(name));
}
