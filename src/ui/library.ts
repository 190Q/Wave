import { COLLECTION_FILTERS, filterCollections, isPinned } from "../lib/collections";
import { escapeHtml, formatDuration, formatTotalDuration, plural, songCount } from "../lib/format";
import { reduceMotionActive } from "../lib/motion";
import {
  collectionById,
  createPlaylist,
  deletePlaylist,
  deleteTrack,
  getState,
  playCollection,
  playFromCollection,
  renamePlaylist,
  reorderPlaylist,
  setFilter,
  setQuery,
  setSort,
  shuffleCollection,
  subscribe,
  toggleLibrary,
  toggleLikeTrack,
  type AppState,
} from "../lib/state";
import type { Collection, CollectionFilter, CollectionKind, Track } from "../types";
import { closeAddToPlaylist, openAddToPlaylist } from "./add-to-playlist";
import { collectionCoverHtml, plainCoverStyle } from "./artwork";
import { confirmDialog } from "./confirm";
import { hydrateCovers } from "./covers";
import { fillIcons } from "./icons";
import { highlightHtml } from "./highlight";
import { openImport } from "./import-dialog";
import { openMenu, type MenuPoint } from "./menu";

const SWIPE_TRAVEL = 1.75;
const SWIPE_MS = 260;
const SWIPE_EASE = "cubic-bezier(0.22, 0.8, 0.28, 1)";

export function mountLibrary(): void {
  const sheet = element("sheet");
  const list = element("library");
  const count = element("sheet-count");
  const chips = element("chips");
  const filterInput = element<HTMLInputElement>("sheet-search");
  const sortButton = element<HTMLButtonElement>("sheet-sort");
  const sortLabel = element("sheet-sort-label");
  const folders = element("folders");
  const back = element<HTMLButtonElement>("sheet-back");
  const newPlaylist = element("new-playlist");

  if (!sheet || !list || !count || !chips || !filterInput || !sortButton || !sortLabel || !folders || !back) {
    return;
  }

  // The inline editors keep their inputs uncontrolled, so re-rendering never
  // steals focus mid-typing.
  let creating = false;
  let renaming: string | null = null;
  let openCollectionId: string | null = null;
  let view: string | null = null;
  let dragFrom: number | null = null;
  let dropAt: { index: number; after: boolean } | null = null;
  let dragChip: HTMLElement | null = null;
  let activeId: string | null = null;
  let listScroll = 0;
  let listToTop = false;

  const entryRows = (): HTMLElement[] =>
    Array.from(list.querySelectorAll<HTMLElement>("[data-collection]"));

  const activeIndex = (): number =>
    entryRows().findIndex((row) => row.dataset.collection === activeId);

  const activateEntry = (index: number, scroll: boolean): void => {
    const rows = entryRows();
    if (rows.length === 0) {
      activeId = null;
      return;
    }

    const at = Math.max(0, Math.min(index, rows.length - 1));
    activeId = rows[at].dataset.collection ?? null;
    rows.forEach((row, position) => {
      const on = position === at;
      row.classList.toggle("is-active", on);
      if (on) {
        row.setAttribute("aria-current", "true");
      } else {
        row.removeAttribute("aria-current");
      }
    });

    if (scroll) {
      rows[at].scrollIntoView({ block: "nearest" });
    }
  };

  /** Moves the highlight by `step`, wrapping around the ends of the list. */
  const stepEntry = (step: number): void => {
    const rows = entryRows();
    if (rows.length === 0) {
      activeId = null;
      return;
    }

    const at = activeIndex();
    const from = at < 0 ? (step > 0 ? -1 : 0) : at;
    activateEntry((from + step + rows.length) % rows.length, true);
  };

  const restoreEntry = (): void => {
    const at = activeIndex();
    activateEntry(at < 0 ? 0 : at, false);
  };

  const openEntry = (id: string): void => {
    openCollectionId = id;
    renaming = null;
    creating = false;
    render();
  };

  element("sheet-close")?.addEventListener("click", () => toggleLibrary(false));
  back.addEventListener("click", () => {
    openCollectionId = null;
    render();
  });

  newPlaylist?.addEventListener("click", () => {
    creating = true;
    renaming = null;
    render();
  });

  filterInput.addEventListener("input", () => {
    activeId = null;
    listToTop = true;
    setQuery(filterInput.value);
  });

  filterInput.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        stepEntry(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        stepEntry(-1);
        return;
      case "Enter": {
        event.preventDefault();
        const id = entryRows()[activeIndex()]?.dataset.collection;
        if (id) {
          openEntry(id);
        }
        return;
      }
      default:
        return;
    }
  });

  sortButton.addEventListener("click", () => {
    const current = getState().sort;
    openMenu(sortButton, [
      { label: "A to Z", active: current === "name", action: () => setSort("name") },
      { label: "Most songs", active: current === "size", action: () => setSort("size") },
    ]);
  });

  chips.addEventListener("click", (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>("[data-filter]");
    const filter = chip?.dataset.filter as CollectionFilter | undefined;
    if (filter) {
      listToTop = true;
      setFilter(filter);
    }
  });

  list.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const menuButton = target.closest<HTMLElement>("[data-menu]");
    if (menuButton?.dataset.menu) {
      openPlaylistMenu(menuButton, menuButton.dataset.menu, () => {
        renaming = menuButton.dataset.menu ?? null;
        creating = false;
        render();
      });
      return;
    }

    const playButton = target.closest<HTMLElement>("[data-play]");
    if (playButton?.dataset.play) {
      playCollection(playButton.dataset.play);
      return;
    }

    const shuffleButton = target.closest<HTMLElement>("[data-shuffle]");
    if (shuffleButton?.dataset.shuffle) {
      shuffleCollection(shuffleButton.dataset.shuffle);
      return;
    }

    const likeButton = target.closest<HTMLElement>("[data-like]");
    if (likeButton?.dataset.like) {
      void toggleLikeTrack(likeButton.dataset.like);
      return;
    }

    const addButton = target.closest<HTMLElement>("[data-track-add]");
    if (addButton?.dataset.trackAdd) {
      openAddToPlaylist(addButton, addButton.dataset.trackAdd);
      return;
    }

    const trackRow = target.closest<HTMLElement>("[data-track]");
    if (trackRow?.dataset.track && openCollectionId) {
      playFromCollection(openCollectionId, trackRow.dataset.track);
      return;
    }

    const row = target.closest<HTMLElement>("[data-collection]");
    if (row?.dataset.collection) {
      openEntry(row.dataset.collection);
    }
  });

  list.addEventListener("contextmenu", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-track]");
    const trackId = row?.dataset.track;
    if (!row || !trackId) {
      return;
    }
    event.preventDefault();
    openTrackMenu(row, trackId, { x: event.clientX, y: event.clientY });
  });

  list.addEventListener("keydown", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    if (event.key === "Escape") {
      creating = false;
      renaming = null;
      render();
      return;
    }

    if (event.key !== "Enter") {
      return;
    }

    const name = input.value.trim();
    if (!name) {
      return;
    }

    if (creating) {
      creating = false;
      void createPlaylist(name);
    } else if (renaming) {
      const id = renaming;
      renaming = null;
      void renamePlaylist(id, name);
    }
    render();
  });

  list.addEventListener("focusout", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && (creating || renaming)) {
      creating = false;
      renaming = null;
      render();
    }
  });

  /** Puts the drag back down, whichever way it ended. */
  const endDrag = (): void => {
    dragFrom = null;
    dropAt = null;
    clearDragState(list);
    dragChip?.remove();
    dragChip = null;
  };

  list.addEventListener("dragstart", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-track-index]");
    if (!row || !openCollectionId) {
      return;
    }

    const index = Number(row.dataset.trackIndex);
    dragFrom = index;
    row.classList.add("is-dragging");

    // Without a payload and a permitted effect some engines refuse the drag.
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", "");
      dragChip = dragChipFor(getState().tracksById.get(row.dataset.track ?? ""));
      event.dataTransfer.setDragImage(dragChip, 16, 24);
    }
  });

  list.addEventListener("dragover", (event) => {
    if (dragFrom === null) {
      return;
    }
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-track-index]");
    if (!row) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }

    // The half of the row the pointer is in picks the gap to land in.
    const rect = row.getBoundingClientRect();
    const index = Number(row.dataset.trackIndex);
    const after = event.clientY > rect.top + rect.height / 2;
    if (dropAt?.index === index && dropAt.after === after) {
      return;
    }

    dropAt = { index, after };
    clearDropTargets(list);
    row.classList.add(after ? "is-drop-after" : "is-drop-before");
  });

  list.addEventListener("drop", (event) => {
    if (dragFrom === null || !openCollectionId) {
      return;
    }
    event.preventDefault();

    const collection = collectionById(openCollectionId);
    const from = dragFrom;
    const gap = dropAt === null ? null : dropAt.index + (dropAt.after ? 1 : 0);
    endDrag();

    if (!collection || gap === null) {
      return;
    }

    const reordered = [...collection.trackIds];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(gap > from ? gap - 1 : gap, 0, moved);

    if (reordered.every((id, at) => id === collection.trackIds[at])) {
      return;
    }
    void reorderPlaylist(collection.id, reordered);
  });

  list.addEventListener("dragend", endDrag);

  folders.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("#sheet-add-folder");
    if (button) {
      openImport(button);
    }
  });

  // Clicking outside the sheet dismisses it, the way a side panel should behave.
  document.addEventListener("pointerdown", (event) => {
    if (!getState().libraryOpen) {
      return;
    }
    const target = event.target as HTMLElement;
    if (
      sheet.contains(target) ||
      target.closest(
        ".menu, .results, .theme-dialog, .settings-dialog, .import-dialog, .confirm-dialog, .add-to",
      )
    ) {
      return;
    }
    if (element("library-open")?.contains(target)) {
      return;
    }
    toggleLibrary(false);
  });

  const render = (): void => {
    const state = getState();

    if (openCollectionId && !collectionById(openCollectionId)) {
      openCollectionId = null;
    }

    // The sheet slides itself in, so the content only swipes once it is up.
    const wasOpen = sheet.classList.contains("is-open");
    const wasList = view !== null && viewCollection(view) === "";
    const nextView = viewKey(state.filter, openCollectionId);
    const swipe = wasOpen && view !== null ? swipeDirection(view, nextView) : 0;
    view = state.libraryOpen ? nextView : null;

    if (wasList) {
      listScroll = listToTop ? 0 : list.scrollTop;
    }
    listToTop = false;

    sheet.classList.toggle("is-open", state.libraryOpen);
    sheet.classList.toggle("is-detail", openCollectionId !== null);
    back.hidden = openCollectionId === null;
    if (newPlaylist) {
      newPlaylist.hidden = openCollectionId !== null;
    }

    for (const chip of chips.querySelectorAll<HTMLElement>("[data-filter]")) {
      chip.classList.toggle("is-on", chip.dataset.filter === state.filter);
    }
    sortLabel.textContent = state.sort === "size" ? "Most songs" : "A to Z";

    if (!state.libraryOpen || openCollectionId === null) {
      closeAddToPlaylist();
    }

    if (!state.libraryOpen) {
      return;
    }

    if (openCollectionId) {
      count.textContent = "";
      folders.innerHTML = "";
      paintDetail(list, state, collectionById(openCollectionId));
    } else {
      const collections = filterCollections(
        state.collections,
        state.filter,
        state.query,
        state.sort,
        state.settings.searchAlgorithm,
      );
      count.textContent = plural(collections.length, "collection");
      delete list.dataset.detail;
      list.innerHTML = renderList(state, collections, creating, renaming);
      folders.innerHTML = renderLibrary(state);
      fillIcons(list);
      hydrateCovers(list);
      restoreEntry();
      list.scrollTop = listScroll;
    }

    if (swipe !== 0) {
      swipePanel(list, swipe);
    }
  };

  subscribe(render);
  render();
}

function viewKey(filter: CollectionFilter, collectionId: string | null): string {
  return `${filter}\u0000${collectionId ?? ""}`;
}

function viewCollection(key: string): string {
  return key.split("\u0000")[1];
}

function swipeDirection(from: string, to: string): 1 | -1 | 0 {
  const [fromFilter, fromId] = from.split("\u0000");
  const [toFilter, toId] = to.split("\u0000");

  if (fromId !== toId) {
    return toId ? 1 : -1;
  }

  const before = COLLECTION_FILTERS.indexOf(fromFilter as CollectionFilter);
  const after = COLLECTION_FILTERS.indexOf(toFilter as CollectionFilter);
  return after === before ? 0 : after > before ? 1 : -1;
}

function swipePanel(root: HTMLElement, direction: 1 | -1): void {
  if (reduceMotionActive()) {
    return;
  }

  root.animate(
    [
      { transform: `translateX(${direction * SWIPE_TRAVEL}rem)`, opacity: 0 },
      { transform: "none", opacity: 1 },
    ],
    { duration: SWIPE_MS, easing: SWIPE_EASE },
  );
}

function paintDetail(list: HTMLElement, state: AppState, collection: Collection | undefined): void {
  const signature = collection
    ? `${collection.id}\u0000${collection.name}\u0000${collection.trackIds.join("|")}`
    : "";

  if (list.dataset.detail === signature) {
    syncLikes(list, state);
    return;
  }

  list.dataset.detail = signature;
  list.innerHTML = collection ? renderDetail(state, collection) : "";
  fillIcons(list);
  hydrateCovers(list);
}

/** Flips the hearts in place, leaving the rows themselves alone. */
function syncLikes(root: ParentNode, state: AppState): void {
  for (const button of root.querySelectorAll<HTMLElement>("[data-like]")) {
    const id = button.dataset.like;
    if (!id) {
      continue;
    }

    const liked = state.likes.has(id);
    button.classList.toggle("is-on", liked);
    button.setAttribute("aria-pressed", String(liked));
    button.setAttribute("aria-label", liked ? "Remove from Liked Songs" : "Add to Liked Songs");

    const wanted = liked ? "like-filled" : "like";
    const holder = button.querySelector<HTMLElement>("[data-icon]");
    if (holder && holder.dataset.icon !== wanted) {
      holder.dataset.icon = wanted;
      fillIcons(button);
    }
  }
}

function renderList(
  state: AppState,
  collections: Collection[],
  creating: boolean,
  renaming: string | null,
): string {
  const rows: string[] = [];

  if (creating) {
    rows.push(`<div class="entry-editor">
      <input class="search" type="text" placeholder="Playlist name" aria-label="New playlist name">
    </div>`);
  }

  for (const collection of collections) {
    if (renaming === collection.id) {
      rows.push(`<div class="entry-editor">
        <input class="search" type="text" value="${escapeHtml(collection.name)}" aria-label="Rename playlist">
      </div>`);
      continue;
    }

    const editable = collection.kind === "playlist";
    rows.push(`
      <div class="entry${isPinned(collection) ? " is-pinned" : ""}" data-collection="${escapeHtml(collection.id)}" role="button" tabindex="0">
        <span class="entry-cover">
          ${collectionCoverHtml(collection, state.tracksById)}
          <button class="cover-play" type="button" data-play="${escapeHtml(collection.id)}" aria-label="Play ${escapeHtml(collection.name)}">
            <span class="btn-icon" data-icon="play"></span>
          </button>
        </span>
        <span class="entry-text">
          <span class="crate-name">${highlightHtml(collection.name, state.query, state.settings.searchAlgorithm)}</span>
          <span class="crate-sub">${escapeHtml(collection.subtitle)}</span>
        </span>
        ${editable ? `<button class="row-more" type="button" data-menu="${escapeHtml(collection.id)}" aria-label="Playlist actions for ${escapeHtml(collection.name)}">...</button>` : ""}
      </div>`);
  }

  if (rows.length === 0) {
    rows.push(`<p class="empty">No collection matches.</p>`);
  }

  return rows.join("");
}

function renderDetail(state: AppState, collection: Collection): string {
  const tracks = collection.trackIds
    .map((id) => state.tracksById.get(id))
    .filter((track): track is Track => track !== undefined);
  const totalMs = tracks.reduce((sum, track) => sum + track.durationMs, 0);
  const reorderable = collection.kind === "playlist";

  const summary = [songCount(tracks.length), totalMs > 0 ? formatTotalDuration(totalMs) : null]
    .filter((part): part is string => part !== null)
    .join(", ");

  const rows = tracks
    .map((track, index) => {
      const liked = state.likes.has(track.id);
      return `
        <li class="track-row${reorderable ? " is-reorderable" : ""}"${reorderable ? ' draggable="true"' : ""} data-track-index="${index}" data-track="${escapeHtml(track.id)}">
          ${reorderable ? `<span class="track-grip" aria-hidden="true"><span class="btn-icon" data-icon="grip"></span></span>` : `<span class="track-grip"></span>`}
          <button class="track-like${liked ? " is-on" : ""}" type="button" data-like="${escapeHtml(track.id)}" aria-pressed="${liked}" aria-label="${liked ? "Remove from Liked Songs" : "Add to Liked Songs"}">
            <span class="btn-icon" data-icon="${liked ? "like-filled" : "like"}"></span>
          </button>
          <span class="track-index">${index + 1}</span>
          <span class="track-title">${escapeHtml(track.title)}</span>
          <span class="track-artist">${escapeHtml(track.artist ?? "")}</span>
          <span class="track-time">${formatDuration(track.durationMs)}</span>
          <button class="track-add" type="button" data-track-add="${escapeHtml(track.id)}" aria-label="Add ${escapeHtml(track.title)} to a playlist">
            <span class="btn-icon" data-icon="add"></span>
          </button>
        </li>`;
    })
    .join("");

  return `
    <div class="detail">
      <div class="detail-head">
        <span class="detail-cover">
          ${collectionCoverHtml(collection, state.tracksById)}
          <button class="cover-play" type="button" data-play="${escapeHtml(collection.id)}" aria-label="Play ${escapeHtml(collection.name)}">
            <span class="btn-icon" data-icon="play"></span>
          </button>
        </span>
        <div class="detail-meta">
          <p class="detail-kind">${escapeHtml(kindLabel(collection.kind))}</p>
          <h3 class="detail-name">${escapeHtml(collection.name)}</h3>
          <p class="detail-sub">${escapeHtml(summary)}</p>
          <div class="detail-actions">
            <button class="pill pill-strong" type="button" data-play="${escapeHtml(collection.id)}">
              <span class="btn-icon" data-icon="play"></span>
              <span>Play</span>
            </button>
            <button class="pill" type="button" data-shuffle="${escapeHtml(collection.id)}">
              <span class="btn-icon" data-icon="shuffle"></span>
              <span>Shuffle</span>
            </button>
            ${reorderable ? `<button class="pill icon-only" type="button" data-menu="${escapeHtml(collection.id)}" aria-label="Playlist actions">...</button>` : ""}
          </div>
        </div>
      </div>
      ${tracks.length > 0 ? `<ol class="tracks">${rows}</ol>` : `<p class="empty">Nothing in here yet.</p>`}
    </div>`;
}

function renderLibrary(state: AppState): string {
  const notes: string[] = [];
  if (state.scanning) {
    notes.push("Scanning...");
  } else {
    notes.push(`${plural(state.tracks.length, "track")} in the library`);
    if (state.skipped > 0) {
      notes.push(`${state.skipped} non-audio file${state.skipped === 1 ? "" : "s"} skipped`);
    }
  }

  const errors = state.scanErrors
    .map((error) => `<li class="folder-error">${escapeHtml(error)}</li>`)
    .join("");

  return `
    <div class="folders-head">
      <span>Library</span>
      <button class="pill" type="button" id="sheet-add-folder">Import</button>
    </div>
    ${state.root ? `<p class="folder-path" title="${escapeHtml(state.root)}">${escapeHtml(state.root)}</p>` : ""}
    <p class="folders-note">${escapeHtml(notes.join(". "))}</p>
    ${errors ? `<ul class="folder-list">${errors}</ul>` : ""}`;
}

/** The right-click menu for a song, opened where the pointer is. */
function openTrackMenu(row: HTMLElement, trackId: string, at: MenuPoint): void {
  const liked = getState().likes.has(trackId);

  openMenu(
    row,
    [
      { label: liked ? "Unlike" : "Like", action: () => void toggleLikeTrack(trackId) },
      { label: "Add to playlist", action: () => openAddToPlaylist(addAnchor(row), trackId) },
      { label: "Delete song", danger: true, action: () => void removeTrack(trackId) },
    ],
    at,
  );
}

/** The panel hangs off the row's add button, the way the click path opens it. */
function addAnchor(row: HTMLElement): HTMLElement {
  return row.querySelector<HTMLElement>("[data-track-add]") ?? row;
}

async function removeTrack(trackId: string): Promise<void> {
  const track = getState().tracksById.get(trackId);
  const confirmed = await confirmDialog({
    title: "Delete song",
    message: `Are you sure you want to delete "${track?.title ?? "this song"}"? The file is removed from your library and from every playlist.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!confirmed) {
    return;
  }

  await deleteTrack(trackId);
}

function openPlaylistMenu(anchor: HTMLElement, id: string, onRename: () => void): void {
  openMenu(anchor, [
    { label: "Rename", action: onRename },
    { label: "Delete playlist", danger: true, action: () => void removePlaylist(id) },
  ]);
}

async function removePlaylist(id: string): Promise<void> {
  const collection = collectionById(id);
  if (collection && collection.trackIds.length > 0) {
    const confirmed = await confirmDialog({
      title: "Delete playlist",
      message: `Are you sure you want to delete "${collection.name}"? The songs in it stay in your library.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) {
      return;
    }
  }

  await deletePlaylist(id);
}

function clearDropTargets(root: HTMLElement): void {
  for (const row of root.querySelectorAll<HTMLElement>(".is-drop-before, .is-drop-after")) {
    row.classList.remove("is-drop-before", "is-drop-after");
  }
}

function dragChipFor(track: Track | undefined): HTMLElement {
  const chip = document.createElement("div");
  chip.className = "drag-chip";
  chip.innerHTML = `
    <span class="drag-chip-cover"${track ? ` style="${plainCoverStyle(track)}"` : ""}></span>
    <span class="drag-chip-text">
      <span class="drag-chip-title">${escapeHtml(track?.title ?? "")}</span>
      <span class="drag-chip-artist">${escapeHtml(track?.artist ?? "")}</span>
    </span>`;
  document.body.appendChild(chip);
  return chip;
}

function clearDragState(root: HTMLElement): void {
  clearDropTargets(root);
  for (const row of root.querySelectorAll<HTMLElement>(".is-dragging")) {
    row.classList.remove("is-dragging");
  }
}

function kindLabel(kind: CollectionKind): string {
  switch (kind) {
    case "all":
      return "All songs";
    case "liked":
      return "Playlist";
    case "playlist":
      return "Playlist";
    case "artist":
      return "Artist";
    case "album":
      return "Album";
  }
}

function element<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
