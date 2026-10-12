import { escapeHtml } from "../lib/format";
import {
  artworkUrlFor,
  ensureColour,
  getState,
  player,
  prefetchArtwork,
  pruneArtworkQueue,
  stepTrack,
  subscribe,
  trackById,
} from "../lib/state";
import { stepLater } from "../lib/steps";
import { coverStyle } from "./artwork";

const VISIBLE_RANGE = 5;
const SPACING_REM = 6.5;
const ARC_DROP_REM = 0.55;
const ARC_ANGLE_DEG = 5.5;

/** Cards kept in the DOM beyond what is visible. */
const WINDOW = VISIBLE_RANGE + 3;
/** How far the strip may drift before the window of cards is rebuilt. */
const REBUILD_MARGIN = 2;

/** Wheel deltas are normalised to pixels before accumulating. */
const WHEEL_STEP = 100;
const WHEEL_MAX = 400;
const WHEEL_LINE_PX = 33;

const EDGE_RESISTANCE = 0.35;
const EDGE_LIMIT = 1.1;
const SPRING_TRANSITION =
  "transform 0.42s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s ease";

const LEAVE_MS = 320;
const WASH_MS = 700;

/**
 * Room the hero must keep: its smallest cover plus the column gap, matching the
 * height at which the hero itself folds the cover away.
 */
const HERO_MIN_REM = 8.5;

export function mountQueue(): void {
  const carousel = element("carousel");
  const stage = document.querySelector<HTMLElement>(".stage");
  if (!carousel || !stage) {
    return;
  }

  const cards = new Map<number, HTMLElement>();
  const leaving = new Map<number, HTMLElement>();
  const entering = new Set<HTMLElement>();

  const live = document.createElement("div");
  live.className = "carousel-live";

  const wash = document.createElement("div");
  wash.className = "carousel-wash";

  carousel.append(live, wash);

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let washFrame: number | null = null;
  let washStart = 0;
  let washCentre = Number.NaN;
  let renderedOrder = "";
  let renderedIds = new Set<string>();
  let renderedLooping: boolean | null = null;
  let windowCenter = Number.NaN;

  let centerSlot = 0;
  let lastCursor = 0;

  const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  let dragging = false;
  let dragStartX = 0;
  let dragRem = 0;
  let suppressClick = false;

  const RAPID_WINDOW_MS = 300;
  let lastCursorAt = 0;
  let rapid = false;
  let bouncing = false;

  const indexAt = (slot: number, total: number, looping: boolean): number =>
    looping ? ((slot % total) + total) % total : slot;

  const loopDelta = (delta: number, total: number): number => {
    if (total <= 1) {
      return 0;
    }
    let step = ((delta % total) + total) % total;
    if (step > total / 2) {
      step -= total;
    }
    return step;
  };

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

  /** Every slot the strip needs, clamped to the queue when it does not loop. */
  const requiredSlots = (centre: number, total: number, looping: boolean): number[] => {
    if (total === 0) {
      return [];
    }
    const slots: number[] = [];
    for (let slot = centre - WINDOW; slot <= centre + WINDOW; slot += 1) {
      if (!looping && (slot < 0 || slot >= total)) {
        continue;
      }
      slots.push(slot);
    }
    return slots;
  };

  const isReshuffle = (order: string[]): boolean =>
    order.length > 0 && order.length === renderedIds.size && order.every((id) => renderedIds.has(id));

  const recentre = (centre: number): void => {
    const shift = centre - centerSlot;
    if (shift === 0) {
      return;
    }

    const moved: [number, HTMLElement][] = [];
    for (const [slot, card] of cards) {
      const next = slot + shift;
      card.dataset.slot = String(next);
      moved.push([next, card]);
    }

    cards.clear();
    for (const [slot, card] of moved) {
      cards.set(slot, card);
    }
    centerSlot = centre;
  };

  const createCard = (
    order: string[],
    slot: number,
    total: number,
    looping: boolean,
    visible: boolean,
  ): HTMLElement | null => {
    const index = indexAt(slot, total, looping);
    const track = trackById(order[index]);
    if (!track) {
      return null;
    }

    if (visible) {
      ensureColour(track);
    }

    const card = document.createElement("article");
    card.className = "card";
    card.dataset.slot = String(slot);
    card.dataset.index = String(index);
    card.innerHTML = `
      <div class="card-body" style="${coverStyle(track, visible ? "queue" : "idle")}">
        <div class="card-text">
          <p class="card-title">${escapeHtml(track.title)}</p>
          <p class="card-artist">${escapeHtml(track.artist ?? "Unknown artist")}</p>
        </div>
      </div>`;

    return card;
  };

  const clearCards = (): void => {
    for (const card of cards.values()) {
      card.remove();
    }
    cards.clear();
  };

  /** Fades a card out, then takes it away once the fade has run. */
  const dismiss = (slot: number, card: HTMLElement): void => {
    card.classList.add("is-leaving");
    card.style.pointerEvents = "none";
    leaving.set(slot, card);

    window.setTimeout(() => {
      card.remove();
      if (leaving.get(slot) === card) {
        leaving.delete(slot);
      }
    }, LEAVE_MS);
  };

  const endWash = (): void => {
    if (washFrame !== null) {
      window.cancelAnimationFrame(washFrame);
      washFrame = null;
    }
    live.style.clipPath = "";
    wash.style.clipPath = "";
    wash.replaceChildren();
  };

  const washAway = (): void => {
    endWash();

    for (const card of cards.values()) {
      wash.appendChild(card);
    }
    cards.clear();

    if (reducedMotion.matches) {
      wash.replaceChildren();
      return;
    }

    const rect = carousel.getBoundingClientRect();
    const left = -rect.left;
    const right = window.innerWidth - rect.left;
    const top = -rect.top;
    const bottom = window.innerHeight - rect.top;
    const trail = window.innerHeight * 0.24;
    const span = right - left + trail;

    const paint = (progress: number): void => {
      const lead = left + progress * span;
      wash.style.clipPath =
        `polygon(${lead}px ${top}px, ${right + trail}px ${top}px, ` +
        `${right + trail}px ${bottom}px, ${lead - trail}px ${bottom}px)`;
      live.style.clipPath =
        `polygon(${left - trail}px ${top}px, ${lead}px ${top}px, ` +
        `${lead - trail}px ${bottom}px, ${left - trail}px ${bottom}px)`;
    };

    const sweep = (now: number): void => {
      const progress = Math.min((now - washStart) / WASH_MS, 1);
      paint(progress);

      if (progress < 1) {
        washFrame = requestAnimationFrame(sweep);
        return;
      }
      endWash();
    };

    paint(0);
    washStart = performance.now();
    washFrame = requestAnimationFrame(sweep);
  };

  const syncWindow = (
    order: string[],
    total: number,
    looping: boolean,
    centre: number,
    animate: boolean,
  ): void => {
    const wanted = requiredSlots(centre, total, looping);
    const wantedSet = new Set(wanted);

    for (const [slot, card] of cards) {
      if (!wantedSet.has(slot)) {
        cards.delete(slot);
        dismiss(slot, card);
      }
    }

    for (const slot of wanted) {
      if (cards.has(slot)) {
        continue;
      }

      // A slot can come back before its old card has finished fading out.
      const stale = leaving.get(slot);
      if (stale) {
        leaving.delete(slot);
        stale.remove();
      }

      const visible = Math.abs(slot - centre) <= VISIBLE_RANGE;
      const card = createCard(order, slot, total, looping, visible);
      if (card) {
        cards.set(slot, card);
        if (animate) {
          card.classList.add("is-entering");
          entering.add(card);
        }
        live.appendChild(card);
      }
    }
  };

  const place = (total: number, virtualCenter: number, animate: boolean): void => {
    if (total === 0) {
      return;
    }

    for (const [slot, card] of cards) {
      const offset = slot - virtualCenter;

      // A card that was re-centred has moved a whole strip, not one step.
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

  const flushEntering = (): void => {
    if (entering.size === 0) {
      return;
    }

    const arrived = [...entering];
    entering.clear();
    void carousel.offsetWidth;

    requestAnimationFrame(() => {
      for (const card of arrived) {
        card.classList.remove("is-entering");
      }
    });
  };

  const syncArtwork = (order: string[], total: number, looping: boolean): void => {
    for (const [slot, card] of cards) {
      const track = trackById(order[indexAt(slot, total, looping)]);
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

    const virtual = centerSlot - dragRem / SPACING_REM;
    bouncing = !looping && total > 1 && (virtual < 0 || virtual > total - 1);

    const steps = Math.round(-dragRem / SPACING_REM);
    suppressClick = Math.abs(dragRem) > 4 / remPx;
    dragRem = 0;

    if (steps !== 0 && total > 0) {
      const targetSlot = looping
        ? centerSlot + steps
        : Math.min(Math.max(centerSlot + steps, 0), total - 1);
      const index = indexAt(targetSlot, total, looping);
      const trackId = snapshot.order[index];
      if (trackId) {
        // Move the strip first, so the render `moveTo` triggers is a no-op.
        centerSlot = targetSlot;
        lastCursor = index;
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

    // Cards carried by the wash are the old strip, so they act on nothing.
    const card = target.closest<HTMLElement>(".card");
    if (!card?.dataset.slot || !cards.has(Number(card.dataset.slot))) {
      return;
    }

    const index = Number(card.dataset.index);
    const trackId = player.snapshot().order[index];
    if (trackId) {
      // Bring the clicked card to the centre, then start it.
      centerSlot = Number(card.dataset.slot);
      lastCursor = index;
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

  /** True while the stage cannot spare the room the carousel needs. */
  const isCramped = (): boolean =>
    document.documentElement.classList.contains("is-cramped");

  /** The carousel shows while the user wants it and the stage has the room. */
  const queueShown = (cramped: boolean): boolean => getState().queueOpen && !cramped;

  const render = (): void => {
    const snapshot = player.snapshot();
    const looping = snapshot.repeat !== "off";
    const total = snapshot.order.length;
    const signature = snapshot.order.join("|");

    stage.classList.toggle("queue-open", queueShown(isCramped()));

    const now = performance.now();
    if (snapshot.cursor !== lastCursor) {
      rapid = now - lastCursorAt < RAPID_WINDOW_MS;
      lastCursorAt = now;
    }

    const fresh = renderedOrder !== signature;
    let washed = false;

    if (fresh) {
      if (isReshuffle(snapshot.order)) {
        washAway();
        washed = true;
      } else {
        clearCards();
      }
      renderedIds = new Set(snapshot.order);
      windowCenter = Number.NaN;
      centerSlot = snapshot.cursor;
      lastCursor = snapshot.cursor;
      renderedOrder = signature;
      renderedLooping = looping;
      prefetchArtwork(snapshot.order);
    } else {
      if (looping !== renderedLooping) {
        recentre(snapshot.cursor);
        renderedLooping = looping;
        windowCenter = Number.NaN;
      }

      if (looping) {
        // Follow the cursor around the loop, so a short queue keeps scrolling.
        centerSlot += loopDelta(snapshot.cursor - lastCursor, total);
        lastCursor = snapshot.cursor;
      } else {
        centerSlot = snapshot.cursor;
        lastCursor = snapshot.cursor;
      }
    }

    const rawCenter = centerSlot - dragRem / SPACING_REM;
    const virtualCenter = looping ? rawCenter : resist(rawCenter, total, false);
    const materialCenter = Math.round(virtualCenter);

    if (washed) {
      washCentre = virtualCenter;
    } else if (washFrame !== null && Math.abs(virtualCenter - washCentre) > 0.01) {
      endWash();
    }

    if (!(Math.abs(materialCenter - windowCenter) <= REBUILD_MARGIN)) {
      windowCenter = materialCenter;
      syncWindow(snapshot.order, total, looping, materialCenter, !fresh);
    }

    carousel.classList.toggle("is-empty", total === 0);
    place(total, virtualCenter, !dragging);
    syncArtwork(snapshot.order, total, looping);

    if (total > 0) {
      const window = new Set<string>();
      for (const slot of cards.keys()) {
        window.add(snapshot.order[indexAt(slot, total, looping)]);
      }
      pruneArtworkQueue(window, new Set(snapshot.order));
    }

    flushEntering();
  };

  /**
   * The carousel is paid for out of the hero's height, so it is only offered
   * while the stage can spare its room. Once it cannot, the carousel and its
   * toggle fold away, but the toggle itself is the user's and is kept.
   */
  const fitCarousel = (): void => {
    const root = getComputedStyle(document.documentElement);
    const rootPx = parseFloat(root.fontSize) || 16;
    const reserved = parseFloat(root.getPropertyValue("--carousel-space")) * rootPx;

    const titlebar = document.getElementById("titlebar");
    const dock = document.getElementById("dock");
    const dockStyles = dock ? getComputedStyle(dock) : null;
    const dockBox = dock
      ? dock.offsetHeight +
        parseFloat(dockStyles?.marginTop ?? "0") +
        parseFloat(dockStyles?.marginBottom ?? "0")
      : 0;

    // What the stage has left once the titlebar and the dock are paid for.
    const free = stage.clientHeight - (titlebar?.offsetHeight ?? 0) - dockBox;
    const cramped = free < reserved + HERO_MIN_REM * rootPx;

    const wasCramped = document.documentElement.classList.contains("is-cramped");
    document.documentElement.classList.toggle("is-cramped", cramped);
    if (cramped !== wasCramped) {
      stage.classList.toggle("queue-open", queueShown(cramped));
    }
  };

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(fitCarousel).observe(stage);
  }
  fitCarousel();

  player.onChange(render);
  subscribe(render);
  render();
}

function element(id: string): HTMLElement | null {
  return document.getElementById(id);
}
