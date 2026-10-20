/**
 * Cutting vector paths out of an erase area (ADR 0033). PDFium's redaction
 * removes the text and image pixels under an area but leaves vector paths
 * whole (measured), so the erase cuts them here, geometrically: what is drawn
 * inside the area leaves the content stream, the rest keeps its exact curves.
 *
 * Everything is in one coordinate space (PDF page space, y up) and areas are
 * axis-aligned boxes; the caller maps paths there and back.
 *
 * - A stroke is split where it crosses a box edge and the pieces inside a box
 *   go. The boxes are shrunk by half the line width first, so the outside
 *   renders unchanged (a cut end's butt cap sits inside the area, where the
 *   erase fill paints over it).
 * - A fill keeps its parts in the complement of the boxes: that complement is
 *   cut into disjoint rectangular cells and each closed subpath is clipped to
 *   each cell (Sutherland–Hodgman, curves split at the cell edges). Clipping to
 *   a convex cell keeps the winding number of every point inside it, so the
 *   fill rule still holds, and all pieces go into one path, where the shared
 *   cell edges cancel out (no seams).
 */

export type Pt = { readonly x: number; readonly y: number };
export type Seg = { readonly kind: "line"; readonly to: Pt } | { readonly kind: "cubic"; readonly c1: Pt; readonly c2: Pt; readonly to: Pt };
export type Subpath = { readonly start: Pt; readonly segs: readonly Seg[]; readonly closed: boolean };
/** Axis-aligned box, x0 < x1, y0 < y1. */
export type Box = { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };

type Axis = "x" | "y";
type Piece = { readonly from: Pt; readonly seg: Seg };

const EPS = 1e-9;

const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function cubicAt(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * c1.x + c * c2.x + d * p3.x, y: a * p0.y + b * c1.y + c * c2.y + d * p3.y };
}

/** de Casteljau: the cubic from p0 split at t into two cubics. */
function splitCubic(p0: Pt, seg: Extract<Seg, { kind: "cubic" }>, t: number): [Extract<Seg, { kind: "cubic" }>, Extract<Seg, { kind: "cubic" }>] {
  const a = lerp(p0, seg.c1, t);
  const b = lerp(seg.c1, seg.c2, t);
  const c = lerp(seg.c2, seg.to, t);
  const d = lerp(a, b, t);
  const e = lerp(b, c, t);
  const m = lerp(d, e, t);
  return [
    { kind: "cubic", c1: a, c2: d, to: m },
    { kind: "cubic", c1: e, c2: c, to: seg.to },
  ];
}

/** Parameters in (0, 1) where one coordinate of a cubic equals `value`. */
function cubicCrossings(p0: number, p1: number, p2: number, p3: number, value: number): number[] {
  // B(t) - value as a polynomial a t³ + b t² + c t + d.
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 3 * p0 - 6 * p1 + 3 * p2;
  const c = -3 * p0 + 3 * p1;
  const d = p0 - value;
  const f = (t: number) => ((a * t + b) * t + c) * t + d;
  // Monotonic stretches between the derivative's roots, then bisection in each.
  const stops = [0, 1];
  const qa = 3 * a;
  const qb = 2 * b;
  if (Math.abs(qa) > EPS) {
    const disc = qb * qb - 4 * qa * c;
    if (disc >= 0) {
      const r = Math.sqrt(disc);
      for (const t of [(-qb - r) / (2 * qa), (-qb + r) / (2 * qa)]) if (t > 0 && t < 1) stops.push(t);
    }
  } else if (Math.abs(qb) > EPS) {
    const t = -c / qb;
    if (t > 0 && t < 1) stops.push(t);
  }
  stops.sort((x, y) => x - y);
  const roots: number[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    let lo = stops[i] as number;
    let hi = stops[i + 1] as number;
    let flo = f(lo);
    const fhi = f(hi);
    if (flo === 0 || fhi === 0 || flo > 0 === fhi > 0) continue;
    for (let k = 0; k < 64; k++) {
      const mid = (lo + hi) / 2;
      const fm = f(mid);
      if (fm > 0 === flo > 0) {
        lo = mid;
        flo = fm;
      } else hi = mid;
    }
    const t = (lo + hi) / 2;
    if (t > EPS && t < 1 - EPS) roots.push(t);
  }
  return roots;
}

/** Parameters in (0, 1) where the segment crosses `axis = value`. */
function crossings(from: Pt, seg: Seg, axis: Axis, value: number): number[] {
  const a = from[axis];
  const b = seg.to[axis];
  if (seg.kind === "line") {
    if ((a - value) * (b - value) >= 0) return [];
    const t = (value - a) / (b - a);
    return t > EPS && t < 1 - EPS ? [t] : [];
  }
  const lo = Math.min(a, b, seg.c1[axis], seg.c2[axis]);
  const hi = Math.max(a, b, seg.c1[axis], seg.c2[axis]);
  if (value <= lo || value >= hi) return [];
  return cubicCrossings(a, seg.c1[axis], seg.c2[axis], b, value);
}

/** Snaps a split point onto the cut line, so pieces on both sides meet exactly. */
function snap(p: Pt, cut: { axis: Axis; value: number } | undefined): Pt {
  if (!cut) return p;
  return cut.axis === "x" ? { x: cut.value, y: p.y } : { x: p.x, y: cut.value };
}

/** The segment from `from` cut at the given parameters (any order, may repeat). */
function cutSegment(from: Pt, seg: Seg, cuts: readonly { t: number; axis: Axis; value: number }[]): Piece[] {
  const sorted = [...cuts].sort((a, b) => a.t - b.t).filter((c, i, all) => i === 0 || c.t - (all[i - 1] as { t: number }).t > EPS);
  if (sorted.length === 0) return [{ from, seg }];
  const pieces: Piece[] = [];
  let start = from;
  let rest: Seg = seg;
  let done = 0;
  for (const cut of sorted) {
    const local = (cut.t - done) / (1 - done);
    if (rest.kind === "line") {
      const at = snap(lerp(start, rest.to, local), cut);
      pieces.push({ from: start, seg: { kind: "line", to: at } });
      start = at;
    } else {
      const [left, right] = splitCubic(start, rest, local);
      const at = snap(left.to, cut);
      pieces.push({ from: start, seg: { ...left, to: at } });
      start = at;
      rest = right;
    }
    done = cut.t;
  }
  pieces.push({ from: start, seg: rest });
  return pieces;
}

function midpoint(p: Piece): Pt {
  return p.seg.kind === "line" ? lerp(p.from, p.seg.to, 0.5) : cubicAt(p.from, p.seg.c1, p.seg.c2, p.seg.to, 0.5);
}

const samePoint = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-7 && Math.abs(a.y - b.y) < 1e-7;

/** The subpath's segments as pieces, with the closing line made explicit. */
function piecesOf(sp: Subpath): Piece[] {
  const out: Piece[] = [];
  let from = sp.start;
  for (const seg of sp.segs) {
    out.push({ from, seg });
    from = seg.to;
  }
  if (sp.closed && !samePoint(from, sp.start)) out.push({ from, seg: { kind: "line", to: sp.start } });
  return out;
}

export function subpathBounds(sp: Subpath): Box {
  let x0 = sp.start.x;
  let x1 = sp.start.x;
  let y0 = sp.start.y;
  let y1 = sp.start.y;
  const add = (p: Pt) => {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  };
  for (const s of sp.segs) {
    add(s.to);
    if (s.kind === "cubic") {
      add(s.c1);
      add(s.c2);
    }
  }
  return { x0, y0, x1, y1 };
}

export const boxesMeet = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

const inside = (p: Pt, b: Box) => p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1;

/** Boxes shrunk by `margin` on every side; the ones left with no area are dropped. */
export function shrinkBoxes(boxes: readonly Box[], margin: number): Box[] {
  return boxes
    .map((b) => ({ x0: b.x0 + margin, y0: b.y0 + margin, x1: b.x1 - margin, y1: b.y1 - margin }))
    .filter((b) => b.x1 - b.x0 > EPS && b.y1 - b.y0 > EPS);
}

/**
 * The stroke left outside the boxes: every segment cut where it crosses a box
 * edge, the pieces inside a box dropped. A closed subpath that loses a piece
 * becomes one open run starting after the cut (its other joins stay joins).
 * Untouched subpaths come back as they were.
 */
export function clipStroke(subpaths: readonly Subpath[], boxes: readonly Box[]): Subpath[] {
  const out: Subpath[] = [];
  for (const sp of subpaths) {
    const near = boxes.filter((b) => {
      const sb = subpathBounds(sp);
      return sb.x0 <= b.x1 && b.x0 <= sb.x1 && sb.y0 <= b.y1 && b.y0 <= sb.y1;
    });
    if (near.length === 0) {
      out.push(sp);
      continue;
    }
    if (sp.segs.length === 0) {
      if (!near.some((b) => inside(sp.start, b))) out.push(sp);
      continue;
    }
    const pieces: { piece: Piece; keep: boolean }[] = [];
    for (const p of piecesOf(sp)) {
      const cuts: { t: number; axis: Axis; value: number }[] = [];
      // Only where the crossing is on the box's edge: a cut elsewhere would just add a vertex.
      const at = (t: number): Pt => (p.seg.kind === "line" ? lerp(p.from, p.seg.to, t) : cubicAt(p.from, p.seg.c1, p.seg.c2, p.seg.to, t));
      for (const b of near) {
        for (const value of [b.x0, b.x1]) {
          for (const t of crossings(p.from, p.seg, "x", value)) {
            const y = at(t).y;
            if (y >= b.y0 - EPS && y <= b.y1 + EPS) cuts.push({ t, axis: "x", value });
          }
        }
        for (const value of [b.y0, b.y1]) {
          for (const t of crossings(p.from, p.seg, "y", value)) {
            const x = at(t).x;
            if (x >= b.x0 - EPS && x <= b.x1 + EPS) cuts.push({ t, axis: "y", value });
          }
        }
      }
      for (const piece of cutSegment(p.from, p.seg, cuts)) {
        const m = midpoint(piece);
        pieces.push({ piece, keep: !near.some((b) => inside(m, b)) });
      }
    }
    if (pieces.every((p) => p.keep)) {
      out.push(sp);
      continue;
    }
    let order = pieces;
    if (sp.closed) {
      const firstDropped = pieces.findIndex((p) => !p.keep);
      order = [...pieces.slice(firstDropped + 1), ...pieces.slice(0, firstDropped + 1)];
    }
    let run: { start: Pt; segs: Seg[] } | null = null;
    for (const { piece, keep } of order) {
      if (!keep) {
        if (run) out.push({ ...run, closed: false });
        run = null;
        continue;
      }
      if (run && !samePoint(endOfRun(run), piece.from)) {
        out.push({ ...run, closed: false });
        run = null;
      }
      run ??= { start: piece.from, segs: [] };
      run.segs.push(piece.seg);
    }
    if (run) out.push({ ...run, closed: false });
  }
  return out;
}

const endOfRun = (run: { start: Pt; segs: Seg[] }): Pt => (run.segs.length > 0 ? (run.segs[run.segs.length - 1] as Seg).to : run.start);

/** A closed subpath clipped to the half-plane `axis <= value` (keepBelow) or `>=`. */
function clipHalfPlane(sp: Subpath, axis: Axis, value: number, keepBelow: boolean): Subpath | null {
  const ok = (p: Pt) => (keepBelow ? p[axis] <= value + EPS : p[axis] >= value - EPS);
  let out: { start: Pt; segs: Seg[] } | null = null;
  for (const p of piecesOf({ ...sp, closed: true })) {
    const cuts = crossings(p.from, p.seg, axis, value).map((t) => ({ t, axis, value }));
    for (const piece of cutSegment(p.from, p.seg, cuts)) {
      if (!ok(midpoint(piece))) continue;
      if (!out) out = { start: piece.from, segs: [] };
      else if (!samePoint(endOfRun(out), piece.from)) out.segs.push({ kind: "line", to: piece.from });
      out.segs.push(piece.seg);
    }
  }
  if (!out || out.segs.length === 0) return null;
  return { start: out.start, segs: out.segs, closed: true };
}

/**
 * The complement of the boxes' union within `bounds`, as disjoint cells:
 * vertical slabs between the boxes' x edges, each split where boxes cover it;
 * neighbouring slabs with the same free intervals are merged.
 */
export function complementCells(boxes: readonly Box[], bounds: Box): Box[] {
  const xs = [bounds.x0, bounds.x1];
  for (const b of boxes) for (const x of [b.x0, b.x1]) if (x > bounds.x0 && x < bounds.x1) xs.push(x);
  const edges = [...new Set(xs)].sort((a, b) => a - b);
  const cells: Box[] = [];
  let open: Box[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const xa = edges[i] as number;
    const xb = edges[i + 1] as number;
    if (xb - xa <= EPS) continue;
    const covering = boxes
      .filter((b) => b.x0 <= xa + EPS && b.x1 >= xb - EPS && b.y1 > bounds.y0 && b.y0 < bounds.y1)
      .map((b) => [Math.max(b.y0, bounds.y0), Math.min(b.y1, bounds.y1)] as const)
      .sort((a, b) => a[0] - b[0]);
    const free: [number, number][] = [];
    let y = bounds.y0;
    for (const [lo, hi] of covering) {
      if (lo > y + EPS) free.push([y, lo]);
      y = Math.max(y, hi);
    }
    if (bounds.y1 > y + EPS) free.push([y, bounds.y1]);
    const same = open.length === free.length && open.every((c, k) => c.y0 === (free[k] as [number, number])[0] && c.y1 === (free[k] as [number, number])[1]);
    if (same) {
      open = open.map((c) => ({ ...c, x1: xb }));
    } else {
      cells.push(...open);
      open = free.map(([y0, y1]) => ({ x0: xa, y0, x1: xb, y1 }));
    }
  }
  cells.push(...open);
  return cells;
}

/**
 * The fill left outside the boxes (same fill rule): subpaths that keep clear
 * of every box stay whole; the others are clipped to each complement cell.
 */
export function clipFill(subpaths: readonly Subpath[], boxes: readonly Box[]): Subpath[] {
  const out: Subpath[] = [];
  const touched: Subpath[] = [];
  for (const sp of subpaths) {
    if (sp.segs.length === 0) continue;
    if (boxes.some((b) => boxesMeet(subpathBounds(sp), b))) touched.push(sp);
    else out.push(sp);
  }
  if (touched.length === 0) return out;
  const all = touched.map(subpathBounds);
  const bounds: Box = {
    x0: Math.min(...all.map((b) => b.x0)) - 1,
    y0: Math.min(...all.map((b) => b.y0)) - 1,
    x1: Math.max(...all.map((b) => b.x1)) + 1,
    y1: Math.max(...all.map((b) => b.y1)) + 1,
  };
  for (const cell of complementCells(boxes, bounds)) {
    for (const sp of touched) {
      if (!boxesMeet(subpathBounds(sp), cell)) continue;
      let clipped: Subpath | null = sp;
      // Cell edges on the outer bounds clip nothing: skip them.
      if (cell.x0 > bounds.x0) clipped = clipHalfPlane(clipped, "x", cell.x0, false);
      if (clipped && cell.x1 < bounds.x1) clipped = clipHalfPlane(clipped, "x", cell.x1, true);
      if (clipped && cell.y0 > bounds.y0) clipped = clipHalfPlane(clipped, "y", cell.y0, false);
      if (clipped && cell.y1 < bounds.y1) clipped = clipHalfPlane(clipped, "y", cell.y1, true);
      if (clipped) out.push(clipped);
    }
  }
  return out;
}

/** Does any part of the subpaths come within the boxes? (Bounding boxes; cheap.) */
export function pathMeets(subpaths: readonly Subpath[], boxes: readonly Box[]): boolean {
  return subpaths.some((sp) => boxes.some((b) => boxesMeet(subpathBounds(sp), b)));
}
