import type { ThemeDefinition } from "../types";

export const THEMES: ThemeDefinition[] = [
  // `color: null` means "follow the dominant colour of the current artwork".
  { id: "adaptive", name: "Adaptive", color: null },
  { id: "ember", name: "Ember", color: "#c9601d" },
  { id: "forest", name: "Forest", color: "#2f7d5b" },
  { id: "violet", name: "Violet", color: "#6f4bd8" },
  { id: "mono", name: "Mono", color: "#8b8b96" },
];

export const DEFAULT_THEME_ID = "adaptive";

export function findTheme(id: string): ThemeDefinition {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}
