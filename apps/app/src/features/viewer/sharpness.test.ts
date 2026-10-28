import { describe, expect, it, vi } from "vitest";
import { type PageSharpness, SharpnessTracker } from "./sharpness";

const page = (index: number, sharp: boolean): PageSharpness => ({
  page: index,
  cssWidth: 396,
  cssHeight: 560,
  dpr: 2.625,
  deviceWidth: 1040,
  deviceHeight: 1471,
  maxBitmapPixels: 6_000_000,
  bitmapWidth: sharp ? 1040 : 520,
  bitmapHeight: sharp ? 1471 : 735,
  tiled: false,
  tilesVisible: 0,
  tilesDrawn: 0,
  sharp,
  upgrades: 0,
});

describe("SharpnessTracker", () => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);

  it("measures from the last motion until every visible page is sharp", () => {
    let now = 0;
    const tracker = new SharpnessTracker(() => now);
    tracker.page(0, page(0, true));
    now = 100;
    tracker.motion(true);
    tracker.page(1, page(1, false));
    now = 220;
    tracker.motion(false);
    expect(tracker.samples).toEqual([]);
    now = 340;
    tracker.page(1, page(1, true));
    expect(tracker.samples).toEqual([240]);
  });

  it("counts 0 when pages were already sharp when the motion stopped", () => {
    let now = 0;
    const tracker = new SharpnessTracker(() => now);
    tracker.motion(true);
    tracker.page(0, page(0, true));
    now = 500;
    tracker.motion(true);
    now = 620;
    tracker.motion(false);
    expect(tracker.samples).toEqual([0]);
  });

  it("records one sample per stop and forgets pages that leave", () => {
    let now = 0;
    const tracker = new SharpnessTracker(() => now);
    tracker.page(0, page(0, false));
    tracker.motion(true);
    tracker.motion(false);
    tracker.page(0, null);
    expect(tracker.samples).toEqual([]);
    now = 50;
    tracker.page(2, page(2, true));
    tracker.page(2, page(2, true));
    expect(tracker.samples).toEqual([50]);
    expect(tracker.snapshot().map((p) => p.page)).toEqual([2]);
  });
});
