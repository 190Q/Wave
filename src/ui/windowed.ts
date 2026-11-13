/** How many rows beyond the viewport are kept drawn. */
const DEFAULT_OVERSCAN = 6;

export interface WindowOptions {
  /** The element that scrolls, which the window is worked out from. */
  scroller: HTMLElement;
  /** The element the rows are drawn into. */
  host: HTMLElement;
  /** The height one row starts at, before one has been measured. */
  rowHeight: number;
  /** The tag the spacer is written as, which has to suit the host. */
  spacerTag: "li" | "div";
  /** Called after a draw, so the rows can be finished off. */
  onDraw?: (host: HTMLElement) => void;
  overscan?: number;
}

/**
 * A list that only keeps the rows near the viewport in the DOM. A spacer above
 * and below the window stands in for the rows that are not drawn, so the
 * scrollbar keeps the height the whole list would have.
 */
export class WindowedList {
  private readonly scroller: HTMLElement;
  private readonly host: HTMLElement;
  private readonly spacerTag: "li" | "div";
  private readonly onDraw: ((host: HTMLElement) => void) | undefined;
  private readonly overscan: number;

  /** The height one row takes, which is measured once one has been drawn. */
  private rowHeight: number;

  private count = 0;
  private renderRow: ((index: number) => string) | null = null;
  private start = -1;
  private end = -1;
  private frame: number | null = null;

  private readonly onScroll = (): void => {
    if (this.frame !== null) {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.paint();
    });
  };

  constructor(options: WindowOptions) {
    this.scroller = options.scroller;
    this.host = options.host;
    this.rowHeight = options.rowHeight;
    this.spacerTag = options.spacerTag;
    this.onDraw = options.onDraw;
    this.overscan = options.overscan ?? DEFAULT_OVERSCAN;
    this.scroller.addEventListener("scroll", this.onScroll, { passive: true });
  }

  /** How far apart two rows sit. */
  get pitch(): number {
    return this.rowHeight;
  }

  /** Sets the rows to draw, and how to draw each one. */
  set(count: number, renderRow: (index: number) => string): void {
    this.count = count;
    this.renderRow = renderRow;
    this.start = -1;
    this.end = -1;
    this.paint(true);
  }

  /** Redraws the window as it stands, for a change to the rows themselves. */
  refresh(): void {
    this.start = -1;
    this.end = -1;
    this.paint(true);
  }

  /** Lets the list go, leaving the host empty. */
  clear(): void {
    this.count = 0;
    this.renderRow = null;
    this.start = -1;
    this.end = -1;
    this.host.innerHTML = "";
  }

  /** Brings a row into view, drawing it if it is not already there. */
  scrollToIndex(index: number): void {
    if (this.count === 0) {
      return;
    }

    const rowTop = this.offset() + index * this.rowHeight;
    const rowBottom = rowTop + this.rowHeight;
    const viewTop = this.scroller.scrollTop;
    const viewBottom = viewTop + this.scroller.clientHeight;

    if (rowTop < viewTop) {
      this.scroller.scrollTop = Math.max(0, rowTop);
    } else if (rowBottom > viewBottom) {
      this.scroller.scrollTop = rowBottom - this.scroller.clientHeight;
    }
    this.paint(true);
  }

  destroy(): void {
    this.scroller.removeEventListener("scroll", this.onScroll);
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }

  /** Where the list starts, in the scroller's own scroll coordinates. */
  private offset(): number {
    const scroller = this.scroller.getBoundingClientRect();
    // A host that lays out nothing of its own has no box to measure, so its
    // first row stands in for it.
    const anchor =
      this.host.firstElementChild instanceof HTMLElement ? this.host.firstElementChild : this.host;
    return anchor.getBoundingClientRect().top - scroller.top + this.scroller.scrollTop;
  }

  /** Reads the spacing off two drawn rows, so a change of font size is picked up. */
  private measure(): void {
    const children = this.host.children;
    const first = children[1] as HTMLElement | undefined;
    if (!first) {
      return;
    }

    const second = children[2] as HTMLElement | undefined;
    const pitch = second ? second.offsetTop - first.offsetTop : first.offsetHeight;
    if (pitch > 0) {
      this.rowHeight = pitch;
    }
  }

  private draw(first: number, last: number): void {
    const render = this.renderRow;
    if (render === null) {
      return;
    }

    const height = this.rowHeight;
    const above = Math.max(0, first * height);
    const below = Math.max(0, (this.count - last) * height);
    const tag = this.spacerTag;

    const parts: string[] = [`<${tag} class="window-gap" style="height:${above}px"></${tag}>`];
    for (let index = first; index < last; index += 1) {
      parts.push(render(index));
    }
    parts.push(`<${tag} class="window-gap" style="height:${below}px"></${tag}>`);

    this.host.innerHTML = parts.join("");
    this.onDraw?.(this.host);
  }

  private paint(force = false): void {
    if (this.renderRow === null || this.count === 0) {
      if (force) {
        this.host.innerHTML = "";
      }
      return;
    }

    let redraw = force;

    // Twice at most: the second pass is for a first draw that had to guess
    // where the list starts, which is only knowable once something is drawn.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const offset = this.offset();
      const height = this.rowHeight;
      const top = Math.max(0, this.scroller.scrollTop - offset);
      const first = Math.max(0, Math.floor(top / height) - this.overscan);
      const visible = Math.ceil(this.scroller.clientHeight / height) + this.overscan * 2;
      const last = Math.min(this.count, first + Math.max(visible, 1));

      if (!redraw && first === this.start && last === this.end) {
        return;
      }

      this.start = first;
      this.end = last;
      this.draw(first, last);
      this.measure();

      if (Math.abs(this.offset() - offset) <= 0.5) {
        return;
      }
      redraw = true;
    }
  }
}
