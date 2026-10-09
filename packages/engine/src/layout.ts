import type { PageSize } from "./types";

/**
 * Vertical page layout for a virtualized scroller. Pure and engine-agnostic so
 * it can be unit tested and reused by every shell.
 */
export type PageLayout = {
  /** Top offset (CSS px) of each page box. */
  readonly tops: Float64Array;
  /** Height (CSS px) of each page box. */
  readonly heights: Float64Array;
  /** Width (CSS px) of each page box. */
  readonly widths: Float64Array;
  readonly totalHeight: number;
  readonly maxWidth: number;
};

/**
 * Lays pages out top to bottom. Pages are fitted so the widest page spans
 * `fitWidth` at zoom 1; other pages keep their size relative to it.
 */
export function layoutPages(pages: readonly PageSize[], fitWidth: number, zoom: number, gap: number): PageLayout {
  const n = pages.length;
  const tops = new Float64Array(n);
  const heights = new Float64Array(n);
  const widths = new Float64Array(n);
  let widest = 0;
  for (const p of pages) widest = Math.max(widest, p.width);
  const ptToPx = widest > 0 ? (fitWidth / widest) * zoom : 0;
  let y = gap;
  let maxWidth = 0;
  for (let i = 0; i < n; i++) {
    const p = pages[i] as PageSize;
    const w = p.width * ptToPx;
    const h = p.height * ptToPx;
    tops[i] = y;
    heights[i] = h;
    widths[i] = w;
    maxWidth = Math.max(maxWidth, w);
    y += h + gap;
  }
  return { tops, heights, widths, totalHeight: y, maxWidth };
}

/** First page whose box ends below `y` (binary search). */
export function pageAt(layout: PageLayout, y: number): number {
  const n = layout.tops.length;
  if (n === 0) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const bottom = (layout.tops[mid] as number) + (layout.heights[mid] as number);
    if (bottom < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type PageRange = { readonly first: number; readonly last: number };

/** Pages intersecting the viewport [scrollTop, scrollTop + viewportHeight]. */
export function visibleRange(layout: PageLayout, scrollTop: number, viewportHeight: number): PageRange | null {
  const n = layout.tops.length;
  if (n === 0 || viewportHeight <= 0) return null;
  const first = pageAt(layout, scrollTop);
  let last = first;
  const bottom = scrollTop + viewportHeight;
  while (last + 1 < n && (layout.tops[last + 1] as number) < bottom) last++;
  return { first, last };
}

/**
 * Pages that should hold a rendered bitmap: the visible ones plus `buffer`
 * pages on each side. Everything else must release its bitmap.
 */
export function renderWindow(range: PageRange | null, pageCount: number, buffer = 1): PageRange | null {
  if (!range || pageCount === 0) return null;
  return {
    first: Math.max(0, range.first - buffer),
    last: Math.min(pageCount - 1, range.last + buffer),
  };
}

/** Device pixels per PDF point for a page box of `cssWidth` px. */
export function renderScale(page: PageSize, cssWidth: number, devicePixelRatio: number): number {
  if (page.width <= 0) return 0;
  return (cssWidth * devicePixelRatio) / page.width;
}
