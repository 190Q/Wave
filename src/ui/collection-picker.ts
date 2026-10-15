import { escapeHtml } from "../lib/format";
import { scoreItems } from "../lib/search";
import { getState } from "../lib/state";
import type { Collection } from "../types";
import { highlightHtml } from "./highlight";
import { placePicker, windowFrame } from "./picker";

/** Same five-result, name-ranked collection search used by import fetches. */
export function mountCollectionPicker(
  body: HTMLElement,
  selector: string,
  choose: (collection: Collection) => void,
  current: () => Collection | undefined,
): { close(): void; readonly isOpen: boolean } {
  let input: HTMLInputElement | null = null;
  let picker: HTMLElement | null = null;
  let proposals: Collection[] = [];
  let active = -1;

  const close = (): void => {
    picker?.remove();
    picker = null;
    if (input) {
      input.classList.remove("is-open");
      input.value = current()?.name ?? "";
      input.setAttribute("aria-expanded", "false");
    }
    input = null;
  };
  const paintActive = (): void => {
    const rows = Array.from(picker?.querySelectorAll<HTMLElement>(".slot-option") ?? []);
    rows.forEach((row, index) => row.classList.toggle("is-highlighted", index === active));
    rows[active]?.scrollIntoView({ block: "nearest" });
  };
  const paint = (query: string): void => {
    if (!picker || !input) return;
    const state = getState();
    proposals = scoreItems(
      state.collections, query, state.settings.searchAlgorithm,
      (collection) => [collection.name], state.collections,
    ).slice(0, 5).map((entry) => entry.item);
    active = proposals.length ? 0 : -1;
    picker.innerHTML = proposals.length
      ? proposals.map((collection, index) => `
        <button type="button" class="slot-option" data-collection-option="${index}">
          <span class="slot-option-name">${highlightHtml(collection.name, query, state.settings.searchAlgorithm)}</span>
          <span class="slot-option-sub">${escapeHtml(collection.subtitle)}</span>
        </button>`).join("")
      : `<p class="import-picker-empty">No collection matches.</p>`;
    paintActive();
    placePicker(picker, input, windowFrame(), "above");
  };
  const commit = (index: number): void => {
    const collection = proposals[index];
    if (!collection) return;
    choose(collection);
    const button = body.querySelector<HTMLButtonElement>('[data-command="export-playlist"]');
    if (button) button.disabled = collection.trackIds.length === 0;
    close();
  };
  const open = (field: HTMLInputElement): void => {
    close();
    input = field;
    picker = document.createElement("div");
    picker.className = "slot-picker import-picker";
    picker.addEventListener("pointerdown", (event) => event.preventDefault());
    picker.addEventListener("click", (event) => {
      const option = (event.target as HTMLElement).closest<HTMLElement>("[data-collection-option]");
      if (option) commit(Number(option.dataset.collectionOption));
    });
    body.append(picker);
    input.classList.add("is-open");
    input.setAttribute("aria-expanded", "true");
    input.select();
    paint("");
  };
  body.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.matches(selector)) open(event.target);
  });
  body.addEventListener("click", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.matches(selector) && input !== event.target) open(event.target);
  });
  body.addEventListener("input", (event) => {
    if (event.target === input && input) paint(input.value);
  });
  body.addEventListener("focusout", (event) => {
    if (event.target === input) close();
  });
  body.addEventListener("keydown", (event) => {
    if (event.target !== input || !picker) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (["ArrowDown", "ArrowUp", "Tab"].includes(event.key)) {
      event.preventDefault();
      if (proposals.length) {
        const step = event.key === "ArrowUp" || event.shiftKey ? -1 : 1;
        active = (active + step + proposals.length) % proposals.length;
        paintActive();
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      commit(active);
    }
  });
  body.addEventListener("scroll", close);
  window.addEventListener("resize", close);
  return { close, get isOpen() { return picker !== null; } };
}
