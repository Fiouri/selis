/**
 * Geometry for the annotation tools, on the main thread: text-markup selection
 * from glyphs, ink stroke simplification, and eraser hit testing. Everything is
 * in page points, top-left origin, unrotated page.
 */
import type { PageRect } from "./geometry";
import type { Annotation, Glyph, Point } from "./types";

/** A glyph farther than this from the finger is not picked. */
const PICK_DISTANCE = 24;

function distanceToRect(p: Point, r: PageRect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

/**
 * The glyph under (or nearest to) `p`, or -1. Vertical distance counts double,
 * so a point between two lines picks the line it is closer to, not a glyph
 * that happens to be horizontally aligned.
 */
export function glyphAt(glyphs: readonly Glyph[], p: Point, maxDistance = PICK_DISTANCE): number {
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i] as Glyph;
    if (g.width <= 0 || g.height <= 0) continue;
    const dx = Math.max(g.x - p.x, 0, p.x - (g.x + g.width));
    const dy = Math.max(g.y - p.y, 0, p.y - (g.y + g.height));
    if (Math.hypot(dx, dy) > maxDistance) continue;
    const score = dx + 2 * dy;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function sameLine(a: PageRect, b: PageRect): boolean {
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlap > 0.5 * Math.min(a.height, b.height);
}

/**
 * One rect per line for the glyphs from index `from` to `to` (either order),
 * like a text editor selection. Leading and trailing spaces of a line are left
 * out so a highlight hugs the words.
 */
export function selectionRects(glyphs: readonly Glyph[], from: number, to: number): PageRect[] {
  if (from < 0 || to < 0 || glyphs.length === 0) return [];
  const first = Math.min(from, to);
  const last = Math.min(Math.max(from, to), glyphs.length - 1);
  const lines: { rect: PageRect; run: number }[] = [];
  for (let i = first; i <= last; i++) {
    const g = glyphs[i] as Glyph;
    if (g.width <= 0 || g.height <= 0 || g.space) continue;
    const line = lines[lines.length - 1];
    if (line && (line.run === g.run || sameLine(line.rect, g)) && g.x >= line.rect.x - g.width) {
      const x0 = Math.min(line.rect.x, g.x);
      const y0 = Math.min(line.rect.y, g.y);
      const x1 = Math.max(line.rect.x + line.rect.width, g.x + g.width);
      const y1 = Math.max(line.rect.y + line.rect.height, g.y + g.height);
      line.rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
      line.run = g.run;
    } else {
      lines.push({ rect: { x: g.x, y: g.y, width: g.width, height: g.height }, run: g.run });
    }
  }
  return lines.map((l) => l.rect);
}

/** Bounding box of rects, or null when there are none. */
export function unionRect(rects: readonly PageRect[]): PageRect | null {
  if (rects.length === 0) return null;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Ramer–Douglas–Peucker: drops points that deviate less than `tolerance` from
 * the line through their neighbours. Keeps the first and last point.
 */
export function simplifyStroke(points: readonly Point[], tolerance = 0.35): Point[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop() as [number, number];
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = start + 1; i < end; i++) {
      const d = distanceToSegment(points[i] as Point, points[start] as Point, points[end] as Point);
      if (d > worstDistance) {
        worstDistance = d;
        worst = i;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([start, worst], [worst, end]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/** Bounding box of strokes, grown by half the stroke width. */
export function strokesBounds(strokes: readonly (readonly Point[])[], width: number): PageRect | null {
  const pad = width / 2;
  const rects = strokes.flatMap((s) => s.map((p) => ({ x: p.x - pad, y: p.y - pad, width: 2 * pad, height: 2 * pad })));
  return unionRect(rects);
}

function hits(a: Annotation, p: Point, tolerance: number): boolean {
  switch (a.kind) {
    case "highlight":
    case "underline":
    case "strikeout":
    case "redact":
      return a.segments.some((r) => distanceToRect(p, r) <= tolerance);
    case "ink":
      return a.strokes.some((stroke) => {
        if (stroke.length === 1) return Math.hypot(p.x - (stroke[0] as Point).x, p.y - (stroke[0] as Point).y) <= tolerance + a.width / 2;
        for (let i = 1; i < stroke.length; i++) {
          if (distanceToSegment(p, stroke[i - 1] as Point, stroke[i] as Point) <= tolerance + a.width / 2) return true;
        }
        return false;
      });
    case "line":
    case "arrow":
      return distanceToSegment(p, a.start, a.end) <= tolerance + a.width / 2;
    case "square": {
      const r = a.rect;
      if (a.fill !== null) return distanceToRect(p, r) <= tolerance;
      const inside = p.x > r.x + tolerance && p.x < r.x + r.width - tolerance && p.y > r.y + tolerance && p.y < r.y + r.height - tolerance;
      return distanceToRect(p, r) <= tolerance && !inside;
    }
    case "circle": {
      const r = a.rect;
      const rx = r.width / 2;
      const ry = r.height / 2;
      if (rx <= 0 || ry <= 0) return false;
      const nx = (p.x - (r.x + rx)) / rx;
      const ny = (p.y - (r.y + ry)) / ry;
      const radial = Math.hypot(nx, ny);
      if (a.fill !== null) return radial <= 1 + tolerance / Math.min(rx, ry);
      return Math.abs(radial - 1) * Math.min(rx, ry) <= tolerance;
    }
    case "text":
    case "note":
    case "signature":
      return distanceToRect(p, a.rect) <= tolerance;
    case "other":
      return false;
  }
}

/** Topmost editable annotation under `p` (the eraser), or null. */
export function annotationAt(annotations: readonly Annotation[], p: Point, tolerance = 8): Annotation | null {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i] as Annotation;
    if (hits(a, p, tolerance)) return a;
  }
  return null;
}
