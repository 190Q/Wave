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
