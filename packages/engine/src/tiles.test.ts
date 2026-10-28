import { describe, expect, it } from "vitest";
import { unrotateRect, rotateRect, rotateSize, type QuarterTurns } from "./geometry";
import { renderPlan, snapToDevice, TILE_SIZE, visibleTiles } from "./tiles";

const A4 = { width: 595.28, height: 841.89 };
const PIXEL_7 = { dpr: 2.625, viewport: 412 * 2.625 * (915 * 2.625) };

describe("snapToDevice", () => {
  it("lands every length on a whole device pixel", () => {
    for (const dpr of [1, 2, 2.625, 2.75, 3]) {
      for (const css of [0, 0.3, 395.43, 1000.01]) {
        const px = snapToDevice(css, dpr) * dpr;
        expect(Math.abs(px - Math.round(px))).toBeLessThan(1e-9);
        expect(Math.abs(snapToDevice(css, dpr) - css)).toBeLessThanOrEqual(0.5 / dpr + 1e-9);
      }
    }
  });
});

describe("renderPlan", () => {
  it("renders at CSS width × devicePixelRatio, in whole device pixels", () => {
    for (const dpr of [2.625, 3]) {
      const css = snapToDevice(396, dpr);
      const plan = renderPlan(A4, css, dpr, 6_000_000, PIXEL_7.viewport);
      expect(plan.tiled).toBe(false);
      expect(plan.deviceWidth).toBe(Math.round(css * dpr));
      expect(plan.scale * A4.width).toBeCloseTo(plan.deviceWidth, 9);
      expect(plan.baseScale).toBe(plan.scale);
      // PDFium sizes the bitmap with Math.round(points × scale): the same pixel grid.
      expect(Math.round(A4.height * plan.scale)).toBe(plan.deviceHeight);
    }
  });

  it("tiles instead of lowering the resolution above the tier cap", () => {
    const plan = renderPlan(A4, 396 * 5, PIXEL_7.dpr, 6_000_000, PIXEL_7.viewport);
    expect(plan.tiled).toBe(true);
    expect(plan.scale).toBe(Math.round(396 * 5 * PIXEL_7.dpr) / A4.width);
    expect(plan.baseScale).toBeLessThan(plan.scale);
    expect(A4.width * plan.baseScale * A4.height * plan.baseScale).toBeLessThanOrEqual(PIXEL_7.viewport / 2 + 1);
  });

  it("tiles a page larger than two viewports even under the cap", () => {
    expect(renderPlan(A4, 396 * 2.2, PIXEL_7.dpr, 16_000_000, PIXEL_7.viewport).tiled).toBe(true);
    expect(renderPlan(A4, 396 * 1.5, PIXEL_7.dpr, 16_000_000, PIXEL_7.viewport).tiled).toBe(false);
  });

  it("is empty for an empty page or box", () => {
    expect(renderPlan({ width: 0, height: 10 }, 100, 2, 1e6, 1e6).scale).toBe(0);
    expect(renderPlan(A4, 0, 2, 1e6, 1e6).deviceWidth).toBe(0);
  });
});

describe("visibleTiles", () => {
  it("covers the view (plus margin) with grid tiles cut to the page, centre first", () => {
    const tiles = visibleTiles(2000, 3000, { x: 600, y: 900, width: 1080, height: 1500 }, 0);
    const covered = (x: number, y: number) => tiles.some((t) => x >= t.x && x < t.x + t.width && y >= t.y && y < t.y + t.height);
    for (let y = 900; y < 2400; y += 37) for (let x = 600; x < 1680; x += 41) expect(covered(x, y)).toBe(true);
    for (const t of tiles) {
      expect(t.x % TILE_SIZE).toBe(0);
      expect(t.y % TILE_SIZE).toBe(0);
      expect(t.x + t.width).toBeLessThanOrEqual(2000);
      expect(t.y + t.height).toBeLessThanOrEqual(3000);
    }
    expect(new Set(tiles.map((t) => t.key)).size).toBe(tiles.length);
    const first = tiles[0];
    expect(first && first.x <= 1140 && first.x + first.width >= 1140).toBe(true);
  });

  it("returns nothing for a view outside the page", () => {
    expect(visibleTiles(1000, 1000, { x: 1200, y: 0, width: 100, height: 100 })).toEqual([]);
    expect(visibleTiles(1000, 1000, { x: 0, y: -500, width: 100, height: 400 })).toEqual([]);
  });
});

describe("unrotateRect", () => {
  it("undoes rotateRect for every quarter turn", () => {
    const rect = { x: 10, y: 20, width: 30, height: 40 };
    for (const turns of [0, 1, 2, 3] as QuarterTurns[]) {
      const turned = rotateRect(rect, A4, turns);
      expect(unrotateRect(turned, A4, turns)).toEqual(rect);
      expect(rotateSize(rotateSize(A4, turns), turns)).toEqual(A4);
    }
  });
});
