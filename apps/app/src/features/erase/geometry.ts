/**
 * Geometry of the Erase tool (ADR 0033), in page points, top-left origin: the
 * squares a brush stroke covers (exactly what will be erased, so the preview
 * is the truth) and which page objects lie under a finger.
 */
import type { PageObjectInfo, PageRect, Point } from "@selis/engine";

/** Brush sizes, in screen pixels (the same on screen at any zoom). */
export const BRUSH_PX = { s: 12, m: 24, l: 44 } as const;
export type BrushSize = keyof typeof BRUSH_PX;

/** Squares of side `size` centred along the polyline, close enough to leave no gaps. */
export function brushRects(points: readonly Point[], size: number, page: { width: number; height: number }): PageRect[] {
  if (points.length === 0 || size <= 0) return [];
  const step = size / 3;
  const centres: Point[] = [points[0] as Point];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 1; k <= n; k++) centres.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  // Snap to a grid of a third of the size: overlapping squares on the same spot become one.
  const seen = new Set<string>();
  const out: PageRect[] = [];
  for (const c of centres) {
    const gx = Math.round(c.x / step) * step;
    const gy = Math.round(c.y / step) * step;
    const key = `${gx.toFixed(3)}:${gy.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rect = clipRect({ x: gx - size / 2, y: gy - size / 2, width: size, height: size }, page);
    if (rect) out.push(rect);
  }
  return out;
}

/** The rect within the page, or null if nothing of it is left. */
export function clipRect(r: PageRect, page: { width: number; height: number }): PageRect | null {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(page.width, r.x + r.width);
  const y1 = Math.min(page.height, r.y + r.height);
  return x1 - x0 > 0 && y1 - y0 > 0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** The rectangle between two points. */
export function boxOf(a: Point, b: Point): PageRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

function distance(p: Point, r: PageRect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

/**
 * The objects whose bounds (grown by `tolerance`) hold `p`: first those right
 * under the finger, topmost first, then those merely near it, nearest first.
 * The first is what a tap picks; a long press steps through the rest.
 */
export function objectsAt(objects: readonly PageObjectInfo[], p: Point, tolerance: number): PageObjectInfo[] {
  return objects
    .map((o) => ({ o, d: distance(p, o.rect) }))
    .filter(({ d }) => d <= tolerance)
    .sort((a, b) => (a.d === 0 && b.d === 0 ? b.o.index - a.o.index : a.d - b.d || b.o.index - a.o.index))
    .map(({ o }) => o);
}

/** One SVG path for a set of rects (each a closed square). */
export function rectsPath(rects: readonly PageRect[], scale: number): string {
  return rects.map((r) => `M${r.x * scale} ${r.y * scale}h${r.width * scale}v${r.height * scale}h${-r.width * scale}Z`).join("");
}
