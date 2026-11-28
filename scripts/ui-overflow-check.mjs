import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const logPaths = [
  `C:\\Users\\${"long-user-name".repeat(12)}\\AppData\\Local\\Wave\\download.log`,
  `/home/${"longusername".repeat(15)}/.local/share/wave/download.log`,
];
const viewports = [
  { name: "desktop", device: "desktop", width: 1200, height: 800 },
  { name: "desktop compact", device: "desktop", width: 720, height: 360 },
  { name: "Android", device: "android", width: 360, height: 720 },
  { name: "Android small", device: "android", width: 320, height: 640 },
  { name: "Linux phone", device: "linuxPhone", width: 360, height: 720 },
  { name: "Linux phone small", device: "linuxPhone", width: 320, height: 640 },
];

let server;
let browser;
let baseUrl;

before(async () => {
  server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
  });
  await server.listen();
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.WAVE_TEST_BROWSER || undefined,
    headless: true,
  });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function openApp(viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    reducedMotion: "reduce",
    userAgent: viewport.device === "android"
      ? "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36"
      : undefined,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.addInitScript((logPath) => {
    let internals;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => internals,
      set(value) {
        const invoke = value.invoke;
        value.invoke = (command, ...args) =>
          command === "import_log_path" ? Promise.resolve(logPath) : invoke(command, ...args);
        internals = value;
      },
    });
  }, logPaths[0]);
  await page.goto(`${baseUrl}/dev/phone/app.html?device=${viewport.device}`);
  await page.waitForFunction(async () => {
    const { getState } = await import("/src/lib/state.ts");
    return getState().ready && !document.documentElement.classList.contains("is-starting");
  });
  return { context, page };
}

async function overflow(page, selector) {
  return page.locator(selector).evaluate((root) => {
    const allowed = ".crates, .song-editor-viewport";
    return [root, ...root.querySelectorAll("*")]
      .filter((element) => {
        if (!(element instanceof HTMLElement) || element.matches(allowed)) return false;
        if (!element.getClientRects().length || getComputedStyle(element).visibility !== "visible") return false;
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return false;
        return ["auto", "scroll"].includes(getComputedStyle(element).overflowX)
          && element.scrollWidth > element.clientWidth + 1;
      })
      .map((element) => ({
        element: element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`,
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
  });
}

test("popup backdrops ignore releases from inside", async (t) => {
  const { context, page } = await openApp(viewports[0]);
  const popups = [
    { name: "search", popup: "#search-modal", inside: "#search", open: () => page.locator("#search-open").click() },
    { name: "theme", popup: "#theme-dialog", inside: "#picker-hex", open: () => page.locator("#theme-toggle-face").click() },
    { name: "settings", popup: "#settings-dialog", inside: ".settings-head h2", open: () => page.locator("#settings-open").click() },
    { name: "import", popup: "#import-dialog", inside: "#import-title", open: () => page.locator("#import-open").click() },
    { name: "update", popup: "#update-dialog", inside: "#update-title", open: () => invoke(page, "update", "openUpdate") },
    {
      name: "confirmation", popup: "#confirm-dialog", inside: "#confirm-title",
      open: () => invoke(page, "confirm", "confirmDialog", { title: "Test", message: "Test", confirmLabel: "Confirm" }),
    },
    { name: "seek", popup: "#seek-dialog", inside: "#seek-title", open: () => invoke(page, "seek-time", "openSeekTime") },
    {
      name: "track editor", popup: "#track-editor-dialog", inside: "#track-editor-title",
      open: async () => invoke(page, "track-editor", "openTrackEditor", await firstTrack(page)),
    },
  ];
  try {
    for (const entry of popups) {
      await t.test(entry.name, async () => {
        await page.reload();
        await page.waitForFunction(async () => {
          const { getState } = await import("/src/lib/state.ts");
          return getState().ready && !document.documentElement.classList.contains("is-starting");
        });
        await entry.open();
        const popup = page.locator(entry.popup);
        await popup.waitFor({ state: "visible" });
        await page.locator(entry.inside).hover();
        await page.mouse.down();
        await page.mouse.move(5, 5);
        await page.mouse.up();
        assert.equal(await popup.evaluate((element) => element.classList.contains("is-closed")), false);

        await page.mouse.down();
        assert.equal(await popup.evaluate((element) => element.classList.contains("is-closed")), true);
        await page.mouse.up();
      });
    }
  } finally {
    await context.close();
  }
});

test("equaliser pickers survive unrelated updates and close when rebuilt", async () => {
  const { context, page } = await openApp(viewports[0]);
  try {
    await invoke(page, "eq", "openEq");
    const drop = page.locator(".eq-band-shape").first();
    await drop.click();
    const picker = page.locator(".eq-picker");
    await picker.waitFor({ state: "visible" });

    await page.evaluate(async () => {
      const state = await import("/src/lib/state.ts");
      state.setEqPreampDb(state.getState().settings.eqPreampDb);
    });
    assert.equal(await picker.isVisible(), true);
    await picker.getByRole("button", { name: "Low shelf", exact: true }).click();
    assert.equal(await drop.locator(".eq-drop-label").textContent(), "Low shelf");
    assert.equal(await drop.locator("..").evaluate((element) => element.classList.contains("is-on")), true);
    assert.equal(await picker.isHidden(), true);

    await drop.click();
    await picker.waitFor({ state: "visible" });
    await page.evaluate(async () => (await import("/src/lib/state.ts")).addEqBand());
    assert.equal(await picker.isHidden(), true);
    assert.equal(await drop.getAttribute("aria-expanded"), "false");

    const sideDrop = page.locator("#eq-side .eq-drop").first();
    await sideDrop.scrollIntoViewIfNeeded();
    await sideDrop.click();
    await picker.waitFor({ state: "visible" });
    await page.evaluate(async () => {
      const state = await import("/src/lib/state.ts");
      state.setEqPreampDb(state.getState().settings.eqPreampDb);
    });
    assert.equal(await picker.isVisible(), true);
    await page.evaluate(async () => {
      const state = await import("/src/lib/state.ts");
      state.setEqAutoPreamp(!state.getState().settings.eqAutoPreamp);
    });
    assert.equal(await picker.isHidden(), true);
    assert.equal(await sideDrop.getAttribute("aria-expanded"), "false");

    await page.evaluate(async () => (await import("/src/lib/state.ts")).saveEqPreset("Example"));
    const name = page.locator("#eq-preset-name");
    await name.fill("Ex");
    const names = page.locator("#eq-modal .slot-picker.import-picker");
    await names.waitFor({ state: "visible" });
    await page.evaluate(async () => {
      const state = await import("/src/lib/state.ts");
      state.setEqPreampDb(state.getState().settings.eqPreampDb);
    });
    assert.equal(await names.isVisible(), true);
    await names.getByRole("button", { name: "Example", exact: true }).click();
    assert.equal(await name.inputValue(), "Example");
    assert.equal(await names.isHidden(), true);
  } finally {
    await context.close();
  }
});

test("equaliser graph starts sharp and highlights individual bands", async () => {
  const { context, page } = await openApp({ ...viewports[0], deviceScaleFactor: 1.25 });
  try {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const initial = await page.evaluate(async () => {
      const state = await import("/src/lib/state.ts");
      const ui = await import("/src/ui/eq.ts");
      state.seedEqBands();
      const [first, second] = state.getState().settings.eqBands;
      state.updateEqBand(first.id, { gain: 5 });
      state.updateEqBand(second.id, { gain: -4 });
      state.setEqEnabled(true);

      const stroke = CanvasRenderingContext2D.prototype.stroke;
      window.eqTestStrokes = [];
      CanvasRenderingContext2D.prototype.stroke = function (...args) {
        if (this.canvas.id === "eq-canvas") {
          window.eqTestStrokes.push({
            width: this.lineWidth, colour: this.strokeStyle, alpha: this.globalAlpha, dash: this.getLineDash(),
          });
        }
        return stroke.apply(this, args);
      };
      ui.openEq();
      const canvas = document.querySelector("#eq-canvas");
      return {
        width: canvas.width,
        height: canvas.height,
        expectedWidth: Math.round(canvas.clientWidth * devicePixelRatio),
        expectedHeight: Math.round(canvas.clientHeight * devicePixelRatio),
        first: first.id,
        second: second.id,
        firstResponse: [...state.eqChain.bandCurve(first.id)],
        secondResponse: [...state.eqChain.bandCurve(second.id)],
        accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
        strokes: window.eqTestStrokes,
      };
    });
    assert.equal(initial.width, initial.expectedWidth);
    assert.equal(initial.height, initial.expectedHeight);
    assert.ok(initial.firstResponse.some((value) => value > 1));
    assert.ok(initial.secondResponse.some((value) => value < -1));
    const combined = initial.strokes.findIndex(
      (stroke) => stroke.width === 4 && stroke.colour === initial.accent && stroke.dash.length === 0,
    );
    const firstBand = initial.strokes.findIndex((stroke) => stroke.width === 1 && stroke.alpha === 0.55);
    assert.ok(combined >= 0 && firstBand > combined);
    assert.ok(initial.strokes.filter((stroke) => stroke.width === 1 && stroke.alpha === 0.55).length >= 2);
    assert.deepEqual(initial.strokes[firstBand].dash, []);
    assert.equal(await page.locator(".eq-legend").textContent(), "Combined response");
    assert.equal(await page.locator("#eq-side").getByText("Follows the output").count(), 0);

    await page.waitForTimeout(350);
    const canvas = page.locator("#eq-canvas");
    const settled = await canvas.evaluate((element) => ({
      width: element.width,
      height: element.height,
      expectedWidth: Math.round(element.clientWidth * devicePixelRatio),
      expectedHeight: Math.round(element.clientHeight * devicePixelRatio),
    }));
    assert.equal(settled.width, settled.expectedWidth);
    assert.equal(settled.height, settled.expectedHeight);
    const point = await canvas.evaluate(async (element) => {
      const state = await import("/src/lib/state.ts");
      const band = state.getState().settings.eqBands[0];
      const frequencies = state.eqChain.frequencies;
      const rect = element.getBoundingClientRect();
      const x = (Math.log(band.freq) - Math.log(frequencies[0])) /
        (Math.log(frequencies[frequencies.length - 1]) - Math.log(frequencies[0]));
      return { x: rect.left + rect.width * x, y: rect.top + rect.height * (18 - band.gain) / 36 };
    });
    await page.mouse.move(point.x, point.y);
    const row = page.locator(`[data-band-row="${initial.first}"]`);
    assert.equal(await row.evaluate((element) => element.classList.contains("is-hovered")), true);
    assert.equal(await page.locator(`[data-band-row="${initial.second}"]`).evaluate(
      (element) => element.classList.contains("is-hovered"),
    ), false);
    await page.mouse.move(2, 2);
    assert.equal(await row.evaluate((element) => element.classList.contains("is-hovered")), false);

    await page.evaluate(() => { window.eqTestStrokes = []; });
    await row.hover();
    const strokes = await page.evaluate(() => window.eqTestStrokes);
    assert.ok(strokes.some((stroke) => stroke.width === 1.5));
  } finally {
    await context.close();
  }
});

async function check(page, selector) {
  await page.locator(selector).waitFor({ state: "visible" });
  assert.deepEqual(await overflow(page, selector), [], `Horizontal scrolling in ${selector}`);
}

async function invoke(page, module, method, ...args) {
  await page.evaluate(async ({ module, method, args }) => {
    const exports = await import(`/src/ui/${module}.ts`);
    exports[method](...args);
  }, { module, method, args });
}

async function firstTrack(page) {
  return page.evaluate(async () => (await import("/src/lib/state.ts")).getState().tracks[0].id);
}

test("song editor playback continues while seeking and dragging lyrics", async () => {
  const { context, page } = await openApp(viewports[0]);
  try {
    await page.evaluate(() => {
      window.__WAVE_SIM__.setLyricsAvailable(true);
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (command, ...args) => command === "editor_waveform"
        ? Promise.resolve(Array(1000).fill(0.5)) : invoke(command, ...args);
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        window.__editorPreview = this;
        return play.call(this);
      };
    });
    await invoke(page, "song-editor", "openSongEditor", await firstTrack(page));
    await page.locator("#song-editor-play").click();
    await page.waitForFunction(() => window.__editorPreview?.currentTime > 0.1 && !window.__editorPreview.paused);
    await page.locator("#song-editor-ruler").click({ position: { x: 80, y: 8 } });
    await page.waitForFunction(() => window.__editorPreview.currentTime > 2 && !window.__editorPreview.seeking);
    const afterSeek = await page.evaluate(() => window.__editorPreview.currentTime);
    await page.waitForFunction((time) => window.__editorPreview.currentTime > time + 0.1, afterSeek);

    const chip = await page.locator("#song-editor-lyric-track [data-chip]").first().boundingBox();
    assert.ok(chip);
    await page.mouse.move(chip.x + 10, chip.y + chip.height / 2);
    await page.mouse.down();
    await page.mouse.move(chip.x + 50, chip.y + chip.height / 2, { steps: 20 });
    await page.mouse.up();
    const afterDrag = await page.evaluate(() => window.__editorPreview.currentTime);
    await page.waitForFunction((time) => !window.__editorPreview.paused
      && window.__editorPreview.currentTime > time + 0.1, afterDrag);
    const alignment = await page.evaluate(() => {
      const audio = window.__editorPreview;
      const inner = document.querySelector("#song-editor-timeline-inner");
      const playhead = document.querySelector("#song-editor-playhead");
      return Math.abs(playhead.getBoundingClientRect().left - inner.getBoundingClientRect().left
        - audio.currentTime / audio.duration * inner.clientWidth);
    });
    assert.ok(alignment < 3);

    await page.locator("#song-editor-play").click();
    assert.equal(await page.evaluate(() => window.__editorPreview.paused), true);
    await page.locator("#song-editor-ruler").click({ position: { x: 150, y: 8 } });
    await page.locator("#song-editor-play").click();
    const resumedAt = await page.evaluate(() => window.__editorPreview.currentTime);
    await page.waitForFunction((time) => !window.__editorPreview.paused
      && window.__editorPreview.currentTime > time + 0.1, resumedAt);
  } finally {
    await context.close();
  }
});

async function openPanel(page, button, dialog, toggle) {
  await page.locator(button).click();
  await page.waitForFunction(({ dialog, toggle }) =>
    document.querySelector(dialog).open || document.querySelector(toggle).classList.contains("is-open"),
  { dialog, toggle });
  return await page.locator(dialog).evaluate((element) => element.open) ? dialog : toggle;
}

async function scrollTo(page, selector) {
  await page.waitForFunction((target) => {
    const element = document.querySelector(target);
    if (!element) return false;
    element.scrollIntoView({ block: "nearest" });
    return true;
  }, selector);
  await page.waitForTimeout(150);
}

const cases = [
  {
    name: "main view",
    run: (page) => check(page, "#stage"),
  },
  {
    name: "queue",
    unavailableInCompact: true,
    async run(page) {
      await page.evaluate(async () => (await import("/src/lib/state.ts")).toggleQueue(true));
      await page.locator("#carousel .card.is-current").waitFor({ state: "visible" });
      await check(page, "#stage");
    },
  },
  {
    name: "lyrics",
    unavailableInCompact: true,
    async run(page, viewport) {
      await page.evaluate(() => window.__WAVE_SIM__.setLyricsAvailable(true));
      try {
        await page.reload();
        await page.locator("#lyrics-panel:not([hidden])").waitFor();
        if (viewport.device !== "desktop") {
          await page.locator("#dock-grab").click();
          await page.waitForFunction(() => document.querySelector("#dock-grab").getAttribute("aria-expanded") === "true");
        }
        await check(page, "#lyrics-panel");
      } finally {
        await page.evaluate(() => window.__WAVE_SIM__.setLyricsAvailable(false));
      }
    },
  },
  {
    name: "library and collection",
    unavailableInCompact: true,
    async run(page) {
      await page.locator("#library-open").click();
      await check(page, "#sheet");
      await page.locator("#library-rows [data-collection]").first().click();
      await check(page, "#sheet");
    },
  },
  {
    name: "search and results",
    async run(page) {
      await page.locator("#search-open").click();
      await page.locator("#search").fill("Neon");
      await page.locator("#results-list").waitFor({ state: "visible" });
      await check(page, "#search-modal");
    },
  },
  {
    name: "theme panel or compact menu",
    async run(page) {
      await check(page, await openPanel(page, "#theme-toggle-face", "#theme-dialog", "#theme-toggle"));
    },
  },
  {
    name: "settings panel or compact menu",
    async run(page, viewport) {
      const panel = await openPanel(page, "#settings-open", "#settings-dialog", "#settings-toggle");
      await check(page, panel);
      if (panel === "#settings-dialog") {
        const exportField = page.locator("[data-export-collection]");
        await scrollTo(page, "[data-export-collection]");
        await exportField.focus();
        await check(page, "#settings-body .import-picker");
        const slot = page.locator("[data-slot-open]").first();
        if (viewport.device !== "android") {
          await scrollTo(page, "[data-slot-open]");
          await slot.click();
          await check(page, "#settings-body .slot-picker");
        }
      }
    },
  },
  {
    name: "import panel or compact menu",
    async run(page, viewport) {
      const panel = await openPanel(page, "#import-open", "#import-dialog", "#import-toggle");
      await check(page, panel);
      if (panel === "#import-dialog" && viewport.device !== "android") {
        const hint = page.locator("#import-log-hint");
        await hint.waitFor();
        await page.waitForFunction((path) => document.querySelector("#import-log-hint")?.textContent.includes(path), logPaths[0]);
        for (const path of logPaths) {
          await hint.evaluate((element, value) => { element.textContent = `Log: ${value}`; }, path);
          assert.equal(await hint.evaluate((element) => element.textContent), `Log: ${path}`);
          await check(page, "#import-dialog");
        }
        await hint.evaluate((element) => { element.style.overflowWrap = "normal"; });
        assert.ok((await overflow(page, "#import-dialog")).some((entry) => entry.element === "#import-body"));
        await hint.evaluate((element) => { element.style.removeProperty("overflow-wrap"); });
        await check(page, "#import-dialog");
      }
      if (panel === "#import-dialog") {
        const combo = page.locator("[data-combo]").first();
        await scrollTo(page, "[data-combo]");
        await combo.focus();
        await check(page, "#import-body .import-picker");
      }
    },
  },
  {
    name: "equaliser and picker",
    async run(page, viewport) {
      await invoke(page, "eq", "openEq");
      await check(page, "#eq-panel");
      const drop = page.locator(viewport.device === "desktop" ? ".eq-band-shape" : "#eq-side .eq-drop").first();
      assert.ok(await drop.count(), "The equaliser picker trigger is missing");
      await drop.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      await drop.click();
      await check(page, ".eq-picker");
    },
  },
  {
    name: "update",
    async run(page) {
      await invoke(page, "update", "openUpdate");
      await check(page, "#update-dialog");
      await page.evaluate(async () => {
        window.__WAVE_SIM__.setUpdateAvailable(true);
        await (await import("/src/lib/state.ts")).checkForUpdates();
      });
      await page.waitForFunction(() => document.querySelector("#update-body").textContent.includes("0.3.0"));
      await check(page, "#update-dialog");
    },
  },
  {
    name: "confirmation",
    async run(page) {
      await invoke(page, "confirm", "confirmDialog", {
        title: "Import this folder",
        message: "Add only the songs to your library, or also create a playlist from this folder?",
        confirmLabel: "As a playlist",
        cancelLabel: "Songs only",
      });
      await check(page, "#confirm-dialog");
    },
  },
  {
    name: "seek",
    async run(page) {
      await invoke(page, "seek-time", "openSeekTime");
      await check(page, "#seek-dialog");
    },
  },
  {
    name: "track editor",
    async run(page) {
      await invoke(page, "track-editor", "openTrackEditor", await firstTrack(page));
      await check(page, "#track-editor-dialog");
    },
  },
  {
    name: "add to playlist",
    async run(page) {
      const id = await firstTrack(page);
      await page.evaluate(async (trackId) => {
        const { openAddToPlaylist } = await import("/src/ui/add-to-playlist.ts");
        openAddToPlaylist(document.querySelector("#search-open"), [trackId]);
      }, id);
      await check(page, ".add-to");
      await page.locator(".add-to-new-button").click();
      await check(page, ".add-to");
    },
  },
  {
    name: "context menu",
    unavailableInCompact: true,
    async run(page) {
      await page.locator("#library-open").click();
      await page.locator("#sheet-sort").click();
      await check(page, ".menu");
    },
  },
  {
    name: "Wave Swell",
    async run(page) {
      await invoke(page, "library", "openSwell");
      await check(page, "#sheet");
    },
  },
  {
    name: "song editor",
    desktopOnly: true,
    async run(page) {
      await invoke(page, "song-editor", "openSongEditor", await firstTrack(page));
      await check(page, "#song-editor-modal");
    },
  },
  {
    name: "mini player and seek",
    desktopOnly: true,
    async run(page, viewport) {
      await page.setViewportSize({ width: 400, height: 160 });
      try {
        await page.evaluate(async () => (await import("/src/lib/state.ts")).toggleMiniPlayer());
        await page.locator("html.is-mini-player").waitFor();
        await check(page, "#stage");
        await invoke(page, "seek-time", "openSeekTime");
        await check(page, "#seek-dialog");
      } finally {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
      }
    },
  },
];

for (const viewport of viewports) {
  test(viewport.name, async (t) => {
    const { context, page } = await openApp(viewport);
    try {
      for (const entry of cases) {
        if (entry.desktopOnly && viewport.device !== "desktop") continue;
        if (entry.unavailableInCompact && viewport.name === "desktop compact") continue;
        await t.test(entry.name, async () => {
          await page.reload();
          await page.waitForFunction(async () => {
            const { getState } = await import("/src/lib/state.ts");
            return getState().ready && !document.documentElement.classList.contains("is-starting");
          });
          await entry.run(page, viewport);
        });
      }
    } finally {
      await context.close();
    }
  });
}
