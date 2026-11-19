import { device } from "../lib/device";
import { escapeHtml } from "../lib/format";
import {
  artworkUrlFor,
  colourFor,
  ensureColour,
  getState,
  mayRevealArtwork,
  player,
  prefetchArtwork,
  prioritizeNearbyArtwork,
  pruneArtworkQueue,
  stepTrack,
  subscribe,
  trackById,
  type ArtworkTier,
} from "../lib/state";
import { reduceMotionActive, subscribeMotion } from "../lib/motion";
import { stepLater } from "../lib/steps";
import { coverStyle } from "./artwork";
import { openTrackMenu } from "./library";
import { coverWipe, setCoverStyle, type CoverSwap } from "./wipe";

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
const COVER_WAIT_MS = 200;

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
  const popping = new Set<HTMLElement>();
  const unattendedArtwork = new WeakSet<HTMLElement>();
  const pendingCovers = new Map<HTMLElement, { timer: number; style: string }>();

  const live = document.createElement("div");
  live.className = "carousel-live";

  const wash = document.createElement("div");
  wash.className = "carousel-wash";

  carousel.append(live, wash);

  let washFrame: number | null = null;
  let washStart = 0;
  let washCentre = Number.NaN;
  let renderedOrder = "";
  let renderedIds = new Set<string>();
  let renderedSourceId: string | null = null;
  let renderedLooping: boolean | null = null;
  let windowCenter = Number.NaN;
  let popTimer: number | null = null;

  let centerSlot = 0;
  let lastCursor = 0;
  let lastTravel = 0;

  const rootStyles = getComputedStyle(document.documentElement);
  const remPx = parseFloat(rootStyles.fontSize) || 16;
  const spacingRem = parseFloat(rootStyles.getPropertyValue("--card-spacing")) || SPACING_REM;
  let dragging = false;
  let dragPointerId: number | null = null;
  let dragStartX = 0;
  let dragRem = 0;
  let suppressClick = false;

  /** The pointer position the next frame will use. */
  let dragX = 0;
  let dragFrame: number | null = null;

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

  const slotStep = (cursorDelta: number, travelDelta: number, total: number): number =>
    total > 1 && travelDelta !== 0 ? travelDelta : loopDelta(cursorDelta, total);

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

  const isReshuffle = (order: readonly string[]): boolean =>
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
    order: readonly string[],
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

    const tier: ArtworkTier = visible ? "queue" : "idle";
    const reveal = device() === "android" || mayRevealArtwork(track.id);
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.slot = String(slot);
    card.dataset.index = String(index);
    card.dataset.trackId = track.id;
    card.dataset.artwork = reveal ? artworkUrlFor(track, tier) ?? "" : "";
    card.dataset.colour = colourFor(track);
    card.innerHTML = `
      <div class="card-body" style="${coverStyle(track, tier, reveal)}">
        <div class="card-text">
          <p class="card-title">${escapeHtml(track.title)}</p>
          <p class="card-artist">${escapeHtml(track.artist ?? "Unknown artist")}</p>
        </div>
      </div>`;

    return card;
  };

  const cancelPendingCover = (card: HTMLElement): void => {
    const pending = pendingCovers.get(card);
    if (pending) {
      window.clearTimeout(pending.timer);
      pendingCovers.delete(card);
    }
  };

  const clearCards = (): void => {
    for (const card of cards.values()) {
      cancelPendingCover(card);
      card.remove();
    }
    cards.clear();
  };

  /** Fades a card out, then takes it away once the fade has run. */
  const dismiss = (slot: number, card: HTMLElement): void => {
    if (reduceMotionActive()) {
      card.remove();
      return;
    }
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

  /** Settles the cards that were waiting to pop in. */
  const flushPopping = (): void => {
    if (popTimer !== null) {
      window.clearTimeout(popTimer);
      popTimer = null;
    }
    if (popping.size === 0) {
      return;
    }

    const arrived = [...popping];
    popping.clear();
    if (reduceMotionActive()) {
      for (const card of arrived) {
        card.classList.remove("is-entering");
      }
      return;
    }
    void carousel.offsetWidth;

    requestAnimationFrame(() => {
      for (const card of arrived) {
        card.classList.remove("is-entering");
      }
    });
  };

  const washAway = (drop?: Set<HTMLElement>): void => {
    flushPopping();
    endWash();

    for (const card of cards.values()) {
      wash.appendChild(card);
    }
    cards.clear();

    // Cards the new collection cannot fill fall away instead of being swept.
    if (drop && drop.size > 0) {
      void wash.offsetWidth;
      for (const card of drop) {
        card.classList.add("is-leaving");
      }
    }

    if (reduceMotionActive()) {
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

  const swapCollection = (oldCentre: number, oldCount: number, newCount: number): number => {
    const extra = oldCount - newCount;

    if (extra > 0) {
      const byDistance = [...cards.entries()].sort(
        (a, b) => Math.abs(b[0] - oldCentre) - Math.abs(a[0] - oldCentre),
      );
      washAway(new Set(byDistance.slice(0, extra).map(([, card]) => card)));
    } else {
      washAway();
    }

    const grown = Math.max(0, newCount - oldCount);
    if (grown > 0) {
      popTimer = window.setTimeout(flushPopping, WASH_MS);
    }
    return grown;
  };

  const syncWindow = (
    order: readonly string[],
    total: number,
    looping: boolean,
    centre: number,
    enter: "all" | number | null,
    replaceImmediately = false,
  ): void => {
    const wanted = requiredSlots(centre, total, looping);
    const wantedSet = new Set(wanted);

    for (const [slot, card] of cards) {
      if (!wantedSet.has(slot)) {
        cards.delete(slot);
        cancelPendingCover(card);
        if (replaceImmediately) {
          card.remove();
        } else {
          dismiss(slot, card);
        }
      }
    }

    const created: [number, HTMLElement][] = [];

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
        created.push([slot, card]);
        live.appendChild(card);
      }
    }

    if (reduceMotionActive()) {
      return;
    }
    if (enter === "all") {
      for (const [, card] of created) {
        if (device() !== "desktop" && !card.dataset.artwork) {
          continue;
        }
        card.classList.add("is-entering");
        entering.add(card);
      }
    } else if (typeof enter === "number" && enter > 0) {
      // The cards the strip grew by are the ones furthest from the centre.
      created.sort((a, b) => Math.abs(b[0] - centre) - Math.abs(a[0] - centre));
      for (const [, card] of created.slice(0, enter)) {
        if (device() !== "desktop" && !card.dataset.artwork) {
          continue;
        }
        card.classList.add("is-entering");
        popping.add(card);
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
        `translateX(${offset * spacingRem}rem) ` +
        `translateY(${(distance * distance * ARC_DROP_REM).toFixed(3)}rem) ` +
        `rotate(${offset * ARC_ANGLE_DEG}deg) ` +
        `scale(${1 - Math.min(distance, VISIBLE_RANGE) * 0.04})`;

      const normal = reduceMotionActive()
        ? "none"
        : bouncing
          ? SPRING_TRANSITION
          : rapid
            ? "transform 0.16s linear"
            : "";
      const wanted = !animate || jumped ? "none" : normal;
      if (card.style.transition !== wanted) {
        card.style.transition = wanted;
      }
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
    if (reduceMotionActive()) {
      for (const card of arrived) {
        card.classList.remove("is-entering");
      }
      return;
    }
    void carousel.offsetWidth;

    requestAnimationFrame(() => {
      for (const card of arrived) {
        card.classList.remove("is-entering");
      }
    });
  };

  const syncCards = (order: readonly string[], total: number, looping: boolean): void => {
    const swaps: CoverSwap[] = [];

    for (const [slot, card] of cards) {
      const index = indexAt(slot, total, looping);
      const track = trackById(order[index]);
      if (!track) {
        continue;
      }

      const changed = card.dataset.trackId !== track.id;
      const pending = pendingCovers.get(card);
      const hadCover = Boolean(card.dataset.artwork) || Boolean(pending);
      if (changed) {
        cancelPendingCover(card);
        unattendedArtwork.delete(card);
        card.dataset.trackId = track.id;
        if (Math.abs(Number(card.dataset.offset ?? 0)) <= VISIBLE_RANGE) {
          ensureColour(track);
        }
      }
      card.dataset.index = String(index);

      const title = card.querySelector<HTMLElement>(".card-title");
      const artist = card.querySelector<HTMLElement>(".card-artist");
      if (title && title.textContent !== track.title) {
        title.textContent = track.title;
      }
      const artistName = track.artist ?? "Unknown artist";
      if (artist && artist.textContent !== artistName) {
        artist.textContent = artistName;
      }

      if (reduceMotionActive() && (changed || !card.dataset.artwork)) {
        unattendedArtwork.add(card);
      }
      if (device() !== "android" && !mayRevealArtwork(track.id)) {
        continue;
      }

      const visible = Math.abs(Number(card.dataset.offset ?? 0)) <= VISIBLE_RANGE;
      const tier: ArtworkTier = visible ? "queue" : "idle";
      const signature = artworkUrlFor(track, tier) ?? "";
      const colour = colourFor(track);
      if (!changed && card.dataset.artwork === signature && card.dataset.colour === colour) {
        continue;
      }

      const revealing = visible && signature !== "" && !unattendedArtwork.has(card) &&
        (!card.dataset.artwork || (device() === "android" && changed && card.dataset.artwork !== signature));
      if (signature) {
        unattendedArtwork.delete(card);
        cancelPendingCover(card);
      }
      card.dataset.artwork = signature;
      card.dataset.colour = colour;

      const body = card.querySelector<HTMLElement>(".card-body");
      if (!body) {
        continue;
      }

      const style = coverStyle(track, tier);
      if (changed && device() === "android" && hadCover && !signature && track.artworkPath &&
          visible && !reduceMotionActive()) {
        setCoverStyle(body, body.getAttribute("style") ?? "");
        const next = {
          style,
          timer: window.setTimeout(() => {
            if (pendingCovers.get(card) === next) {
              pendingCovers.delete(card);
              setCoverStyle(body, next.style);
            }
          }, COVER_WAIT_MS),
        };
        pendingCovers.set(card, next);
      } else if (!changed && pending && !signature) {
        pending.style = style;
      } else if (revealing) {
        swaps.push({ body, style });
      } else {
        setCoverStyle(body, style);
      }
    }

    coverWipe(swaps);
  };

  const settle = (): void => {
    const snapshot = player.snapshot();
    const total = snapshot.order.length;
    const looping = snapshot.repeat !== "off";

    const virtual = centerSlot - dragRem / spacingRem;
    bouncing = !looping && total > 1 && (virtual < 0 || virtual > total - 1);

    const steps = Math.round(-dragRem / spacingRem);
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

  const paintDrag = (): void => {
    dragFrame = null;
    if (!dragging) {
      return;
    }
    dragRem = (dragX - dragStartX) / remPx;
    render();
  };

  // Coalesce pointer events into one render per frame.
  const moveDrag = (clientX: number): void => {
    dragX = clientX;
    if (dragFrame === null) {
      dragFrame = requestAnimationFrame(paintDrag);
    }
  };

  carousel.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) {
      return;
    }
    dragging = true;
    dragPointerId = event.pointerId;
    dragStartX = event.clientX;
    dragRem = 0;
    suppressClick = false;
    carousel.setPointerCapture(event.pointerId);
    carousel.classList.add("is-dragging");
  });

  carousel.addEventListener("pointermove", (event) => {
    if (!dragging) {
      return;
    }
    moveDrag(event.clientX);
  });

  const endDrag = (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    dragging = false;
    dragPointerId = null;
    carousel.classList.remove("is-dragging");
    if (dragFrame !== null) {
      window.cancelAnimationFrame(dragFrame);
      dragFrame = null;
    }
    if (carousel.hasPointerCapture(event.pointerId)) {
      carousel.releasePointerCapture(event.pointerId);
    }
    dragRem = (event.clientX - dragStartX) / remPx;
    settle();
  };

  carousel.addEventListener("pointerup", endDrag);
  carousel.addEventListener("pointercancel", endDrag);

  carousel.addEventListener("contextmenu", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const card = target?.closest<HTMLElement>(".card")
      ?? document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".card");
    const slot = Number(card?.dataset.slot);
    if (!card || cards.get(slot) !== card) {
      return;
    }

    const snapshot = player.snapshot();
    const trackId = snapshot.order[Number(card.dataset.index)];
    if (!trackId) {
      return;
    }
    event.preventDefault();

    if (dragging) {
      dragging = false;
      carousel.classList.remove("is-dragging");
      if (dragFrame !== null) {
        window.cancelAnimationFrame(dragFrame);
        dragFrame = null;
      }
      if (dragPointerId !== null && carousel.hasPointerCapture(dragPointerId)) {
        carousel.releasePointerCapture(dragPointerId);
      }
      dragPointerId = null;
      dragRem = 0;
      suppressClick = true;
      render();
    }

    const source = getState().collections.find((collection) => collection.id === snapshot.sourceId);
    const collectionId = source?.trackIds.includes(trackId) ? source.id : null;
    openTrackMenu(card, collectionId, [trackId], { x: event.clientX, y: event.clientY }, {
      play: () => player.playTrack(trackId),
    });
  });

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

    if (device() !== "desktop") {
      prioritizeNearbyArtwork(snapshot.order, snapshot.cursor, looping);
    } else {
      prioritizeNearbyArtwork([], 0, false);
    }

    stage.classList.toggle("queue-open", queueShown(isCramped()));

    const now = performance.now();
    if (snapshot.cursor !== lastCursor) {
      rapid = now - lastCursorAt < RAPID_WINDOW_MS;
      lastCursorAt = now;
    }

    const fresh = renderedOrder !== signature;
    let washed = false;
    let grown = 0;
    let reused = false;

    if (fresh) {
      const oldCentre = centerSlot;
      const oldCount = cards.size;
      const reshuffle = isReshuffle(snapshot.order);
      const collectionChanged = snapshot.sourceId !== renderedSourceId;
      const shown = queueShown(isCramped());

      if (device() === "android" && shown && oldCount > 0) {
        flushPopping();
        endWash();
        const arriving = [...cards.values()].filter((card) => card.classList.contains("is-entering"));
        for (const card of arriving) {
          card.classList.add("is-settling");
          card.classList.remove("is-entering");
        }
        if (arriving.length > 0) {
          void carousel.offsetWidth;
          for (const card of arriving) {
            card.classList.remove("is-settling");
          }
        }
        for (const card of leaving.values()) {
          card.remove();
        }
        leaving.clear();
        recentre(snapshot.cursor);
        reused = true;
      }

      renderedIds = new Set(snapshot.order);
      windowCenter = Number.NaN;
      centerSlot = snapshot.cursor;
      lastCursor = snapshot.cursor;
      lastTravel = snapshot.travel;
      renderedOrder = signature;
      renderedLooping = looping;
      renderedSourceId = snapshot.sourceId;
      if (device() === "desktop") {
        prefetchArtwork(snapshot.order);
      }

      if (!reused) {
        const awaitingArtwork = device() !== "desktop" &&
          snapshot.currentId !== null && !mayRevealArtwork(snapshot.currentId);
        if (awaitingArtwork) {
          flushPopping();
          endWash();
          clearCards();
        } else if (reshuffle) {
          washAway();
          washed = true;
        } else if (collectionChanged && shown && !reduceMotionActive() && oldCount > 0) {
          const newCount = requiredSlots(snapshot.cursor, total, looping).length;
          grown = swapCollection(oldCentre, oldCount, newCount);
          washed = true;
        } else {
          clearCards();
        }
      }
    } else {
      if (looping !== renderedLooping) {
        recentre(snapshot.cursor);
        renderedLooping = looping;
        windowCenter = Number.NaN;
      }

      if (looping) {
        // Follow the cursor around the loop, so a short queue keeps scrolling.
        centerSlot += slotStep(snapshot.cursor - lastCursor, snapshot.travel - lastTravel, total);
        lastCursor = snapshot.cursor;
      } else {
        centerSlot = snapshot.cursor;
        lastCursor = snapshot.cursor;
      }
      lastTravel = snapshot.travel;
    }

    const rawCenter = centerSlot - dragRem / spacingRem;
    const virtualCenter = looping ? rawCenter : resist(rawCenter, total, false);
    const materialCenter = Math.round(virtualCenter);

    if (washed) {
      washCentre = virtualCenter;
    } else if (washFrame !== null && Math.abs(virtualCenter - washCentre) > 0.01) {
      endWash();
    }

    if (!(Math.abs(materialCenter - windowCenter) <= REBUILD_MARGIN)) {
      windowCenter = materialCenter;
      syncWindow(
        snapshot.order,
        total,
        looping,
        materialCenter,
        fresh ? (grown > 0 ? grown : null) : "all",
        reused,
      );
    }

    carousel.classList.toggle("is-empty", total === 0);
    place(total, virtualCenter, !dragging);
    syncCards(snapshot.order, total, looping);

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
    const declared = parseFloat(root.getPropertyValue("--carousel-space"));
    const reserved = Number.isFinite(declared) ? declared * rootPx : carousel.offsetHeight;

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
  subscribeMotion(() => {
    if (!reduceMotionActive()) {
      return;
    }
    for (const [card, pending] of pendingCovers) {
      cancelPendingCover(card);
      const body = card.querySelector<HTMLElement>(".card-body");
      if (body) {
        setCoverStyle(body, pending.style);
      }
    }
    endWash();
    flushPopping();
    flushEntering();
    for (const card of leaving.values()) {
      card.remove();
    }
    leaving.clear();
    render();
  });
  render();
}

function element(id: string): HTMLElement | null {
  return document.getElementById(id);
}
