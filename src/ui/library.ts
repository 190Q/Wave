import { filterCollections, isPinned } from "../lib/collections";
import { escapeHtml, formatDuration, formatTotalDuration, plural, songCount } from "../lib/format";
import {
  addTracksToPlaylist,
  collectionById,
  createPlaylist,
  deletePlaylist,
  getState,
  importFolder,
  playCollection,
  playFromCollection,
  removeTracksFromPlaylist,
  renamePlaylist,
  reorderPlaylist,
  setFilter,
  setQuery,
  setSort,
  shuffleCollection,
  subscribe,
  toggleLibrary,
  toggleLikeTrack,
  player,
  type AppState,
} from "../lib/state";
import type { Collection, CollectionFilter, CollectionKind, Track } from "../types";
import { mosaicHtml } from "./artwork";
import { hydrateCovers } from "./covers";
import { fillIcons } from "./icons";
import { openMenu, type MenuItem } from "./menu";

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
  let dragFrom: number | null = null;

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

  filterInput.addEventListener("input", () => setQuery(filterInput.value));

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

    const trackMenuButton = target.closest<HTMLElement>("[data-track-menu]");
    if (trackMenuButton?.dataset.trackMenu) {
      openTrackMenu(trackMenuButton, trackMenuButton.dataset.trackMenu, openCollectionId);
      return;
    }

    const trackRow = target.closest<HTMLElement>("[data-track]");
    if (trackRow?.dataset.track && openCollectionId) {
      playFromCollection(openCollectionId, trackRow.dataset.track);
      return;
    }

    const row = target.closest<HTMLElement>("[data-collection]");
    if (row?.dataset.collection) {
      openCollectionId = row.dataset.collection;
      renaming = null;
      creating = false;
      render();
    }
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

  list.addEventListener("dragstart", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-track-index]");
    if (!row) {
      return;
    }
    dragFrom = Number(row.dataset.trackIndex);
    row.classList.add("is-dragging");
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
    clearDropTargets(list);
    row.classList.add("is-drop-target");
  });

  list.addEventListener("drop", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-track-index]");
    if (dragFrom === null || !row || !openCollectionId) {
      return;
    }
    event.preventDefault();

    const collection = collectionById(openCollectionId);
    const to = Number(row.dataset.trackIndex);
    const from = dragFrom;
    dragFrom = null;
    clearDragState(list);

    if (!collection || from === to) {
      return;
    }

    const reordered = [...collection.trackIds];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    void reorderPlaylist(collection.id, reordered);
  });

  list.addEventListener("dragend", () => {
    dragFrom = null;
    clearDragState(list);
  });

  folders.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("#sheet-add-folder");
    if (button) {
      openMenu(button, [
        { label: "Import as a playlist", action: () => void importFolder(true) },
        { label: "Import songs only", action: () => void importFolder(false) },
      ]);
    }
  });

  // Clicking outside the sheet dismisses it, the way a side panel should behave.
  document.addEventListener("pointerdown", (event) => {
    if (!getState().libraryOpen) {
      return;
    }
    const target = event.target as HTMLElement;
    if (sheet.contains(target) || target.closest(".menu, .theme-menu, .results")) {
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

    if (!state.libraryOpen) {
      return;
    }

    if (openCollectionId) {
      const collection = collectionById(openCollectionId);
      count.textContent = "";
      list.innerHTML = collection ? renderDetail(state, collection) : "";
      folders.innerHTML = "";
    } else {
      const collections = filterCollections(state.collections, state.filter, state.query, state.sort);
      count.textContent = plural(collections.length, "collection");
      list.innerHTML = renderList(state, collections, creating, renaming);
      folders.innerHTML = renderLibrary(state);
    }

    fillIcons(list);
    hydrateCovers(list);
  };

  subscribe(render);
  render();
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
          ${mosaicHtml(collection.trackIds, state.tracksById)}
          <button class="cover-play" type="button" data-play="${escapeHtml(collection.id)}" aria-label="Play ${escapeHtml(collection.name)}">
            <span class="btn-icon" data-icon="play"></span>
          </button>
        </span>
        <span class="entry-text">
          <span class="crate-name">${escapeHtml(collection.name)}</span>
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
    .map(
      (track, index) => `
        <li class="track-row${reorderable ? " is-reorderable" : ""}"${reorderable ? ' draggable="true"' : ""} data-track-index="${index}" data-track="${escapeHtml(track.id)}">
          ${reorderable ? `<span class="track-grip" aria-hidden="true">::</span>` : `<span class="track-grip"></span>`}
          <span class="track-index">${index + 1}</span>
          <span class="track-title">${escapeHtml(track.title)}</span>
          <span class="track-artist">${escapeHtml(track.artist ?? "")}</span>
          <span class="track-time">${formatDuration(track.durationMs)}</span>
          <button class="row-more" type="button" data-track-menu="${escapeHtml(track.id)}" aria-label="Actions for ${escapeHtml(track.title)}">...</button>
        </li>`,
    )
    .join("");

  return `
    <div class="detail">
      <div class="detail-head">
        <span class="detail-cover">
          ${mosaicHtml(collection.trackIds, state.tracksById)}
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
      <button class="pill" type="button" id="sheet-add-folder">Import folder</button>
    </div>
    ${state.root ? `<p class="folder-path" title="${escapeHtml(state.root)}">${escapeHtml(state.root)}</p>` : ""}
    <p class="folders-note">${escapeHtml(notes.join(". "))}</p>
    ${errors ? `<ul class="folder-list">${errors}</ul>` : ""}`;
}

function openPlaylistMenu(anchor: HTMLElement, id: string, onRename: () => void): void {
  openMenu(anchor, [
    { label: "Rename", action: onRename },
    { label: "Delete playlist", danger: true, action: () => void deletePlaylist(id) },
  ]);
}

function openTrackMenu(anchor: HTMLElement, trackId: string, collectionId: string | null): void {
  const state = getState();
  const liked = state.likes.has(trackId);
  const inPlaylist = collectionId !== null && collectionById(collectionId)?.kind === "playlist";

  const items: MenuItem[] = [
    {
      label: liked ? "Remove from Liked Songs" : "Add to Liked Songs",
      action: () => void toggleLikeTrack(trackId),
    },
    { label: "Play next", action: () => player.insertAfterCurrent(trackId) },
    { label: "Add to queue", action: () => player.appendToQueue(trackId) },
  ];

  for (const playlist of state.playlists) {
    items.push({
      label: `Add to ${playlist.name}`,
      action: () => void addTracksToPlaylist(playlist.id, [trackId]),
    });
  }

  if (inPlaylist && collectionId) {
    items.push({
      label: "Remove from this playlist",
      danger: true,
      action: () => void removeTracksFromPlaylist(collectionId, [trackId]),
    });
  }

  openMenu(anchor, items);
}

function clearDropTargets(root: HTMLElement): void {
  for (const row of root.querySelectorAll<HTMLElement>(".is-drop-target")) {
    row.classList.remove("is-drop-target");
  }
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
