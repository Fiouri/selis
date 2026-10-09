import { describe, expect, it } from "vitest";
import { assignSlots } from "./PdfViewer";

describe("assignSlots (canvas pool)", () => {
  it("keeps pages on their slot and recycles freed slots", () => {
    const slots = new Map<number, number>();
    assignSlots(slots, { first: 0, last: 2 });
    expect([...slots.entries()]).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    assignSlots(slots, { first: 1, last: 3 });
    expect(slots.get(1)).toBe(1);
    expect(slots.get(2)).toBe(2);
    expect(slots.get(3)).toBe(0); // page 0 left; its canvas is reused
    expect(slots.has(0)).toBe(false);
  });

  it("shrinking then growing the window never duplicates a slot", () => {
    const slots = new Map<number, number>();
    assignSlots(slots, { first: 0, last: 4 });
    assignSlots(slots, { first: 3, last: 4 });
    assignSlots(slots, { first: 3, last: 7 });
    const used = [...slots.values()];
    expect(new Set(used).size).toBe(used.length);
    expect(slots.get(3)).toBe(3);
    expect(slots.get(4)).toBe(4);
  });

  it("never hands the same slot to two pages and stays bounded while scrolling", () => {
    const slots = new Map<number, number>();
    for (let first = 0; first < 1000; first += 3) {
      const size = 2 + (first % 5); // window grows and shrinks (zoom, page sizes)
      assignSlots(slots, { first, last: Math.min(999, first + size) });
      const used = [...slots.values()];
      expect(new Set(used).size).toBe(used.length);
      expect(Math.max(...used)).toBeLessThan(10);
    }
  });
});
