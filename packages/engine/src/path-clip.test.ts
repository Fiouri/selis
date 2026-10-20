import { describe, expect, it } from "vitest";
import { type Box, clipFill, clipStroke, complementCells, type Pt, type Seg, shrinkBoxes, type Subpath } from "./path-clip";

const P = (x: number, y: number): Pt => ({ x, y });
const line = (x: number, y: number): Seg => ({ kind: "line", to: P(x, y) });
const rect = (x: number, y: number, w: number, h: number, ccw = false): Subpath =>
  ccw
    ? { start: P(x, y), segs: [line(x, y + h), line(x + w, y + h), line(x + w, y)], closed: true }
    : { start: P(x, y), segs: [line(x + w, y), line(x + w, y + h), line(x, y + h)], closed: true };

/** A circle from four cubics (counter-clockwise). */
function circle(cx: number, cy: number, r: number): Subpath {
  const k = 0.5522847498 * r;
  return {
    start: P(cx + r, cy),
    segs: [
      { kind: "cubic", c1: P(cx + r, cy + k), c2: P(cx + k, cy + r), to: P(cx, cy + r) },
      { kind: "cubic", c1: P(cx - k, cy + r), c2: P(cx - r, cy + k), to: P(cx - r, cy) },
      { kind: "cubic", c1: P(cx - r, cy - k), c2: P(cx - k, cy - r), to: P(cx, cy - r) },
      { kind: "cubic", c1: P(cx + k, cy - r), c2: P(cx + r, cy - k), to: P(cx + r, cy) },
    ],
    closed: true,
  };
}

/** The subpath as a polygon (cubics flattened finely). */
function polygon(sp: Subpath): Pt[] {
  const out: Pt[] = [sp.start];
  let from = sp.start;
  for (const s of sp.segs) {
    if (s.kind === "line") out.push(s.to);
    else {
      for (let i = 1; i <= 64; i++) {
        const t = i / 64;
        const u = 1 - t;
        out.push({
          x: u * u * u * from.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.to.x,
          y: u * u * u * from.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.to.y,
        });
      }
    }
    from = s.to;
  }
  return out;
}

function winding(subpaths: readonly Subpath[], p: Pt): number {
  let w = 0;
  for (const sp of subpaths) {
    const poly = polygon(sp);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i] as Pt;
      const b = poly[(i + 1) % poly.length] as Pt;
      const cross = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
      if (a.y <= p.y && b.y > p.y && cross > 0) w++;
      else if (a.y > p.y && b.y <= p.y && cross < 0) w--;
    }
  }
  return w;
}

const inBox = (p: Pt, b: Box) => p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1;

/** Deterministic sample points over a square. */
function samples(x0: number, y0: number, size: number, n = 41): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push(P(x0 + ((i + 0.37) / n) * size, y0 + ((j + 0.61) / n) * size));
  return out;
}

function pointsOf(subpaths: readonly Subpath[]): Pt[] {
  return subpaths.flatMap((sp) => [sp.start, ...sp.segs.map((s) => s.to)]);
}

describe("clipFill", () => {
  const cases: { name: string; path: Subpath[]; boxes: Box[] }[] = [
    { name: "rect, box over one edge", path: [rect(0, 0, 100, 60)], boxes: [{ x0: 70, y0: 20, x1: 140, y1: 40 }] },
    { name: "rect, box inside (a hole)", path: [rect(0, 0, 100, 60)], boxes: [{ x0: 30, y0: 20, x1: 50, y1: 40 }] },
    { name: "rect with a hole, box across both", path: [rect(0, 0, 100, 100), rect(30, 30, 40, 40, true)], boxes: [{ x0: 40, y0: -10, x1: 60, y1: 110 }] },
    { name: "circle, brush of overlapping boxes", path: [circle(50, 50, 40)], boxes: [0, 1, 2, 3, 4, 5].map((i) => ({ x0: 10 + i * 9, y0: 30 + i * 5, x1: 26 + i * 9, y1: 46 + i * 5 })) },
    { name: "self-overlapping (winding 2)", path: [rect(0, 0, 60, 60), rect(30, 30, 60, 60)], boxes: [{ x0: 40, y0: 40, x1: 50, y1: 100 }] },
  ];
  for (const c of cases) {
    it(`keeps the winding outside the boxes and none inside: ${c.name}`, () => {
      const out = clipFill(c.path, c.boxes);
      for (const p of samples(-15, -15, 130)) {
        const expected = c.boxes.some((b) => inBox(p, b)) ? 0 : winding(c.path, p);
        expect(winding(out, p), `${p.x},${p.y}`).toBe(expected);
      }
    });
  }

  it("leaves subpaths away from the boxes untouched", () => {
    const far = rect(200, 200, 10, 10);
    const out = clipFill([rect(0, 0, 100, 60), far], [{ x0: 70, y0: 20, x1: 140, y1: 40 }]);
    expect(out).toContain(far);
  });

  it("keeps the curve itself outside the boxes", () => {
    const out = clipFill([circle(50, 50, 40)], [{ x0: 40, y0: 0, x1: 60, y1: 100 }]);
    for (const p of pointsOf(out)) {
      const onCircle = Math.abs(Math.hypot(p.x - 50, p.y - 50) - 40) < 1e-6;
      const onCut = Math.abs(p.x - 40) < 1e-9 || Math.abs(p.x - 60) < 1e-9;
      expect(onCircle || onCut, `${p.x},${p.y}`).toBe(true);
    }
  });
});

describe("clipStroke", () => {
  const box: Box = { x0: 40, y0: -10, x1: 60, y1: 10 };

  it("cuts a line into the parts outside the box", () => {
    const out = clipStroke([{ start: P(0, 0), segs: [line(100, 0)], closed: false }], [box]);
    expect(out).toEqual([
      { start: P(0, 0), segs: [line(40, 0)], closed: false },
      { start: P(60, 0), segs: [line(100, 0)], closed: false },
    ]);
  });

  it("turns a cut closed outline into one open run (the other corners stay joins)", () => {
    const out = clipStroke([rect(0, -20, 100, 40)], [{ x0: 40, y0: -30, x1: 60, y1: -10 }]);
    expect(out).toHaveLength(1);
    const run = out[0] as Subpath;
    expect(run.closed).toBe(false);
    expect(run.start).toEqual(P(60, -20));
    expect(run.segs.map((s) => s.to)).toEqual([P(100, -20), P(100, 20), P(0, 20), P(0, -20), P(40, -20)]);
  });

  it("drops the curve pieces inside and keeps the rest on the curve", () => {
    const out = clipStroke([circle(50, 50, 40)], [{ x0: 80, y0: 30, x1: 100, y1: 70 }]);
    expect(out).toHaveLength(1);
    // Four cubics are within 0.03 % of a true circle: the kept points sit on them.
    for (const p of pointsOf(out)) expect(Math.abs(Math.hypot(p.x - 50, p.y - 50) - 40)).toBeLessThan(0.012);
    for (const sp of out) for (const p of polygon(sp)) expect(p.x > 80 && p.y > 30 && p.y < 70).toBe(false);
  });

  it("returns untouched subpaths as they were", () => {
    const sp = rect(0, 0, 10, 10);
    expect(clipStroke([sp], [box])[0]).toBe(sp);
  });

  it("shrinks boxes by half the line width", () => {
    expect(shrinkBoxes([box, { x0: 0, y0: 0, x1: 2, y1: 2 }], 1.5)).toEqual([{ x0: 41.5, y0: -8.5, x1: 58.5, y1: 8.5 }]);
  });
});

describe("complementCells", () => {
  it("covers the bounds minus the boxes, without overlaps", () => {
    const bounds: Box = { x0: 0, y0: 0, x1: 100, y1: 100 };
    const boxes: Box[] = [
      { x0: 10, y0: 10, x1: 40, y1: 40 },
      { x0: 30, y0: 30, x1: 70, y1: 50 },
      { x0: 90, y0: -5, x1: 120, y1: 20 },
    ];
    const cells = complementCells(boxes, bounds);
    for (const p of samples(0, 0, 100, 50)) {
      const holders = cells.filter((c) => inBox(p, c)).length;
      expect(holders, `${p.x},${p.y}`).toBe(boxes.some((b) => inBox(p, b)) ? 0 : 1);
    }
  });
});
