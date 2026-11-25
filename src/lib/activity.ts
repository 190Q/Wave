const listeners = new Set<() => void>();
let background = false;
let screenBlanked = false;

export function uiActive(): boolean {
  return !document.hidden && !background && !screenBlanked;
}

export function subscribeActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setBackground(value: boolean): void {
  if (background === value) return;
  background = value;
  for (const listener of listeners) listener();
}

export function setScreenBlanked(value: boolean): void {
  if (screenBlanked === value) return;
  screenBlanked = value;
  for (const listener of listeners) listener();
}
