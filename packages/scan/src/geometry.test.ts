import { describe, expect, it } from "vitest";
import { clampPoint, defaultQuad, fromBox, isConvex, mapQuad, placement, type Quad, smoothQuad, svgPoints, toBox, turn, unturn, withCorner } from "./geometry";

const square: Quad = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe("placement", () => {
  it("covers: the picture fills the box and is cropped", () => {
    expect(placement({ width: 1080, height: 1920 }, { width: 390, height: 844 }, "cover")).toEqual({
      scale: 844 / 1920,
      left: (390 - 1080 * (844 / 1920)) / 2,
      top: 0,
    });
  });

  it("contains: the picture fits and is letterboxed, and maps both ways", () => {
    const at = placement({ width: 400, height: 300 }, { width: 200, height: 300 }, "contain");
    expect(at).toEqual({ scale: 0.5, left: 0, top: 75 });
    expect(toBox(square, at)[0]).toEqual([0, 75]);
    expect(fromBox([100, 150], at)).toEqual([200, 150]);
  });
});

describe("outlines", () => {
  it("default outline is inset", () => {
    expect(defaultQuad({ width: 100, height: 200 }, 0.1)).toEqual([
      [10, 20],
      [90, 20],
      [90, 180],
      [10, 180],
    ]);
  });

  it("knows convex from crossed or folded outlines", () => {
    expect(isConvex(square)).toBe(true);
    expect(isConvex(withCorner(square, 2, [-5, -5]))).toBe(false);
    expect(isConvex([square[0], square[2], square[1], square[3]])).toBe(false);
    expect(isConvex(withCorner(square, 2, [5, 5]))).toBe(false);
  });

  it("keeps a dragged corner inside the picture", () => {
    expect(clampPoint([-4, 120], { width: 100, height: 100 })).toEqual([0, 100]);
  });

  it("eases small moves and jumps on large ones", () => {
    const moved = mapQuad(square, ([x, y]) => [x + 2, y]);
    expect(smoothQuad(square, moved, 5)[0]).toEqual([1, 0]);
    const far = mapQuad(square, ([x, y]) => [x + 20, y]);
    expect(smoothQuad(square, far, 5)).toBe(far);
    expect(smoothQuad(null, far, 5)).toBe(far);
  });

  it("renders SVG points", () => {
    expect(svgPoints(square)).toBe("0.0,0.0 10.0,0.0 10.0,10.0 0.0,10.0");
  });

  it("turns page points back and forth with the page", () => {
    // Clockwise: the page's top-left corner shows at the top right after one turn.
    expect(turn([0, 0], 1)).toEqual([1, 0]);
    expect(turn([0.2, 0.1], 1)).toEqual([0.9, 0.2]);
    for (const turns of [0, 1, 2, 3, 5, -1]) {
      const p: [number, number] = [0.3, 0.8];
      const back = unturn(turn(p, turns), turns);
      expect(back[0]).toBeCloseTo(p[0], 9);
      expect(back[1]).toBeCloseTo(p[1], 9);
    }
  });
});
