/**
 * What the browser cannot be asked for is handed over by the frame instead:
 * the pixel ratio, the pointer's own answers and the system insets. All three
 * are read by the app while it boots, so this runs first.
 */

const params = new URLSearchParams(window.location.search);

applyInsets();
applyPixelRatio();
applyPointer();

function applyInsets(): void {
  const values = {
    top: edge(params.get("insetTop")),
    right: edge(params.get("insetRight")),
    bottom: edge(params.get("insetBottom")),
    left: edge(params.get("insetLeft")),
  };
  if (values.top + values.right + values.bottom + values.left > 0) {
    window.__WAVE_INSETS__ = values;
  }
}

function applyPixelRatio(): void {
  const ratio = Number(params.get("dpr"));
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return;
  }

  window.__WAVE_DPR__ = ratio;
  try {
    Object.defineProperty(window, "devicePixelRatio", {
      get: () => window.__WAVE_DPR__ ?? ratio,
      configurable: true,
    });
  } catch {
    // Left as the host reports it.
  }
}

function applyPointer(): void {
  // A desktop preset keeps the mouse's own answers.
  if (!phone()) {
    return;
  }
  reportTouch();
  coarsenPointer();
  reportTouchPoints();
}

/** The key device.ts remembers the kind under, in the storage the two pages share. */
function phone(): boolean {
  const kind = localStorage.getItem("wave:device");
  return kind === "android" || kind === "linuxPhone";
}

/** The browser owns pointerType, so the answer is rewritten rather than faked. */
function reportTouch(): void {
  if (typeof PointerEvent === "undefined") {
    return;
  }
  try {
    Object.defineProperty(PointerEvent.prototype, "pointerType", {
      get: () => "touch",
      configurable: true,
    });
  } catch {
    // Left as the host reports it.
  }
}

/** A phone admits to a finger, which is what the touch checks read. */
function reportTouchPoints(): void {
  try {
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5, configurable: true });
  } catch {
    // Left as the host reports it.
  }
}

/** Answers the pointer and hover queries for a finger, and passes the rest on. */
function coarsenPointer(): void {
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query: string): MediaQueryList => {
    const answer = coarseAnswer(query);
    const list = original(query);
    if (answer === null) {
      return list;
    }
    try {
      Object.defineProperty(list, "matches", { get: () => answer, configurable: true });
    } catch {
      // Left as the host reports it.
    }
    return list;
  };
}

function coarseAnswer(query: string): boolean | null {
  const text = query.toLowerCase().replace(/\s+/g, "");
  if (text.includes("pointer:coarse")) {
    return true;
  }
  if (text.includes("pointer:fine")) {
    return false;
  }
  if (text.includes("hover:none")) {
    return true;
  }
  if (text.includes("hover:hover")) {
    return false;
  }
  return null;
}

function edge(value: string | null): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
