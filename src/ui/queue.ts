import { escapeHtml } from "../lib/format";
import {
  addTracksToPlaylist,
  artworkUrlFor,
  ensureColour,
  getState,
  player,
  prefetchArtwork,
  pruneArtworkQueue,
  stepTrack,
  subscribe,
  toggleLikeTrack,
  trackById,
} from "../lib/state";
import { stepLater } from "../lib/steps";
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

const EDGE_RESISTANCE = 0.35;
const EDGE_LIMIT = 1.1;
const SPRING_TRANSITION =
  "transform 0.42s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s ease";

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

  const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  let dragging = false;
  let dragStartX = 0;
  let dragRem = 0;
  let suppressClick = false;

  const RAPID_WINDOW_MS = 300;
  let lastCursor = -1;
  let lastCursorAt = 0;
  let rapid = false;
  let bouncing = false;

  const resist = (value: number, total: number, looping: boolean): number => {
    if (looping || total <= 1) {
      return value;
    }
    const last = total - 1;
    if (value < 0) {
      return -Math.min(-value * EDGE_RESISTANCE, EDGE_LIMIT);
    }
    if (value > last) {
      return last + Math.min((value - last) * EDGE_RESISTANCE, EDGE_LIMIT);
    }
    return value;
  };

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

  const place = (
    order: string[],
    cursor: number,
    looping: boolean,
    offsetRem = 0,
    animate = true,
  ): void => {
    const total = order.length;
    if (total === 0) {
      return;
    }

    const virtual = resist(cursor - offsetRem / SPACING_REM, total, looping);

    for (const [index, card] of cards) {
      const offset = offsetFor(index, virtual, total, looping);

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

      const normal = bouncing ? SPRING_TRANSITION : rapid ? "transform 0.16s linear" : "";
      card.style.transition = !animate || jumped ? "none" : normal;
      card.style.transform = transform;
      if (jumped && animate) {
        void card.offsetWidth;
        card.style.transition = normal;
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

  const settle = (): void => {
    const snapshot = player.snapshot();
    const total = snapshot.order.length;
    const looping = snapshot.repeat !== "off";

    const virtual = snapshot.cursor - dragRem / SPACING_REM;
    bouncing = !looping && total > 1 && (virtual < 0 || virtual > total - 1);

    const steps = Math.round(-dragRem / SPACING_REM);
    suppressClick = Math.abs(dragRem) > 4 / remPx;
    dragRem = 0;

    if (steps !== 0 && total > 0) {
      const target = snapshot.cursor + steps;
      const index = looping
        ? ((target % total) + total) % total
        : Math.min(Math.max(target, 0), total - 1);
      const trackId = snapshot.order[index];
      if (trackId) {
        player.moveTo(trackId);
      }
    }

    render();
    bouncing = false;
  };

  carousel.addEventListener("pointerdown", (event) => {
    if ((event.target as HTMLElement).closest("button")) {
      return;
    }
    dragging = true;
    dragStartX = event.clientX;
    dragRem = 0;
    suppressClick = false;
    carousel.setPointerCapture(event.pointerId);
  });

  carousel.addEventListener("pointermove", (event) => {
    if (!dragging) {
      return;
    }
    dragRem = (event.clientX - dragStartX) / remPx;
    render();
  });

  const endDrag = (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    dragging = false;
    if (carousel.hasPointerCapture(event.pointerId)) {
      carousel.releasePointerCapture(event.pointerId);
    }
    settle();
  };

  carousel.addEventListener("pointerup", endDrag);
  carousel.addEventListener("pointercancel", endDrag);

  carousel.addEventListener("click", (event) => {
    if (suppressClick) {
      return;
    }

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
        stepLater(direction, stepTrack);
      }
    },
    { passive: true },
  );

  const render = (): void => {
    const snapshot = player.snapshot();
    const looping = snapshot.repeat !== "off";
    const total = snapshot.order.length;
    const signature = snapshot.order.join("|");

    stage.classList.toggle("queue-open", getState().queueOpen);

    const now = performance.now();
    if (snapshot.cursor !== lastCursor) {
      rapid = now - lastCursorAt < RAPID_WINDOW_MS;
      lastCursor = snapshot.cursor;
      lastCursorAt = now;
    }

    const centre = dragging
      ? Math.round(resist(snapshot.cursor - dragRem / SPACING_REM, total, looping))
      : snapshot.cursor;

    const drift =
      looping && total > 1
        ? Math.abs(offsetFor(centre, windowCenter, total, true))
        : Math.abs(centre - windowCenter);

    if (renderedOrder !== signature || renderedLooping !== looping || !(drift <= REBUILD_MARGIN)) {
      const fresh = renderedOrder !== signature;
      renderedOrder = signature;
      renderedLooping = looping;
      windowCenter = centre;
      syncWindow(snapshot.order, centre, looping);
      if (fresh) {
        prefetchArtwork(snapshot.order);
      }
    }

    carousel.classList.toggle("is-empty", total === 0);
    place(snapshot.order, snapshot.cursor, looping, dragRem, !dragging);
    syncArtwork(snapshot.order);

    const window = new Set<string>();
    for (const [index] of cards) {
      const id = snapshot.order[index];
      if (id) {
        window.add(id);
      }
    }
    pruneArtworkQueue(window, new Set(snapshot.order));
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
