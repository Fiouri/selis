/**
 * Render limits chosen from device RAM, so a 1000-page document stays well
 * inside the WebView memory budget on every tier (docs/spike-p0.md). Pages are
 * always drawn at the full device pixel ratio; above `maxBitmapPixels` the viewer
 * tiles the visible area instead of lowering the resolution (ADR 0002 amendment).
 */
export type RenderLimits = {
  /** Max pixels of a single bitmap: larger pages are tiled (bounds memory at high zoom). */
  readonly maxBitmapPixels: number;
  /** Rendered-page cache bound: number of pages… */
  readonly cacheMaxPages: number;
  /** …and total bytes (RGBA = 4 bytes per pixel). */
  readonly cacheMaxBytes: number;
};

export type MemoryTier = "high" | "mid" | "low";

/** Decimal gigabyte: platforms report usable RAM, a bit below the marketed size. */
const GB = 1_000_000_000;
const MB = 1024 * 1024;

const TIERS: Record<MemoryTier, RenderLimits> = {
  high: { maxBitmapPixels: 16_000_000, cacheMaxPages: 12, cacheMaxBytes: 96 * MB },
  mid: { maxBitmapPixels: 8_000_000, cacheMaxPages: 8, cacheMaxBytes: 48 * MB },
  low: { maxBitmapPixels: 6_000_000, cacheMaxPages: 4, cacheMaxBytes: 24 * MB },
};

/** > 8 GB → high, 6–8 GB → mid, < 6 GB (or unknown) → low. */
export function memoryTier(totalMemoryBytes: number | null | undefined): MemoryTier {
  if (totalMemoryBytes === null || totalMemoryBytes === undefined || !Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return "low";
  }
  if (totalMemoryBytes > 8 * GB) return "high";
  if (totalMemoryBytes >= 6 * GB) return "mid";
  return "low";
}

export function renderLimitsFor(totalMemoryBytes: number | null | undefined): RenderLimits {
  return TIERS[memoryTier(totalMemoryBytes)];
}

/** Conservative default until the device has been queried. */
export const DEFAULT_RENDER_LIMITS: RenderLimits = TIERS.low;
