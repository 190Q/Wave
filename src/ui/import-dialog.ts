import { escapeHtml } from "../lib/format";
import { scoreItems, type FieldsOf } from "../lib/search";
import {
  collectionById,
  fetchCovers,
  fetchLyrics,
  getState,
  importFolder,
  importSpotify,
  openSpotifyConfig,
  planSpotify,
  refreshSpotifyStatus,
  setNotice,
  subscribe,
  type AppState,
} from "../lib/state";
import type {
  Collection,
  ImportPlan,
  ImportProgress,
  SearchAlgorithm,
  SpotifyStatus,
} from "../types";
import { confirmDialog } from "./confirm";
import { highlightHtml } from "./highlight";
import { fillIcons } from "./icons";
import { placePicker, windowFrame } from "./picker";

const DIALOG_MS = 220;

/** How many collections a selector offers at once. */
const PROPOSAL_LIMIT = 5;

/** Set while the dialog is mounted, so the topbar and the sheet can open it. */
let openPanel: ((anchor?: HTMLElement) => void) | null = null;

/** Opens the import dialog, anchored on the button that asked for it. */
export function openImport(anchor?: HTMLElement): void {
  openPanel?.(anchor);
}

export function mountImportDialog(): void {
  const dialog = element<HTMLDialogElement>("import-dialog");
  const fallback = element("import-open");
  const closeButton = element("import-close");
  const body = element("import-body");

  if (!dialog || !fallback || !closeButton || !body) {
    return;
  }

  /** What the pop animation grows from. */
  let anchor = fallback;
  let closeTimer: number | null = null;

  /** The selector whose list is down, if any. */
  let combo: {
    key: string;
    input: HTMLInputElement;
    picker: HTMLElement;
    proposals: Collection[];
    active: number;
  } | null = null;

  /** The collection each fetch section points at, by picker key. */
  const picked = new Map<string, string>();

  /** Whether the Spotify setup steps are showing. */
  let setupOpen = false;

  const setOrigin = (): void => {
    const dialogRect = dialog.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    const x = rect.left + rect.width / 2 - dialogRect.left;
    const y = rect.top + rect.height / 2 - dialogRect.top;
    dialog.style.transformOrigin = `${x}px ${y}px`;
  };

  const render = (): void => {
    body.innerHTML = sectionsHtml(getState(), picked);
    fillIcons(body);
    paintSpotify();
  };

  const paintSpotify = (): void => {
    const state = getState();

    const status = body.querySelector<HTMLElement>("#import-spotify-state");
    if (status) {
      status.innerHTML = spotifyStateHtml(state, setupOpen);
    }

    const history = body.querySelector<HTMLElement>("#import-history");
    if (history) {
      history.innerHTML = historyHtml(state);
    }

    const lyrics = body.querySelector<HTMLElement>("#import-lyrics-state");
    if (lyrics) {
      lyrics.innerHTML = state.lyricsProgress ? progressHtml(state.lyricsProgress) : "";
    }

    const covers = body.querySelector<HTMLElement>("#import-covers-state");
    if (covers) {
      covers.innerHTML = state.coversProgress ? progressHtml(state.coversProgress) : "";
    }
  };

  /** Puts the field back to the collection it is actually pointed at. */
  const revert = (input: HTMLInputElement): void => {
    const key = input.dataset.combo;
    if (key) {
      input.value = chosenCollection(getState(), key, picked)?.name ?? "";
    }
  };

  /** Takes the list down. `keepValue` leaves the field as it stands. */
  const closeCombo = (keepValue = false): void => {
    const open = combo;
    if (!open) {
      return;
    }
    open.picker.remove();
    open.input.classList.remove("is-open");
    combo = null;
    if (!keepValue) {
      revert(open.input);
    }
  };

  /** The collections that answer to what is typed, best first. */
  const proposalsFor = (query: string): Collection[] => {
    const state = getState();
    return scoreItems(
      state.collections,
      query,
      state.settings.searchAlgorithm,
      collectionFields,
      state.collections,
    )
      .slice(0, PROPOSAL_LIMIT)
      .map((entry) => entry.item);
  };

  /** Marks the row the keyboard is on, and keeps it in view. */
  const paintActive = (): void => {
    const open = combo;
    if (!open) {
      return;
    }
    const rows = Array.from(open.picker.querySelectorAll<HTMLElement>(".slot-option"));
    rows.forEach((row, index) => {
      row.classList.toggle("is-highlighted", index === open.active);
    });
    rows[open.active]?.scrollIntoView({ block: "nearest" });
  };

  /** Repaints the list for what the field holds, then re-hangs it. */
  const paintCombo = (query: string): void => {
    const open = combo;
    if (!open) {
      return;
    }
    open.proposals = proposalsFor(query);
    open.active = open.proposals.length === 0 ? -1 : 0;
    open.picker.innerHTML = proposalsHtml(
      open.proposals,
      query,
      getState().settings.searchAlgorithm,
    );
    paintActive();
    placePicker(open.picker, open.input, windowFrame(), "above");
  };

  const openCombo = (input: HTMLInputElement, key: string, query = ""): void => {
    closeCombo();
    const picker = document.createElement("div");
    picker.className = "slot-picker import-picker";
    // Kept from taking focus, so the click still lands on a proposal.
    picker.addEventListener("pointerdown", (event) => {
      if ((event.target as HTMLElement).closest(".slot-option")) {
        event.preventDefault();
      }
    });
    body.appendChild(picker);
    input.classList.add("is-open");
    combo = { key, input, picker, proposals: [], active: -1 };
    // Opened on the whole list; typing narrows it from there.
    paintCombo(query);
  };

  /** Points a fetch section at another collection, without a re-render. */
  const commit = (collection: Collection): void => {
    const open = combo;
    if (!open) {
      return;
    }
    picked.set(open.key, collection.id);
    open.input.value = collection.name;
    closeCombo(true);
  };

  /** Moves the highlight by `step`, wrapping around the list. */
  const stepCombo = (step: number): void => {
    const open = combo;
    if (!open || open.proposals.length === 0) {
      return;
    }
    open.active = (open.active + step + open.proposals.length) % open.proposals.length;
    paintActive();
  };

  const open = (from?: HTMLElement): void => {
    // Already up: reopening would only replay the pop.
    if (dialog.open && !dialog.classList.contains("is-closed")) {
      return;
    }
    if (closeTimer !== null) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
    }
    anchor = from ?? fallback;
    closeCombo(true);
    render();
    if (!getState().importing) {
      void refreshSpotifyStatus();
    }
    // Start collapsed, then let the stylesheet play it in.
    dialog.classList.add("is-closed");
    if (!dialog.open) {
      dialog.showModal();
    }
    setOrigin();
    void dialog.offsetWidth;
    dialog.classList.remove("is-closed");
  };

  const close = (): void => {
    if (!dialog.open || dialog.classList.contains("is-closed")) {
      return;
    }
    closeCombo(true);
    setOrigin();
    dialog.classList.add("is-closed");
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      dialog.close();
    }, DIALOG_MS);
  };

  openPanel = open;
  closeButton.addEventListener("click", close);

  body.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    // A second click on a selector that was dismissed puts its list back up.
    const field = target.closest<HTMLInputElement>("[data-combo]");
    if (field && field.dataset.combo && combo?.input !== field) {
      field.select();
      openCombo(field, field.dataset.combo);
      return;
    }

    const option = target.closest<HTMLElement>("[data-picker-set]");
    if (option?.dataset.pickerSet) {
      const collection = collectionById(option.dataset.pickerSet);
      if (collection) {
        commit(collection);
      }
      return;
    }

    const action = target.closest<HTMLElement>("[data-import]");
    if (action?.dataset.import) {
      runImportAction(action.dataset.import);
      return;
    }

    // The rest are placeholders until their logic lands, so they only say so.
    const soon = target.closest<HTMLElement>("[data-soon]");
    if (soon) {
      setNotice(soon.dataset.soon ?? null);
    }
  });

  const runImportAction = (action: string): void => {
    switch (action) {
      case "songs":
      case "playlist":
        close();
        void importFolder(action === "playlist");
        return;
      case "spotify": {
        const field = body.querySelector<HTMLInputElement>("#import-spotify-url");
        if (field) {
          void startSpotifyImport(field.value);
        }
        return;
      }
      case "setup":
        setupOpen = !setupOpen;
        paintSpotify();
        return;
      case "config":
        void openSpotifyConfig();
        return;
      case "recheck":
        void refreshSpotifyStatus();
        return;
      case "lyrics":
      case "covers": {
        const collection = chosenCollection(getState(), action, picked);
        if (collection) {
          void (action === "lyrics" ? fetchLyrics(collection.id) : fetchCovers(collection.id));
        }
        return;
      }
      default:
        return;
    }
  };

  /**
   * Reads the link before anything is fetched, so the songs the library already
   * has can be asked about rather than quietly downloaded a second time.
   */
  const startSpotifyImport = async (url: string): Promise<void> => {
    const plan = await planSpotify(url);
    if (!plan) {
      return;
    }

    let downloadDuplicates = false;
    if (plan.duplicates > 0) {
      downloadDuplicates = await confirmDialog({
        title: "Already in your library",
        message: duplicateMessage(plan),
        confirmLabel: "Download again",
        cancelLabel: "No",
      });
    }

    await importSpotify(url, downloadDuplicates);
  };

  body.addEventListener("focusin", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.dataset.combo) {
      return;
    }
    input.select();
    openCombo(input, input.dataset.combo);
  });

  body.addEventListener("input", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.dataset.combo) {
      return;
    }
    if (combo?.input !== input) {
      openCombo(input, input.dataset.combo, input.value);
      return;
    }
    paintCombo(input.value);
  });

  body.addEventListener("focusout", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.dataset.combo) {
      closeCombo();
    }
  });

  body.addEventListener("keydown", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    // Enter in the link field is the same as pressing its button.
    if (input.id === "import-spotify-url") {
      if (event.key === "Enter") {
        event.preventDefault();
        void startSpotifyImport(input.value);
      }
      return;
    }

    if (combo?.input !== input) {
      return;
    }

    switch (event.key) {
      case "Tab":
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        stepCombo(event.key === "ArrowUp" || event.shiftKey ? -1 : 1);
        return;
      }
      case "Enter": {
        event.preventDefault();
        const chosen = combo.proposals[combo.active];
        if (chosen) {
          commit(chosen);
        }
        return;
      }
      default:
        return;
    }
  });

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      close();
    }
  });

  // Escape closes natively; intercept it so the same animation plays.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (combo !== null) {
      closeCombo();
      return;
    }
    close();
  });

  body.addEventListener("scroll", () => closeCombo());
  window.addEventListener("resize", () => closeCombo());

  // A status check, a progress update or a finished import all land here.
  subscribe(() => {
    if (dialog.open && !dialog.classList.contains("is-closed")) {
      paintSpotify();
    }
  });
}

function sectionsHtml(state: AppState, picked: Map<string, string>): string {
  return [
    localSection(),
    spotifySection(),
    historySection(),
    ...FETCH_SECTIONS.map((spec) => fetchSection(spec, state, picked)),
  ].join("");
}

function localSection(): string {
  return section(
    "Local folder",
    `<p class="import-hint">Bring in a folder from this computer.</p>
    <div class="import-actions">
      <button class="pill" type="button" data-import="songs">Import songs only</button>
      <button class="pill" type="button" data-import="playlist">Import as a playlist</button>
    </div>`,
  );
}

function spotifySection(): string {
  return section(
    "Spotify",
    `<p class="import-hint">Paste a track or playlist link.</p>
    <div class="import-field">
      <input
        class="import-input"
        id="import-spotify-url"
        type="text"
        placeholder="https://open.spotify.com/..."
        aria-label="Spotify link"
        spellcheck="false"
        autocomplete="off"
      />
      <button
        class="pill icon-only"
        type="button"
        data-import="spotify"
        aria-label="Import from Spotify"
      >
        <span class="btn-icon" data-icon="import"></span>
      </button>
    </div>
    <div id="import-spotify-state"></div>`,
  );
}

/** The status line, the setup steps, and whatever the import is doing. */
function spotifyStateHtml(state: AppState, setupOpen: boolean): string {
  const progress = state.importing;
  const running = progress !== null && progress.phase !== "failed";

  return `${running ? "" : statusHtml(state, setupOpen)}${progress ? progressHtml(progress) : ""}`;
}

function statusHtml(state: AppState, setupOpen: boolean): string {
  const status = state.spotify;
  const ready =
    status?.configured === true &&
    status.accepted &&
    status.ytDlp &&
    status.ffmpeg;

  const message = status
    ? status.message
    : state.spotifyChecking
      ? "Checking the Spotify setup..."
      : "Spotify has not been checked yet.";
  const dot = status === null ? "" : ready ? " is-ok" : " is-warn";

  return `
    <div class="import-status">
      <span class="import-dot${dot}" aria-hidden="true"></span>
      <span class="import-status-text">${escapeHtml(message)}</span>
      <button class="pill" type="button" data-import="setup" aria-expanded="${setupOpen}">Set up</button>
    </div>
    ${setupOpen ? setupHtml(status) : ""}`;
}

function setupHtml(status: SpotifyStatus | null): string {
  const redirect = status?.redirectUri ?? "";
  const path = status?.envPath ?? "";

  return `
    <div class="import-setup">
      <p class="import-hint">Spotify needs an app of your own before anything can be downloaded.</p>
      <ol class="import-steps">
        <li>Create an app at <code class="import-uri">developer.spotify.com/dashboard</code>.</li>
        <li>Add this to that app's Redirect URIs, exactly as written:
          <code class="import-uri">${escapeHtml(redirect)}</code>
        </li>
        <li>Paste the app's Client ID and Client Secret into the <code class="import-uri">.env</code> below.</li>
      </ol>
      ${path ? `<p class="import-path" title="${escapeHtml(path)}">${escapeHtml(path)}</p>` : ""}
      <div class="import-actions">
        <button class="pill" type="button" data-import="config">Open the config folder</button>
        <button class="pill" type="button" data-import="recheck">Check again</button>
      </div>
      <p class="import-hint">${escapeHtml(downloadHint(status))}</p>
    </div>`;
}

/** Says which downloader was found, so its location is never a mystery. */
function downloadHint(status: SpotifyStatus | null): string {
  const ytDlp = status?.ytDlp
    ? `yt-dlp found: ${status.ytDlpSource}`
    : "yt-dlp not found. Install it, or set YTDLP_PATH.";
  const ffmpeg = status?.ffmpeg
    ? "ffmpeg found."
    : "ffmpeg not found. Install it, or set FFMPEG_PATH.";
  return `${ytDlp} ${ffmpeg}`;
}

function progressHtml(progress: ImportProgress): string {
  const counted = progress.total > 0 ? `${progress.done} of ${progress.total}` : "";
  const line = [counted, progress.label].filter(Boolean).join(" - ");
  const reused =
    progress.reused > 0 ? `${progress.reused} already in your library.` : "";
  const failed = progress.phase === "failed";

  return `
    <div class="import-progress${failed ? " is-failed" : ""}">
      ${line ? `<p class="import-progress-line">${escapeHtml(line)}</p>` : ""}
      <p class="import-hint">${escapeHtml(progress.message)}</p>
      ${reused ? `<p class="import-hint">${escapeHtml(reused)}</p>` : ""}
      ${failuresHtml(progress.failures)}
    </div>`;
}

/** The question asked when a link overlaps with what is already in the library. */
function duplicateMessage(plan: ImportPlan): string {
  const what = `${plan.duplicates} of ${plan.total} ${
    plan.total === 1 ? "song is" : "songs are"
  } already in your library`;
  const which = plan.examples.length > 0 ? ` (${plan.examples.join(", ")})` : "";
  return `${what}${which}. Download them again?`;
}

function failuresHtml(failures: string[]): string {
  if (failures.length === 0) {
    return "";
  }

  const shown = failures.slice(-4);
  const rest = failures.length - shown.length;

  return `<ul class="import-failures">
    ${shown.map((failure) => `<li>${escapeHtml(failure)}</li>`).join("")}
    ${rest > 0 ? `<li>and ${rest} more</li>` : ""}
  </ul>`;
}

function historySection(): string {
  return section("Recent imports", `<ul class="import-history" id="import-history"></ul>`);
}

function historyHtml(state: AppState): string {
  if (state.recentImports.length === 0) {
    return `<li class="import-history-empty">Nothing imported yet.</li>`;
  }

  return state.recentImports
    .map(
      (record) => `
      <li class="import-history-row">
        <span class="import-history-source">${record.source === "spotify" ? "Spotify" : "Folder"}</span>
        <span class="import-history-name">${escapeHtml(record.name)}</span>
        <span class="import-history-detail">${escapeHtml(record.detail)}</span>
      </li>`,
    )
    .join("");
}

interface FetchSection {
  key: string;
  title: string;
  hint: string;
  /** Names the picker for a screen reader. */
  target: string;
  /** The action its button runs. A section without one is still a placeholder. */
  action?: string;
  notice?: string;
}

const FETCH_SECTIONS: FetchSection[] = [
  {
    key: "lyrics",
    title: "Fetch lyrics",
    hint: "Look up lyrics for every song in a collection. Timed lyrics are saved beside the songs, plain ones go into the files themselves.",
    target: "Collection to fetch lyrics for",
    action: "lyrics",
  },
  {
    key: "covers",
    title: "Fetch covers",
    hint: "Look for the cover art of every song in a collection that has none.",
    target: "Collection to fetch covers for",
    action: "covers",
  },
];

function fetchSection(
  spec: FetchSection,
  state: AppState,
  picked: Map<string, string>,
): string {
  const chosen = chosenCollection(state, spec.key, picked);

  return section(
    spec.title,
    `<p class="import-hint">${escapeHtml(spec.hint)}</p>
    <div class="import-field">
      <input
        class="import-combo"
        type="text"
        value="${escapeHtml(chosen?.name ?? "")}"
        data-combo="${spec.key}"
        placeholder="Collection name"
        aria-label="${escapeHtml(spec.target)}"
        autocomplete="off"
        spellcheck="false"
      />
      <button class="pill" type="button" data-import="${spec.action}">Fetch</button>
    </div>
    <div id="import-${spec.key}-state"></div>`,
  );
}

/** The collection a fetch section points at, defaulting to the first one. */
function chosenCollection(
  state: AppState,
  key: string,
  picked: Map<string, string>,
): Collection | undefined {
  const id = picked.get(key);
  return state.collections.find((collection) => collection.id === id) ?? state.collections[0];
}

/** A collection is matched on its name alone, as the library filter does. */
const collectionFields: FieldsOf<Collection> = (collection) => [collection.name];

/** The proposals, with the part of each name that earned the match marked. */
function proposalsHtml(
  proposals: Collection[],
  query: string,
  algorithm: SearchAlgorithm,
): string {
  if (proposals.length === 0) {
    return `<p class="import-picker-empty">No collection matches.</p>`;
  }

  return proposals
    .map(
      (collection) => `
      <button
        class="slot-option"
        type="button"
        data-picker-set="${escapeHtml(collection.id)}"
      >
        <span class="slot-option-name">${highlightHtml(collection.name, query, algorithm)}</span>
        <span class="slot-option-sub">${escapeHtml(collection.subtitle)}</span>
      </button>`,
    )
    .join("");
}

function section(title: string, inner: string, soon = false): string {
  return `<section class="import-section">
    <h3 class="import-title">${escapeHtml(title)}${soon ? `<span class="import-tag">Soon</span>` : ""}</h3>
    ${inner}
  </section>`;
}

function element<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
