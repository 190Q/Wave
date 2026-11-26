import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
});
after(() => vite.close());

class Element {
  constructor(scroller) {
    this.scroller = scroller;
    this.children = [];
    this.scrollTop = 0;
    this.clientHeight = 200;
  }

  addEventListener() {}
  removeEventListener() {}
  getBoundingClientRect() {
    return { top: this.scroller ? -this.scroller.scrollTop : 0 };
  }

  get firstElementChild() {
    return this.children[0] ?? null;
  }

  set innerHTML(html) {
    this.html = html;
    let top = 0;
    this.children = [...html.matchAll(/<div (?:class="window-gap" style="height:(\d+)px"|data-row="(\d+)")><\/div>/g)]
      .map((match) => {
        const height = match[1] === undefined ? 40 : Number(match[1]);
        const child = new Element(this.scroller);
        child.offsetTop = top;
        child.offsetHeight = height;
        top += height;
        return child;
      });
  }

  get innerHTML() {
    return this.html ?? "";
  }
}

globalThis.HTMLElement = Element;

const { WindowedList } = await vite.ssrLoadModule("/src/ui/windowed.ts");
const row = (index) => `<div data-row="${index}"></div>`;
const rows = (host) => [...host.innerHTML.matchAll(/data-row="(\d+)"/g)].map((match) => Number(match[1]));

for (const overscan of [0, 6]) {
  for (const count of [2, 20]) {
    test(`shrinking a scrolled list to ${count} rows with ${overscan} buffered rows`, () => {
      const scroller = new Element();
      const host = new Element(scroller);
      const list = new WindowedList({ scroller, host, rowHeight: 40, spacerTag: "div", overscan });
      list.set(100, row);
      scroller.scrollTop = 3600;
      list.set(count, row);

      assert.ok(rows(host).length > 0);
      assert.equal(rows(host).at(-1), count - 1);
      assert.match(host.innerHTML, new RegExp(`height:${Math.max(0, count - 5 - overscan * 2) * 40}px`));
    });
  }
}

test("a valid scroll position still draws the rows in the viewport", () => {
  const scroller = new Element();
  const host = new Element(scroller);
  const list = new WindowedList({ scroller, host, rowHeight: 40, spacerTag: "div", overscan: 0 });
  list.set(100, row);
  scroller.scrollTop = 800;
  list.refresh();

  assert.deepEqual(rows(host), [20, 21, 22, 23, 24]);
});

test("refreshing a cleared window leaves non-windowed content intact", () => {
  const scroller = new Element();
  const host = new Element(scroller);
  const list = new WindowedList({ scroller, host, rowHeight: 40, spacerTag: "div" });
  list.set(10, row);
  list.clear();
  host.innerHTML = row(42);

  list.refresh();

  assert.equal(host.innerHTML, row(42));
});
