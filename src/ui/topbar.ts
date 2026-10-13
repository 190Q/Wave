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
import { searchTracks } from "../lib/search";
import type { SearchAlgorithm, Track } from "../types";
import { collectionCoverHtml } from "./artwork";
import { hydrateCovers } from "./covers";
import { highlightHtml } from "./highlight";
import { openMenu } from "./menu";

const RESULT_LIMIT = 40;

const SEARCH_MODAL_MS = 220;

/** Set while the topbar is mounted, so a shortcut can open the search modal. */
let openSearchModal: (() => void) | null = null;

/** Opens the search modal and puts the cursor in its field. */
export function focusSearch(): void {
  openSearchModal?.();
}

/** Set while the topbar is mounted, so a shortcut can open the import menu. */
let openImportMenu: (() => void) | null = null;

/** Opens the folder import menu, anchored to the Add folder button. */
export function chooseFolder(): void {
  openImportMenu?.();
}

export function mountTopbar(): void {
  const libraryButton = element("library-open");
  const addFolderButton = element("add-folder");
  const searchButton = element<HTMLButtonElement>("search-open");
  const searchModal = element("search-modal");
  const searchPanel = element("search-panel");
  const searchWrap = element("search-wrap");
  const search = element<HTMLInputElement>("search");
  const results = element("results");
  const resultsList = element("results-list");
  const recents = element("recents");

  if (
    !libraryButton ||
    !addFolderButton ||
    !searchButton ||
    !searchModal ||
    !searchPanel ||
    !searchWrap ||
    !search ||
    !results ||
    !resultsList ||
    !recents
  ) {
    return;
  }

  libraryButton.addEventListener("click", () => toggleLibrary());

  const chooseImport = (): void => {
    openMenu(addFolderButton, [
      { label: "Import as a playlist", action: () => void importFolder(true) },
      { label: "Import songs only", action: () => void importFolder(false) },
    ]);
  };
  addFolderButton.addEventListener("click", chooseImport);
  openImportMenu = chooseImport;

  let resultsOpen = false;

  const fitDrop = (): void => {
    const height = search.offsetHeight;
    if (height === 0) {
      return;
    }
    searchWrap.style.setProperty("--search-h", `${height}px`);
    searchWrap.style.setProperty("--search-radius", `${height / 2}px`);
  };

  let renderedResults = "";

  /** Which result the arrow keys are on, `-1` while nothing is picked. */
  let activeResult = -1;

  const resultRows = (): HTMLElement[] =>
    Array.from(resultsList.querySelectorAll<HTMLElement>(".result"));

  /** Moves the highlight, clamped to the list, and keeps it in view. */
  const activateResult = (index: number): void => {
    const rows = resultRows();
    if (rows.length === 0) {
      activeResult = -1;
      return;
    }

    activeResult = Math.max(0, Math.min(index, rows.length - 1));
    rows.forEach((row, position) => {
      const on = position === activeResult;
      row.classList.toggle("is-active", on);
      if (on) {
        row.setAttribute("aria-current", "true");
      } else {
        row.removeAttribute("aria-current");
      }
    });
    rows[activeResult]?.scrollIntoView({ block: "nearest" });
  };

  /** Moves the highlight by `step`, wrapping around the ends of the list. */
  const stepResult = (step: number): void => {
    const rows = resultRows();
    if (rows.length === 0) {
      activateResult(-1);
      return;
    }

    const from = activeResult < 0 ? (step > 0 ? -1 : 0) : activeResult;
    activateResult((from + step + rows.length) % rows.length);
  };

  const playResult = (trackId: string): void => {
    closeSearch();
    // Search covers the whole library.
    playFromCollection("all", trackId);
  };

  /** The list hides its scrollbar, so a faded bottom edge flags more results. */
  const updateResultsOverflow = (): void => {
    const more = resultsList.scrollHeight - resultsList.scrollTop - resultsList.clientHeight > 1;
    resultsList.classList.toggle("is-more", more);
  };

  const syncResults = (): void => {
    const state = getState();
    const open = resultsOpen && state.search.trim().length > 0;
    searchWrap.classList.toggle("is-open", open);

    // Only re-rendering when the matches change keeps any scroll position.
    const html = resultsHtml(state.search, state.tracks, state.settings.searchAlgorithm);
    if (html !== renderedResults) {
      renderedResults = html;
      resultsList.innerHTML = html;
      activateResult(0);
    }
    updateResultsOverflow();
  };

  let closeTimer: number | null = null;

  /** Anchors the scale animation on the search button, so it pops from there. */
  const setOrigin = (): void => {
    const panelRect = searchPanel.getBoundingClientRect();
    const buttonRect = searchButton.getBoundingClientRect();
    const x = buttonRect.left + buttonRect.width / 2 - panelRect.left;
    const y = buttonRect.top + buttonRect.height / 2 - panelRect.top;
    searchPanel.style.transformOrigin = `${x}px ${y}px`;
  };

  const openSearch = (): void => {
    if (closeTimer !== null) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
    // Start collapsed, then let the stylesheet play it in.
    searchModal.classList.add("is-closed");
    searchModal.hidden = false;
    fitDrop();
    setOrigin();
    void searchModal.offsetWidth;
    searchModal.classList.remove("is-closed");
    search.focus();
    if (search.value.trim()) {
      resultsOpen = true;
      syncResults();
    }
  };

  const closeSearch = (): void => {
    if (searchModal.hidden || searchModal.classList.contains("is-closed")) {
      return;
    }
    setOrigin();
    searchModal.classList.add("is-closed");
    resultsOpen = false;
    search.value = "";
    setSearch("");
    syncResults();
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      searchModal.hidden = true;
    }, SEARCH_MODAL_MS);
  };

  openSearchModal = openSearch;
  searchButton.addEventListener("click", openSearch);

  search.addEventListener("input", () => {
    resultsOpen = true;
    setSearch(search.value);
  });
  search.addEventListener("focus", () => {
    if (search.value.trim()) {
      resultsOpen = true;
      syncResults();
    }
  });
  search.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        closeSearch();
        return;
      case "ArrowDown":
        event.preventDefault();
        stepResult(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        stepResult(-1);
        return;
      case "Enter": {
        event.preventDefault();
        const trackId = resultRows()[activeResult]?.dataset.track;
        if (trackId) {
          playResult(trackId);
        }
        return;
      }
      default:
        return;
    }
  });

  search.closest(".search-wrap")?.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest(".results")) {
      return;
    }
    search.focus();
  });

  // Clicking the backdrop, but not the bar itself, dismisses the modal.
  searchModal.addEventListener("pointerdown", (event) => {
    if (event.target === searchModal) {
      closeSearch();
    }
  });

  results.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-track]");
    if (row?.dataset.track) {
      playResult(row.dataset.track);
    }
  });

  resultsList.addEventListener("scroll", updateResultsOverflow);

  document.addEventListener("pointerdown", (event) => {
    const target = event.target as Node;
    if (resultsOpen && !results.contains(target) && !search.contains(target)) {
      resultsOpen = false;
      syncResults();
    }
  });

  window.addEventListener("resize", () => {
    fitDrop();
    updateResultsOverflow();
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

  const measureCrates = (): void => {
    const compact = recents.classList.contains("is-compact");
    recents.classList.add("no-anim");
    recents.classList.remove("is-compact");
    cratesNatural = recents.scrollWidth;
    recents.classList.toggle("is-compact", compact);
    void recents.offsetWidth;
    recents.classList.remove("no-anim");
  };

  const fitCrates = (): void => {
    measureCrates();
    decideCrates();
  };

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(fitCrates).observe(recents);
  }
  // Text metrics settle once the display font has loaded.
  void document.fonts?.ready.then(fitCrates);

  let renderedCrates = "";

  const render = (): void => {
    const state = getState();

    const crates = state.recents
      .map((id) => state.collections.find((collection) => collection.id === id))
      .filter((collection) => collection !== undefined)
      .map(
        (collection) => `
          <button class="crate" type="button" data-collection="${escapeHtml(collection.id)}">
            ${collectionCoverHtml(collection, state.tracksById)}
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
      fitCrates();
    }

    syncResults();
  };

  subscribe(render);
  render();
}

function resultsHtml(query: string, tracks: Track[], algorithm: SearchAlgorithm): string {
  const needle = query.trim();
  if (!needle) {
    return "";
  }

  const matches = searchTracks(tracks, query, algorithm);
  const shown = matches.slice(0, RESULT_LIMIT);

  return shown.length
    ? `
      <p class="results-head">${matches.length} match${matches.length === 1 ? "" : "es"}${
        matches.length > shown.length ? `, showing ${shown.length}` : ""
      }</p>
      ${shown
        .map(
          (track) => `
            <button class="result" type="button" data-track="${escapeHtml(track.id)}">
              <span class="result-title">${highlightHtml(track.title, query, algorithm)}</span>
              <span class="result-sub">${highlightHtml(
                track.artist ?? "Unknown artist",
                query,
                algorithm,
              )}${track.album ? ` - ${highlightHtml(track.album, query, algorithm)}` : ""}</span>
            </button>`,
        )
        .join("")}`
    : `<p class="results-head">Nothing matches "${escapeHtml(query.trim())}".</p>`;
}

function element<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
