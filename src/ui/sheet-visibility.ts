export type SheetView = "lyrics" | "stack";

export interface SheetVisibility {
  visible(view: SheetView): boolean;
  update(travel: number, height: number): void;
  subscribe(listener: (view: SheetView, visible: boolean) => void): void;
}

export function createSheetVisibility(): SheetVisibility {
  const current = { lyrics: false, stack: true };
  const listeners = new Set<(view: SheetView, visible: boolean) => void>();

  return {
    visible: (view) => current[view],
    update: (travel, height) => {
      const next = { lyrics: travel > 0, stack: height <= 0 || travel < height };
      for (const view of ["lyrics", "stack"] as const) {
        if (current[view] !== next[view]) {
          current[view] = next[view];
          for (const listener of listeners) listener(view, next[view]);
        }
      }
    },
    subscribe: (listener) => { listeners.add(listener); },
  };
}
