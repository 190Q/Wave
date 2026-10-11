import { escapeHtml } from "../lib/format";
import {
  addTracksToPlaylist,
  artworkUrlFor,
  ensureColour,
  getState,
  player,
  pruneArtworkQueue,
  subscribe,
  toggleLikeTrack,
  trackById,
} from "../lib/state";
import { coverStyle } from "./artwork";
import { openMenu, type MenuItem } from "./menu";

const VISIBLE_RANGE = 5;
const SPACING_REM = 6.5;
const ARC_DROP_REM = 0.55;
const ARC_ANGLE_DEG = 5.5;

/** Cards kept in the DOM beyond what is visible. */
const WINDOW = VISIBLE_RANGE + 3;
/** How far the cursor may drift before the window is rebuilt. */
const REBUILD_MARGIN = 2;

/** Wheel deltas are normalised to pixels before accumulating. */
const WHEEL_STEP = 100;
const WHEEL_MAX = 400;
const WHEEL_LINE_PX = 33;

export function mountQueue(): void {
  const carousel = element("carousel");
  const stage = document.querySelector<HTMLElement>(".stage");
  if (!carousel || !stage) {
    return;
  }

  /** The cards currently in the DOM, keyed by their index in the queue. */
  const cards = new Map<number, HTMLElement>();
  let renderedOrder = "";
  let renderedLooping: boolean | null = null;
  let windowCenter = Number.NaN;

  /**
   * A card's position relative to the cursor. With repeat on the queue is a
   * loop, so the offset wraps and the first card follows the last.
   */
  const offsetFor = (index: number, cursor: number, total: number, looping: boolean): number => {
    if (looping && total > 1) {
      const half = Math.floor(total / 2);
      return ((((index - cursor + half) % total) + total) % total) - half;
    }
    return index - cursor;
  };

  const requiredIndices = (total: number, cursor: number, looping: boolean): number[] => {
    const span = Math.min(total, WINDOW * 2 + 1);
    const start = cursor - Math.floor(span / 2);
    const indices: number[] = [];

    for (let step = 0; step < span; step += 1) {
      let index = start + step;
      if (looping) {
        index = ((index % total) + total) % total;
      }
      if (index >= 0 && index < total && !indices.includes(index)) {
        indices.push(index);
      }
    }

    return indices;
  };

  const createCard = (order: string[], index: number, visible: boolean): HTMLElement | null => {
    const track = trackById(order[index]);
    if (!track) {
      return null;
    }

    if (visible) {
      ensureColour(track);
    }

    const card = document.createElement("article");
    card.className = "card";
    card.dataset.index = String(index);
    card.innerHTML = `
      <div class="card-body" style="${coverStyle(track, visible ? "queue" : "idle")}">
        <button class="card-more" type="button" data-more="${index}" aria-label="Actions for ${escapeHtml(track.title)}">...</button>
        <div class="card-text">
          <p class="card-title">${escapeHtml(track.title)}</p>
          <p class="card-artist">${escapeHtml(track.artist ?? "Unknown artist")}</p>
        </div>
      </div>`;

    return card;
  };

  const syncWindow = (order: string[], cursor: number, looping: boolean): void => {
    const wanted = new Set(requiredIndices(order.length, cursor, looping));

    for (const [index, card] of cards) {
      if (!wanted.has(index)) {
        card.remove();
        cards.delete(index);
      }
    }

    for (const index of wanted) {
      if (cards.has(index)) {
        continue;
      }
      const visible = Math.abs(offsetFor(index, cursor, order.length, looping)) <= VISIBLE_RANGE;
      const card = createCard(order, index, visible);
      if (card) {
        cards.set(index, card);
        carousel.appendChild(card);
      }
    }
  };

  const place = (order: string[], cursor: number, looping: boolean): void => {
    const total = order.length;
    if (total === 0) {
      return;
    }

    for (const [index, card] of cards) {
      const offset = offsetFor(index, cursor, total, looping);

      // A card that wraps around the loop has moved a whole queue, not one step.
      const jumped =
        card.dataset.offset !== undefined && Math.abs(offset - Number(card.dataset.offset)) > VISIBLE_RANGE + 1;
      card.dataset.offset = String(offset);

      const distance = Math.abs(offset);
      const hidden = distance > VISIBLE_RANGE;

      const transform =
        `translateX(${offset * SPACING_REM}rem) ` +
        `translateY(${(distance * distance * ARC_DROP_REM).toFixed(3)}rem) ` +
        `rotate(${offset * ARC_ANGLE_DEG}deg) ` +
        `scale(${1 - Math.min(distance, VISIBLE_RANGE) * 0.04})`;

      if (jumped) {
        card.style.transition = "none";
        card.style.transform = transform;
        void card.offsetWidth;
        card.style.transition = "";
      } else {
        card.style.transform = transform;
      }
      card.style.zIndex = String(100 - distance);
      card.style.opacity = hidden ? "0" : "1";
      card.style.pointerEvents = hidden ? "none" : "auto";

      card.classList.toggle("is-current", offset === 0);
      card.classList.toggle("is-past", offset < 0);
    }
  };

  const syncArtwork = (order: string[]): void => {
    for (const [index, card] of cards) {
      const track = trackById(order[index]);
      if (!track) {
        continue;
      }

      const visible = Math.abs(Number(card.dataset.offset ?? 0)) <= VISIBLE_RANGE;
      const signature = artworkUrlFor(track, visible ? "queue" : "idle") ?? "";
      if (card.dataset.artwork === signature) {
        continue;
      }

      card.dataset.artwork = signature;
      card
        .querySelector<HTMLElement>(".card-body")
        ?.setAttribute("style", coverStyle(track, visible ? "queue" : "idle"));
    }
  };

  carousel.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const more = target.closest<HTMLElement>("[data-more]");
    if (more) {
      const trackId = player.snapshot().order[Number(more.dataset.more)];
      if (trackId) {
        openTrackMenu(more, trackId);
      }
      return;
    }

    const card = target.closest<HTMLElement>(".card");
    if (card?.dataset.index === undefined) {
      return;
    }
    const trackId = player.snapshot().order[Number(card.dataset.index)];
    if (trackId) {
      player.playTrack(trackId);
    }
  });

  let wheelAccumulator = 0;
  let wheelDirection = 0;
  let stepsPending = 0;
  let stepScheduled = false;

  const runStep = (): void => {
    stepScheduled = false;
    if (stepsPending === 0) {
      return;
    }
    const direction = Math.sign(stepsPending);
    stepsPending -= direction;
    if (direction > 0) {
      player.next();
    } else {
      player.previous();
    }
    if (stepsPending !== 0) {
      scheduleStep();
    }
  };

  function scheduleStep(): void {
    if (stepScheduled) {
      return;
    }
    stepScheduled = true;
    requestAnimationFrame(runStep);
  }

  carousel.addEventListener(
    "wheel",
    (event) => {
      const perLine = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? WHEEL_STEP : 1;
      const delta = (event.deltaY + event.deltaX) * perLine;
      if (delta === 0) {
        return;
      }

      const direction = Math.sign(delta);
      if (direction !== wheelDirection) {
        wheelAccumulator = 0;
        wheelDirection = direction;
      }

      wheelAccumulator = Math.max(-WHEEL_MAX, Math.min(WHEEL_MAX, wheelAccumulator + delta));

      while (Math.abs(wheelAccumulator) >= WHEEL_STEP) {
        wheelAccumulator -= WHEEL_STEP * direction;
        stepsPending += direction;
      }

      scheduleStep();
    },
    { passive: true },
  );

  const render = (): void => {
    const snapshot = player.snapshot();
    const looping = snapshot.repeat !== "off";
    const total = snapshot.order.length;

    stage.classList.toggle("queue-open", getState().queueOpen);

    const drift =
      looping && total > 1
        ? Math.abs(offsetFor(snapshot.cursor, windowCenter, total, true))
        : Math.abs(snapshot.cursor - windowCenter);

    if (renderedOrder !== snapshot.order.join("|") || renderedLooping !== looping || !(drift <= REBUILD_MARGIN)) {
      renderedOrder = snapshot.order.join("|");
      renderedLooping = looping;
      windowCenter = snapshot.cursor;
      syncWindow(snapshot.order, snapshot.cursor, looping);
    }

    carousel.classList.toggle("is-empty", total === 0);
    place(snapshot.order, snapshot.cursor, looping);
    syncArtwork(snapshot.order);

    const wanted = new Set<string>();
    for (const [index] of cards) {
      const id = snapshot.order[index];
      if (id) {
        wanted.add(id);
      }
    }
    pruneArtworkQueue(wanted);
  };

  player.onChange(render);
  subscribe(render);
  render();
}

function openTrackMenu(anchor: HTMLElement, trackId: string): void {
  const state = getState();
  const liked = state.likes.has(trackId);

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

  items.push({
    label: "Remove from queue",
    action: () => player.removeFromQueue(trackId),
    danger: true,
  });

  openMenu(anchor, items);
}

function element(id: string): HTMLElement | null {
  return document.getElementById(id);
}
