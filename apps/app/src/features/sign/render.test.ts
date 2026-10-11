import { describe, expect, it } from "vitest";
import { contentBounds, knockOutBackground } from "./render";

function rgba(pixels: [number, number, number, number][]): Uint8ClampedArray {
  return new Uint8ClampedArray(pixels.flat());
}

describe("knockOutBackground", () => {
  it("clears paper, keeps ink, fades the edge in between", () => {
    const data = rgba([
      [250, 248, 240, 255], // paper
      [20, 30, 120, 255], // ink
      [178, 178, 178, 255], // anti-aliased edge
      [255, 255, 255, 0], // already transparent
    ]);
    knockOutBackground(data);
    expect(data[3]).toBe(0);
    expect(data[7]).toBe(255);
    expect(data[11]).toBeGreaterThan(0);
    expect(data[11]).toBeLessThan(255);
    expect(data[15]).toBe(0);
  });
});

describe("contentBounds", () => {
  it("finds the box of visible pixels, or null", () => {
    // 4 × 3 image with ink at (1,1) and (2,2).
    const data = new Uint8ClampedArray(4 * 3 * 4);
    data[(1 * 4 + 1) * 4 + 3] = 255;
    data[(2 * 4 + 2) * 4 + 3] = 40;
    expect(contentBounds(data, 4, 3)).toEqual({ x: 1, y: 1, width: 2, height: 2 });
    expect(contentBounds(new Uint8ClampedArray(16), 2, 2)).toBeNull();
  });
});
