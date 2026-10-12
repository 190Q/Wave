import { escapeHtml } from "../lib/format";
import {
  getState,
  importFolder,
  openCollection,
  playFromCollection,
  setSearch,
  subscribe,
  toggleLibrary,
} from "../lib/state";
import type { Track } from "../types";
import { mosaicHtml } from "./artwork";
import { hydrateCovers } from "./covers";
import { openMenu } from "./menu";

const RESULT_LIMIT = 40;

export function mountTopbar(): void {
  const libraryButton = element("library-open");
  const addFolderButton = element("add-folder");
  const search = element<HTMLInputElement>("search");
  const results = element("results");
  const recents = element("recents");

  if (!libraryButton || !addFolderButton || !search || !results || !recents) {
    return;
  }

  libraryButton.addEventListener("click", () => toggleLibrary());
  addFolderButton.addEventListener("click", () => {
    openMenu(addFolderButton, [
      { label: "Import as a playlist", action: () => void importFolder(true) },
      { label: "Import songs only", action: () => void importFolder(false) },
    ]);
  });

  let resultsOpen = false;

  const refreshResults = (): void => {
    const state = getState();
    renderResults(state.search, state.tracks, results, resultsOpen);
  };

  search.addEventListener("input", () => {
    resultsOpen = true;
    setSearch(search.value);
  });
  search.addEventListener("focus", () => {
    if (search.value.trim()) {
      resultsOpen = true;
      refreshResults();
    }
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      search.value = "";
      resultsOpen = false;
      setSearch("");
      search.blur();
    }
  });

  search.closest(".search-wrap")?.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest(".results")) {
      return;
    }
    search.focus();
  });

  results.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-track]");
    if (!row?.dataset.track) {
      return;
    }
    resultsOpen = false;
    search.value = "";
    setSearch("");
    // Search covers the whole library.
    playFromCollection("all", row.dataset.track);
    results.hidden = true;
  });

  document.addEventListener("pointerdown", (event) => {
    const target = event.target as Node;
    if (resultsOpen && !results.contains(target) && !search.contains(target)) {
      resultsOpen = false;
      results.hidden = true;
    }
  });

  recents.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-collection]");
    if (card?.dataset.collection) {
      openCollection(card.dataset.collection);
    }
  });

  let cratesNatural = 0;

  const decideCrates = (): void => {
    recents.classList.toggle("is-compact", cratesNatural > recents.clientWidth + 1);
  };

  const resetCrates = (): void => {
    recents.classList.add("no-anim");
    recents.classList.remove("is-compact");
    cratesNatural = recents.scrollWidth;
    decideCrates();
    void recents.offsetWidth;
    recents.classList.remove("no-anim");
  };

  const fitCrates = (): void => {
    if (!recents.classList.contains("is-compact")) {
      cratesNatural = recents.scrollWidth;
    }
    decideCrates();
  };

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(fitCrates).observe(recents);
  }
  // Text metrics settle once the display font has loaded.
  void document.fonts?.ready.then(resetCrates);

  let renderedCrates = "";

  const render = (): void => {
    const state = getState();

    const crates = state.recents
      .map((id) => state.collections.find((collection) => collection.id === id))
      .filter((collection) => collection !== undefined)
      .map(
        (collection) => `
          <button class="crate" type="button" data-collection="${escapeHtml(collection.id)}">
            ${mosaicHtml(collection.trackIds, state.tracksById)}
            <span class="crate-text">
              <span class="crate-name">${escapeHtml(collection.name)}</span>
              <span class="crate-sub">${escapeHtml(collection.subtitle)}</span>
            </span>
          </button>`,
      )
      .join("");

    if (crates !== renderedCrates) {
      renderedCrates = crates;
      recents.innerHTML = crates;
      hydrateCovers(recents);
      resetCrates();
    }

    renderResults(state.search, state.tracks, results, resultsOpen);
  };

  subscribe(render);
  render();
}

function renderResults(query: string, tracks: Track[], container: HTMLElement, open: boolean): void {
  const needle = query.trim().toLowerCase();
  if (!open || !needle) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }

  const matches = tracks.filter((track) => searchableText(track).includes(needle));
  const shown = matches.slice(0, RESULT_LIMIT);

  container.hidden = false;
  container.innerHTML = shown.length
    ? `
      <p class="results-head">${matches.length} match${matches.length === 1 ? "" : "es"}${
        matches.length > shown.length ? `, showing ${shown.length}` : ""
      }</p>
      ${shown
        .map(
          (track) => `
            <button class="result" type="button" data-track="${escapeHtml(track.id)}">
              <span class="result-title">${escapeHtml(track.title)}</span>
              <span class="result-sub">${escapeHtml(track.artist ?? "Unknown artist")}${
                track.album ? ` - ${escapeHtml(track.album)}` : ""
              }</span>
            </button>`,
        )
        .join("")}`
    : `<p class="results-head">Nothing matches "${escapeHtml(query.trim())}".</p>`;
}

function searchableText(track: Track): string {
  return [track.title, track.artist, track.album, track.genre, track.fileName]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
}

function element<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
