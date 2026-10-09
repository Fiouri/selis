import { describe, expect, it } from "vitest";
import { layoutPages, pageAt, renderScale, renderWindow, visibleRange } from "./layout";

const A4 = { width: 595, height: 842 };
const LANDSCAPE = { width: 842, height: 595 };

describe("layoutPages", () => {
  it("fits the widest page to the width and stacks with gaps", () => {
    const layout = layoutPages([A4, LANDSCAPE, A4], 842, 1, 8);
    expect(layout.widths[1]).toBeCloseTo(842);
    expect(layout.widths[0]).toBeCloseTo(595);
    expect(layout.tops[0]).toBe(8);
    expect(layout.tops[1]).toBeCloseTo(8 + 842 + 8);
    expect(layout.totalHeight).toBeCloseTo(8 + 842 + 8 + 595 + 8 + 842 + 8);
  });

  it("scales with zoom", () => {
    const a = layoutPages([A4], 300, 1, 0);
    const b = layoutPages([A4], 300, 2, 0);
    expect(b.heights[0]).toBeCloseTo((a.heights[0] as number) * 2);
  });

  it("handles an empty document", () => {
    const layout = layoutPages([], 300, 1, 8);
    expect(layout.totalHeight).toBe(8);
    expect(pageAt(layout, 100)).toBe(-1);
    expect(visibleRange(layout, 0, 500)).toBeNull();
  });
});

describe("visible range and render window", () => {
  const pages = Array.from({ length: 1000 }, () => A4);
  const layout = layoutPages(pages, 400, 1, 8);
  const pageH = (layout.heights[0] as number) + 8;

  it("finds the pages in the viewport", () => {
    expect(visibleRange(layout, 0, 300)).toEqual({ first: 0, last: 0 });
    expect(visibleRange(layout, pageH * 10 + 1, pageH)).toEqual({ first: 10, last: 10 });
    expect(visibleRange(layout, pageH * 10 + 1, pageH + 20)).toEqual({ first: 10, last: 11 });
  });

  it("adds one buffer page on each side, clamped", () => {
    expect(renderWindow({ first: 0, last: 0 }, 1000)).toEqual({ first: 0, last: 1 });
    expect(renderWindow({ first: 500, last: 501 }, 1000)).toEqual({ first: 499, last: 502 });
    expect(renderWindow({ first: 999, last: 999 }, 1000)).toEqual({ first: 998, last: 999 });
  });

  it("keeps the rendered set small at the bottom of a 1000-page document", () => {
    const top = layout.totalHeight - 800;
    const range = visibleRange(layout, top, 800);
    const win = renderWindow(range, 1000);
    expect(win?.last).toBe(999);
    expect((win?.last ?? 0) - (win?.first ?? 0) + 1).toBeLessThanOrEqual(5);
  });

  it("binary search agrees with a linear scan", () => {
    for (const y of [0, 7, 9, pageH * 3.5, pageH * 999, layout.totalHeight + 100]) {
      let linear = 0;
      while (linear < 999 && (layout.tops[linear] as number) + (layout.heights[linear] as number) < y) linear++;
      expect(pageAt(layout, y)).toBe(linear);
    }
  });
});

describe("renderScale", () => {
  it("maps CSS width and DPR to pixels per point", () => {
    expect(renderScale(A4, 595, 2)).toBeCloseTo(2);
    expect(renderScale({ width: 0, height: 1 }, 100, 1)).toBe(0);
  });
});
