import { describe, expect, it } from "vitest";
import { applyNightMode, fromPdfBounds, nextTurn, rotateRect, rotateSize } from "./geometry";

const page = { width: 600, height: 800 };
const rect = { x: 50, y: 100, width: 200, height: 40 };

describe("rotation", () => {
  it("swaps the page size on quarter turns", () => {
    expect(rotateSize(page, 0)).toEqual(page);
    expect(rotateSize(page, 1)).toEqual({ width: 800, height: 600 });
    expect(rotateSize(page, 2)).toEqual(page);
  });

  it("moves a rect with the page, clockwise", () => {
    expect(rotateRect(rect, page, 0)).toEqual(rect);
    // 90°: the top-left corner of the page goes to the top-right.
    expect(rotateRect(rect, page, 1)).toEqual({ x: 800 - 100 - 40, y: 50, width: 40, height: 200 });
    expect(rotateRect(rect, page, 2)).toEqual({ x: 600 - 50 - 200, y: 800 - 100 - 40, width: 200, height: 40 });
    expect(rotateRect(rect, page, 3)).toEqual({ x: 100, y: 600 - 50 - 200, width: 40, height: 200 });
  });

  it("four turns come back to the start", () => {
    let r = rect;
    let size = page;
    for (let t = 0; t < 4; t++) {
      r = rotateRect(r, size, 1);
      size = rotateSize(size, 1);
    }
    expect(r).toEqual(rect);
    expect(nextTurn(3)).toBe(0);
  });

  it("converts PDF bounds (bottom-left origin) to a top-left rect", () => {
    expect(fromPdfBounds(56, 480, 296, 630, page)).toEqual({ x: 56, y: 170, width: 240, height: 150 });
  });
});

describe("night mode", () => {
  it("turns white paper dark and black ink light, leaving kept rects alone", () => {
    // 3×1 pixels: white, black, red (kept).
    const data = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 200, 30, 30, 255]);
    applyNightMode(data, 3, 1, [{ x: 2, y: 0, width: 1, height: 1 }]);
    expect(Math.max(data[0] as number, data[1] as number, data[2] as number)).toBeLessThan(40);
    expect(Math.min(data[4] as number, data[5] as number, data[6] as number)).toBeGreaterThan(200);
    expect([...data.slice(8, 12)]).toEqual([200, 30, 30, 255]);
    expect(data[3]).toBe(255);
  });

  it("keeps hues roughly in place (red stays reddish)", () => {
    const data = new Uint8ClampedArray([200, 30, 30, 255]);
    applyNightMode(data, 1, 1);
    expect(data[0] as number).toBeGreaterThan(data[1] as number);
    expect(data[0] as number).toBeGreaterThan(data[2] as number);
  });
});
