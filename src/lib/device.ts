/**
 * What the window is running on, and how much of the screen the system already
 * owns.
 *
 * The same front end runs in three webviews: WebView2 on Windows, WebKitGTK on
 * Linux and the Android system WebView. They are told apart by the user agent,
 * and `?device=` overrides the answer so the phone simulator can stand in for
 * any of them.
 *
 * The kind is written to `data-device` on `<html>`, so a stylesheet asks for
 * `[data-device="android"]` rather than guessing from a width, and the safe
 * area is written to `--inset-top` and its three neighbours.
 */

export type DeviceKind = "desktop" | "linuxPhone" | "android";

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Fired when the system's insets change: rotation, or the bars coming and going. */
export const INSETS_EVENT = "wave:insets";

/** Where the kind is remembered when `?device=` asked for one. */
const STORAGE_KEY = "wave:device";

const KINDS: DeviceKind[] = ["desktop", "linuxPhone", "android"];

export const ZERO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

declare global {
  interface Window {
    /** Written by the Android side, in CSS pixels. */
    __WAVE_INSETS__?: Partial<Insets>;
  }
}

/** WebKitGTK, the only webview Tauri uses on Linux. */
export const isWebKitGtk =
  /Linux/.test(navigator.userAgent) && !/Chrome\//.test(navigator.userAgent);

let kind: DeviceKind = "desktop";

function asked(): DeviceKind | null {
  const wanted = new URLSearchParams(window.location.search).get("device");
  if (wanted === "auto") {
    window.localStorage.removeItem(STORAGE_KEY);
    return null;
  }
  if (wanted && (KINDS as string[]).includes(wanted)) {
    window.localStorage.setItem(STORAGE_KEY, wanted);
    return wanted as DeviceKind;
  }
  const kept = window.localStorage.getItem(STORAGE_KEY);
  return kept && (KINDS as string[]).includes(kept) ? (kept as DeviceKind) : null;
}

function detected(): DeviceKind {
  if (/Android/i.test(navigator.userAgent)) {
    return "android";
  }
  // A Linux phone is WebKitGTK driven by a finger. Nothing else on Linux says
  // it is a phone, and a wrong answer only costs the touch affordances.
  if (isWebKitGtk && coarse()) {
    return "linuxPhone";
  }
  return "desktop";
}

function coarse(): boolean {
  return window.matchMedia("(pointer: coarse)").matches;
}

/** The kind in force. */
export function device(): DeviceKind {
  return kind;
}

/** True when the screen is driven by a finger, so hover is not available. */
export function isTouch(): boolean {
  return kind === "android" || kind === "linuxPhone" || coarse();
}

/** The insets the system reported, in CSS pixels. */
export function insets(): Insets {
  const reported = window.__WAVE_INSETS__;
  return {
    top: edge(reported?.top),
    right: edge(reported?.right),
    bottom: edge(reported?.bottom),
    left: edge(reported?.left),
  };
}

/** Paints the insets onto the root element, where the stylesheets read them. */
export function applyInsets(values: Insets = insets()): void {
  const root = document.documentElement.style;
  root.setProperty("--inset-top", `${values.top}px`);
  root.setProperty("--inset-right", `${values.right}px`);
  root.setProperty("--inset-bottom", `${values.bottom}px`);
  root.setProperty("--inset-left", `${values.left}px`);
}

/** Switches the kind by hand, which is what the simulator's device picker does. */
export function setDevice(next: DeviceKind): void {
  kind = next;
  document.documentElement.dataset.device = kind;
  applyInsets();
}

/** Settles the kind and the insets, and follows the insets afterwards. */
export function initDevice(): void {
  setDevice(asked() ?? detected());
  window.addEventListener(INSETS_EVENT, () => applyInsets());
}

/** Anything but a real measurement counts as nothing, never as a broken value. */
function edge(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
