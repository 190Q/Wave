import { darken, mix, readableInk, stageGradient, withAlpha } from "../lib/color";
import { escapeHtml } from "../lib/format";
import { getState, player, setTheme, subscribe, themeColor } from "../lib/state";
import { THEMES } from "../lib/themes";

/** Pushes the current accent into the CSS custom properties the stylesheet uses. */
export function applyAccent(color: string): void {
  const root = document.documentElement;
  root.style.setProperty("--accent", color);
  // Hover state for toggled controls, and the translucent progress fill.
  root.style.setProperty("--accent-dark", darken(color, 0.18));
  // Hover state for a toggled control: the theme colour, greyed out a little.
  root.style.setProperty("--accent-dim", mix(color, "#8f8f9c", 0.4));
  root.style.setProperty("--accent-soft", withAlpha(color, 0.28));
  root.style.setProperty("--accent-ink", readableInk(color));
  root.style.setProperty("--stage-background", stageGradient(color));
}

export function mountTheme(): void {
  const toggle = document.getElementById("theme-toggle");
  const menu = document.getElementById("theme-menu");
  if (!toggle || !menu) {
    return;
  }

  const render = () => {
    const state = getState();
    const color = themeColor();
    applyAccent(color);

    menu.innerHTML = THEMES.map((theme) => {
      const active = state.settings.theme === theme.id;
      // The Adaptive swatch previews whatever the current artwork produced.
      const swatch = theme.color ?? color;
      return `<button type="button" class="theme-option${active ? " is-on" : ""}" data-theme="${theme.id}" role="menuitemradio" aria-checked="${active}">
        <span class="swatch" style="background: ${swatch}"></span>
        <span>${escapeHtml(theme.name)}</span>
      </button>`;
    }).join("");
  };

  toggle.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
  });

  menu.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-theme]");
    if (!button?.dataset.theme) {
      return;
    }
    void setTheme(button.dataset.theme);
    menu.hidden = true;
  });

  document.addEventListener("pointerdown", (event) => {
    if (menu.hidden) {
      return;
    }
    const target = event.target as Node;
    if (!menu.contains(target) && !toggle.contains(target)) {
      menu.hidden = true;
    }
  });

  subscribe(render);
  // The Adaptive theme has to follow the track, not just the settings.
  player.onChange(render);
  render();
}
