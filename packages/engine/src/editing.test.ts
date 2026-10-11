import { describe, expect, it } from "vitest";
import { annotationAt, glyphAt, selectionRects, simplifyStroke, strokesBounds, unionRect } from "./editing";
import type { Annotation, Glyph } from "./types";

/** Two lines of 10-pt glyphs ("ab cd" / "ef"), runs 0 and 1. */
function lines(): Glyph[] {
  const g = (x: number, y: number, run: number, space = false): Glyph => ({ x, y, width: 6, height: 10, run, space });
  return [g(10, 10, 0), g(16, 10, 0), g(22, 10, 0, true), g(28, 10, 0), g(34, 10, 0), g(10, 30, 1), g(16, 30, 1)];
}

describe("glyphAt", () => {
  it("picks the glyph under the point, else the nearest on the closer line", () => {
    const glyphs = lines();
    expect(glyphAt(glyphs, { x: 12, y: 15 })).toBe(0);
    expect(glyphAt(glyphs, { x: 50, y: 14 })).toBe(4);
    // Between the lines, nearer the second.
    expect(glyphAt(glyphs, { x: 12, y: 27 })).toBe(5);
    expect(glyphAt(glyphs, { x: 400, y: 400 })).toBe(-1);
  });
});

describe("selectionRects", () => {
  it("gives one rect per line, without the spaces at its ends, in either direction", () => {
    const glyphs = lines();
    const forward = selectionRects(glyphs, 1, 6);
    expect(forward).toEqual([
      { x: 16, y: 10, width: 24, height: 10 },
      { x: 10, y: 30, width: 12, height: 10 },
    ]);
    expect(selectionRects(glyphs, 6, 1)).toEqual(forward);
    expect(selectionRects(glyphs, 2, 2)).toEqual([]);
    expect(selectionRects(glyphs, -1, 3)).toEqual([]);
  });
});

describe("simplifyStroke", () => {
  it("drops collinear points and keeps corners and ends", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 0.01 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 5 },
    ];
    expect(simplifyStroke(pts)).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 5 },
    ]);
    expect(simplifyStroke([{ x: 1, y: 1 }])).toEqual([{ x: 1, y: 1 }]);
  });
});

describe("bounds", () => {
  it("unions rects and pads strokes by half their width", () => {
    expect(unionRect([])).toBeNull();
    expect(
      unionRect([
        { x: 0, y: 0, width: 1, height: 1 },
        { x: 5, y: 5, width: 1, height: 1 },
      ]),
    ).toEqual({ x: 0, y: 0, width: 6, height: 6 });
    expect(strokesBounds([[{ x: 10, y: 10 }, { x: 20, y: 30 }]], 4)).toEqual({ x: 8, y: 8, width: 14, height: 24 });
  });
});

describe("annotationAt (eraser)", () => {
  const base = { page: 0, color: "#000000", opacity: 1 } as const;
  const ink: Annotation = {
    ...base,
    id: "ink",
    kind: "ink",
    rect: { x: 0, y: 0, width: 100, height: 100 },
    width: 2,
    strokes: [[{ x: 0, y: 0 }, { x: 100, y: 100 }]],
  };
  const box: Annotation = { ...base, id: "box", kind: "square", rect: { x: 200, y: 200, width: 100, height: 100 }, width: 2, fill: null };
  const filled: Annotation = { ...box, id: "filled", rect: { x: 400, y: 400, width: 50, height: 50 }, fill: "#ffffff" };
  const foreign: Annotation = { ...base, id: "link", kind: "other", rect: { x: 0, y: 0, width: 500, height: 500 } };

  it("hits strokes near the line, outlines near the border, filled shapes inside", () => {
    const all = [foreign, ink, box, filled];
    expect(annotationAt(all, { x: 50, y: 52 })?.id).toBe("ink");
    expect(annotationAt(all, { x: 80, y: 20 })).toBeNull();
    expect(annotationAt(all, { x: 201, y: 250 })?.id).toBe("box");
    expect(annotationAt(all, { x: 250, y: 250 })).toBeNull();
    expect(annotationAt(all, { x: 425, y: 425 })?.id).toBe("filled");
  });

  it("prefers the topmost (last drawn)", () => {
    const top: Annotation = { ...ink, id: "top" };
    expect(annotationAt([ink, top], { x: 10, y: 10 })?.id).toBe("top");
  });
});
