/**
 * Page geometry for view rotation (not saved into the PDF) and night mode.
 * Rects are in PDF points, top-left origin (as EmbedPDF reports text and search
 * rects), unless stated otherwise.
 */
import type { PageSize } from "./types";

/** Quarter turns clockwise: 0, 90°, 180°, 270°. */
export type QuarterTurns = 0 | 1 | 2 | 3;

export type PageRect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

export function rotateSize(size: PageSize, turns: QuarterTurns): PageSize {
  return turns % 2 === 0 ? size : { width: size.height, height: size.width };
}

/** A rect on the unrotated page, expressed on the page turned clockwise by `turns`. */
export function rotateRect(rect: PageRect, page: PageSize, turns: QuarterTurns): PageRect {
  const { x, y, width: w, height: h } = rect;
  switch (turns) {
    case 0:
      return rect;
    case 1:
      return { x: page.height - y - h, y: x, width: h, height: w };
    case 2:
      return { x: page.width - x - w, y: page.height - y - h, width: w, height: h };
    case 3:
      return { x: y, y: page.width - x - w, width: h, height: w };
  }
}

/** PDF user-space bounds (bottom-left origin) → top-left page rect. */
export function fromPdfBounds(left: number, bottom: number, right: number, top: number, page: PageSize): PageRect {
  return { x: left, y: page.height - top, width: right - left, height: top - bottom };
}

/** Next clockwise quarter turn. */
export function nextTurn(turns: QuarterTurns): QuarterTurns {
  return ((turns + 1) % 4) as QuarterTurns;
}

/**
 * Night mode in place on RGBA pixels: invert lightness while keeping hues
 * (invert + 180° hue rotation, as CSS `invert(1) hue-rotate(180deg)`), mapped
 * into a soft range so white paper becomes warm near-black, not pure black.
 * Pixels inside `keep` (device-pixel rects, e.g. images) stay untouched.
 */
export function applyNightMode(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  keep: readonly PageRect[] = [],
): void {
  const LOW = 22;
  const HIGH = 226;
  const span = (HIGH - LOW) / 255;
  const boxes = keep.map((r) => ({
    x0: Math.max(0, Math.floor(r.x)),
    y0: Math.max(0, Math.floor(r.y)),
    x1: Math.min(width, Math.ceil(r.x + r.width)),
    y1: Math.min(height, Math.ceil(r.y + r.height)),
  }));
  for (let y = 0; y < height; y++) {
    const row = boxes.filter((b) => y >= b.y0 && y < b.y1);
    for (let x = 0; x < width; x++) {
      if (row.length > 0 && row.some((b) => x >= b.x0 && x < b.x1)) continue;
      const i = (y * width + x) * 4;
      const r = 255 - (data[i] as number);
      const g = 255 - (data[i + 1] as number);
      const b = 255 - (data[i + 2] as number);
      // hue-rotate(180deg) matrix (W3C filter effects).
      const r2 = -0.574 * r + 1.43 * g + 0.144 * b;
      const g2 = 0.426 * r + 0.43 * g + 0.144 * b;
      const b2 = 0.426 * r + 1.43 * g - 0.856 * b;
      data[i] = LOW + r2 * span;
      data[i + 1] = LOW + g2 * span;
      data[i + 2] = LOW + b2 * span;
    }
  }
}
