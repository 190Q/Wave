import { insets, isTouch } from "../lib/device";
import { escapeHtml, songCount } from "../lib/format";
import { scoreItems } from "../lib/search";
import {
  addTracksToPlaylist,
  createPlaylistWithTracks,
  getState,
  removeTracksFromPlaylist,
  subscribe,
} from "../lib/state";
import type { Playlist } from "../types";
import { mosaicHtml } from "./artwork";
import { hydrateCovers, releaseCovers } from "./covers";
import { fillIcons } from "./icons";
import { listenForPress } from "./popups";

/** The panel that is up, so opening another one replaces it. */
let dismiss: (() => void) | null = null;

/** The button it hangs off, so a second click on it takes the panel back down. */
let source: HTMLElement | null = null;
let sourceInLibrary = false;

/** Closes the panel, if one is showing. */
export function closeAddToPlaylist(libraryOnly = false): void {
  if (libraryOnly && !sourceInLibrary) {
    return;
  }
  dismiss?.();
}

/** A playlist is matched on its name alone. */
function playlistFields(playlist: Playlist): readonly string[] {
  return [playlist.name];
}

/** Only the playlists a song can be put in; a generated one is filled by Wave. */
function addablePlaylists(playlists: Playlist[]): Playlist[] {
  return playlists.filter((playlist) => playlist.kind !== "generated");
}

/** Identifies the playlist data a set of rows was built from. */
function playlistsSignature(playlists: Playlist[]): string {
  return playlists
    .map((playlist) => `${playlist.id}\u0000${playlist.name}\u0000${playlist.trackIds.join("|")}`)
    .join("\u0001");
}

export function openAddToPlaylist(anchor: HTMLElement, trackIds: string[]): void {
  if (trackIds.length === 0) {
    return;
  }

  if (dismiss && source === anchor) {
    closeAddToPlaylist();
    return;
  }
  closeAddToPlaylist();
  const openedFromLibrary = anchor.closest(".sheet") !== null;

  const head = trackIds.length > 1 ? `Add ${trackIds.length} songs to a playlist` : "Add to playlist";

  const panel = document.createElement("div");
  panel.className = "add-to";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Add to playlist");
  panel.innerHTML = `
    <p class="add-to-head">${escapeHtml(head)}</p>
    <div class="add-to-search">
      <span class="add-to-icon" data-icon="search" aria-hidden="true"></span>
      <input class="add-to-input" type="text" placeholder="Find a playlist" aria-label="Find a playlist" autocomplete="off">
    </div>
    <div class="add-to-new"></div>
    <div class="add-to-list"></div>`;

  const search = panel.querySelector<HTMLInputElement>(".add-to-search .add-to-input");
  const create = panel.querySelector<HTMLElement>(".add-to-new");
  const list = panel.querySelector<HTMLElement>(".add-to-list");
  if (!search || !create || !list) {
    return;
  }

  const included = new Set(
    addablePlaylists(getState().playlists)
      .filter((playlist) => {
        const held = new Set(playlist.trackIds);
        return trackIds.every((id) => held.has(id));
      })
      .map((playlist) => playlist.id),
  );

  /** True while the new playlist field is showing instead of its button. */
  let naming = false;

  /** The playlist data the rows on screen were built from. */
  let painted = "";

  const rowsHtml = (playlists: Playlist[]): string =>
    playlists
      .map((playlist) => {
        const saved = included.has(playlist.id);
        return `
          <button class="add-to-row" type="button" data-playlist="${escapeHtml(playlist.id)}" aria-pressed="${saved}">
            <span class="add-to-cover">${mosaicHtml(playlist.trackIds, getState().tracksById)}</span>
            <span class="add-to-text">
              <span class="add-to-title">${escapeHtml(playlist.name)}</span>
              <span class="add-to-sub">${escapeHtml(songCount(playlist.trackIds.length))}</span>
            </span>
            <span class="add-to-mark${saved ? " is-on" : ""}" aria-hidden="true"></span>
          </button>`;
      })
      .join("");

  const paintList = (): void => {
    const state = getState();
    const query = search.value.trim();
    const playlists = addablePlaylists(state.playlists);
    const ranked = scoreItems(
      playlists,
      query,
      state.settings.searchAlgorithm,
      playlistFields,
      playlists,
    ).map((entry) => entry.item);

    // What the track is already in comes first, the rest follows.
    const saved = ranked.filter((playlist) => included.has(playlist.id));
    const rest = ranked.filter((playlist) => !included.has(playlist.id));

    const sections: string[] = [];
    if (saved.length > 0) {
      sections.push(`<p class="add-to-section">Saved in</p>${rowsHtml(saved)}`);
    }
    if (rest.length > 0) {
      sections.push(`<p class="add-to-section">Your playlists</p>${rowsHtml(rest)}`);
    }

    const scroll = list.scrollTop;
    list.innerHTML =
      sections.join("") ||
      `<p class="add-to-empty">${query ? "No playlist matches." : "No playlists yet."}</p>`;
    list.scrollTop = scroll;
    painted = playlistsSignature(state.playlists);
    fillIcons(list);
    hydrateCovers(list);
  };

  const paintCreate = (): void => {
    if (!naming) {
      create.classList.remove("is-naming");
      create.innerHTML = `<button class="add-to-new-button" type="button">
        <span class="add-to-icon" data-icon="add"></span>
        <span>New playlist</span>
      </button>`;
      fillIcons(create);
      return;
    }

    create.classList.add("is-naming");
    create.innerHTML = `<span class="add-to-icon" data-icon="add"></span>
      <input class="add-to-input add-to-name" type="text" placeholder="Playlist name" aria-label="New playlist name" autocomplete="off">`;
    fillIcons(create);
    create.querySelector<HTMLInputElement>("input")?.focus();
  };

  const toggle = (id: string): void => {
    const adding = !included.has(id);
    if (adding) {
      included.add(id);
    } else {
      included.delete(id);
    }
    paintList();
    void (adding
      ? addTracksToPlaylist(id, trackIds)
      : removeTracksFromPlaylist(id, trackIds));
  };

  list.addEventListener("click", (event) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>("[data-playlist]")?.dataset.playlist;
    if (id) {
      toggle(id);
    }
  });

  create.addEventListener("click", (event) => {
    if (!naming && (event.target as HTMLElement).closest(".add-to-new-button")) {
      naming = true;
      paintCreate();
    }
  });

  create.addEventListener("keydown", (event) => {
    const field = event.target;
    if (!(field instanceof HTMLInputElement) || event.key !== "Enter") {
      return;
    }
    const name = field.value.trim();
    if (!name) {
      return;
    }
    close();
    void createPlaylistWithTracks(name, trackIds);
  });

  search.addEventListener("input", paintList);

  const onOutsidePress = (event: Event): void => {
    const target = event.target as Node;
    if (!event.defaultPrevented && !panel.contains(target) && !anchor.contains(target)) {
      close();
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") {
      return;
    }
    // Kept from the sheet, which would close the whole library with it.
    event.stopPropagation();
    if (naming) {
      naming = false;
      paintCreate();
      return;
    }
    close();
  };

  const onResize = (): void => {
    if (isTouch()) {
      place(panel, anchor);
    } else {
      close();
    }
  };
  const viewport = window.visualViewport;
  const onViewportChange = (): void => {
    if (isTouch()) {
      place(panel, anchor);
    }
  };

  // Scrolling the library moves the anchor, but scrolling the panel must not.
  const onScroll = (event: Event): void => {
    if (event.target instanceof Node && panel.contains(event.target)) {
      return;
    }
    if (isTouch() && document.activeElement && panel.contains(document.activeElement)) {
      place(panel, anchor);
      return;
    }
    close();
  };

  let unsubscribe = (): void => {};
  let pointerTimer: number | null = null;
  let removeOutsidePress = (): void => {};

  const close = (): void => {
    if (pointerTimer !== null) {
      window.clearTimeout(pointerTimer);
      pointerTimer = null;
    }
    removeOutsidePress();
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
    viewport?.removeEventListener("resize", onViewportChange);
    viewport?.removeEventListener("scroll", onViewportChange);
    unsubscribe();
    releaseCovers(list);
    panel.remove();
    if (dismiss === close) {
      dismiss = null;
      source = null;
      sourceInLibrary = false;
    }
  };
  dismiss = close;
  source = anchor;
  sourceInLibrary = openedFromLibrary;

  unsubscribe = subscribe(() => {
    const state = getState();
    // The sheet closing takes the panel with it.
    if (openedFromLibrary && !state.libraryOpen) {
      close();
      return;
    }
    if (playlistsSignature(state.playlists) !== painted) {
      paintList();
    }
  });

  document.body.appendChild(panel);
  fillIcons(panel);
  paintCreate();
  paintList();
  place(panel, anchor);

  // Deferred so the click that opened the panel does not immediately close it.
  pointerTimer = window.setTimeout(() => {
    pointerTimer = null;
    removeOutsidePress = listenForPress(document, onOutsidePress, true);
  }, 0);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);
  viewport?.addEventListener("resize", onViewportChange);
  viewport?.addEventListener("scroll", onViewportChange);

  if (!isTouch()) {
    search.focus();
  }
}

/** Opens beside the button, or on its other side when the edge is too close. */
function place(panel: HTMLElement, anchor: HTMLElement): void {
  const margin = 8;
  const safe = insets();
  const viewport = isTouch() ? window.visualViewport : null;
  const viewportLeft = viewport?.offsetLeft ?? 0;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportWidth = viewport?.width ?? window.innerWidth;
  const viewportHeight = viewport?.height ?? window.innerHeight;
  if (isTouch()) {
    panel.style.maxWidth = `${Math.max(0, viewportWidth - margin * 2 - safe.left - safe.right)}px`;
    panel.style.maxHeight = `${Math.max(0, viewportHeight - margin * 2 - safe.top - safe.bottom)}px`;
  }
  const rect = anchor.getBoundingClientRect();
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const minLeft = viewportLeft + margin + safe.left;
  const maxLeft = Math.max(minLeft, viewportLeft + viewportWidth - width - margin - safe.right);
  const minTop = viewportTop + margin + safe.top;
  const maxTop = Math.max(minTop, viewportTop + viewportHeight - height - margin - safe.bottom);

  let left = rect.right + margin;
  if (left > maxLeft) {
    left = rect.left - width - margin;
  }
  left = Math.min(Math.max(minLeft, left), maxLeft);

  const top = Math.min(Math.max(minTop, rect.top), maxTop);

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
}
