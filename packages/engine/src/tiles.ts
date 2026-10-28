import { clampScale } from "./protocol";
import type { PageSize } from "./types";

/**
 * Sharp pages at every zoom (ADR 0002 amendment): a page is drawn at CSS size ×
 * devicePixelRatio, snapped to whole device pixels. When that bitmap would be too
 * large for the memory tier (or for a quick re-render), a low-resolution base
 * covers the page and full-resolution tiles cover what is on screen.
 */

/**
 * Tile edge in device pixels. Small enough that the grid hugs the screen (512 px tiles
 * rendered up to 2.4 viewports of pixels after a zoom, depending on how the grid fell),
 * large enough that per-tile overhead stays small.
 */
export const TILE_SIZE = 256;

/** A full-resolution page bitmap may hold this many viewports of pixels before it is tiled. */
export const SINGLE_BITMAP_VIEWPORTS = 2;

/** A CSS length snapped to whole device pixels. */
export function snapToDevice(css: number, dpr: number): number {
  return dpr > 0 ? Math.round(css * dpr) / dpr : css;
}

export type RenderPlan = {
  /** Device pixels per page point at full resolution. */
  readonly scale: number;
  /** The page box in device pixels at full resolution. */
  readonly deviceWidth: number;
  readonly deviceHeight: number;
  /** Full resolution is drawn in tiles of the visible area, over a base at `baseScale`. */
  readonly tiled: boolean;
  /** Scale of the bitmap that covers the whole page (`scale` unless tiled). */
  readonly baseScale: number;
};

/**
 * How to draw a page box `cssWidth` CSS px wide (`page` as shown, after rotation).
 * `maxPixels` is the tier's per-bitmap cap; `viewportPixels` the scroller's area in
 * device pixels (0 when unknown).
 */
export function renderPlan(page: PageSize, cssWidth: number, dpr: number, maxPixels: number, viewportPixels: number): RenderPlan {
  const deviceWidth = Math.round(cssWidth * dpr);
  if (page.width <= 0 || page.height <= 0 || deviceWidth <= 0) {
    return { scale: 0, deviceWidth: 0, deviceHeight: 0, tiled: false, baseScale: 0 };
  }
  const scale = deviceWidth / page.width;
  const deviceHeight = Math.round(page.height * scale);
  const budget = viewportPixels > 0 ? Math.min(maxPixels, SINGLE_BITMAP_VIEWPORTS * viewportPixels) : maxPixels;
  if (deviceWidth * deviceHeight <= budget) return { scale, deviceWidth, deviceHeight, tiled: false, baseScale: scale };
  // The base only shows until the tiles land, and around them while panning: half a
  // viewport of pixels is about the fit-width resolution and renders fast.
  const basePixels = viewportPixels > 0 ? Math.min(maxPixels, viewportPixels / 2) : maxPixels / 4;
  return { scale, deviceWidth, deviceHeight, tiled: true, baseScale: clampScale(page, scale, basePixels) };
}

/** A rect in device pixels on a page box (top-left origin). */
export type DeviceRect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

export type Tile = DeviceRect & { readonly key: string };

/**
 * Grid tiles of a `deviceWidth` × `deviceHeight` page that intersect `view` grown by
 * `margin` pixels, nearest to the view's centre first. Edge tiles are cut to the page.
 */
export function visibleTiles(
  deviceWidth: number,
  deviceHeight: number,
  view: DeviceRect,
  margin = 0,
  size = TILE_SIZE,
): Tile[] {
  const x0 = Math.max(0, Math.floor(view.x - margin));
  const y0 = Math.max(0, Math.floor(view.y - margin));
  const x1 = Math.min(deviceWidth, Math.ceil(view.x + view.width + margin));
  const y1 = Math.min(deviceHeight, Math.ceil(view.y + view.height + margin));
  if (x1 <= x0 || y1 <= y0 || size <= 0) return [];
  const cx = view.x + view.width / 2;
  const cy = view.y + view.height / 2;
  const tiles: Array<Tile & { distance: number }> = [];
  for (let row = Math.floor(y0 / size); row * size < y1; row++) {
    for (let col = Math.floor(x0 / size); col * size < x1; col++) {
      const x = col * size;
      const y = row * size;
      const width = Math.min(size, deviceWidth - x);
      const height = Math.min(size, deviceHeight - y);
      const distance = Math.hypot(x + width / 2 - cx, y + height / 2 - cy);
      tiles.push({ key: `${String(col)},${String(row)}`, x, y, width, height, distance });
    }
  }
  tiles.sort((a, b) => a.distance - b.distance);
  return tiles.map(({ key, x, y, width, height }) => ({ key, x, y, width, height }));
}
