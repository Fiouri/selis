import { describe, expect, it } from "vitest";
import { DEFAULT_RENDER_LIMITS, memoryTier, renderLimitsFor } from "./limits";

const GB = 1_000_000_000;

describe("render limits by device memory", () => {
  it("picks the tier from total RAM", () => {
    expect(memoryTier(12 * GB)).toBe("high");
    expect(memoryTier(8 * GB + 1)).toBe("high");
    expect(memoryTier(8 * GB)).toBe("mid");
    expect(memoryTier(7.42 * GB)).toBe("mid"); // Galaxy S23 ("8 GB") reports ~7.4 GB
    expect(memoryTier(6 * GB)).toBe("mid");
    expect(memoryTier(6 * GB - 1)).toBe("low");
    expect(memoryTier(3 * GB)).toBe("low");
  });

  it("falls back to the low tier when RAM is unknown or invalid", () => {
    expect(memoryTier(null)).toBe("low");
    expect(memoryTier(undefined)).toBe("low");
    expect(memoryTier(0)).toBe("low");
    expect(memoryTier(Number.NaN)).toBe("low");
    expect(DEFAULT_RENDER_LIMITS).toEqual(renderLimitsFor(null));
  });

  it("maps tiers to max render scale 2 / 1.5 / 1.25", () => {
    expect(renderLimitsFor(16 * GB).maxRenderScale).toBe(2);
    expect(renderLimitsFor(7 * GB).maxRenderScale).toBe(1.5);
    expect(renderLimitsFor(4 * GB).maxRenderScale).toBe(1.25);
  });

  it("shrinks every budget as memory goes down", () => {
    const [high, mid, low] = [renderLimitsFor(16 * GB), renderLimitsFor(7 * GB), renderLimitsFor(4 * GB)];
    for (const key of ["maxBitmapPixels", "cacheMaxPages", "cacheMaxBytes"] as const) {
      expect(high[key]).toBeGreaterThan(mid[key]);
      expect(mid[key]).toBeGreaterThan(low[key]);
    }
  });
});
