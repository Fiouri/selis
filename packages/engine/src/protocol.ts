import type { EngineErrorCode, PageSize } from "./types";

/** Max pixels per rendered bitmap (≈ 4096²): bounds WebView memory on mobile. */
export const MAX_BITMAP_PIXELS = 16_777_216;

export type WorkerRequest =
  | { type: "open"; reqId: number; bytes: ArrayBuffer; password?: string }
  | { type: "render"; reqId: number; docId: string; index: number; scale: number; prefetch: boolean }
  | { type: "cancel"; reqId: number }
  | { type: "close"; reqId: number; docId: string };

export type WorkerResponse =
  | { type: "opened"; reqId: number; docId: string; pages: PageSize[]; title: string | null }
  | { type: "rendered"; reqId: number; width: number; height: number; pixels: ArrayBuffer }
  | { type: "closed"; reqId: number }
  | { type: "error"; reqId: number; code: EngineErrorCode; message: string };

/**
 * Clamps a render scale so the bitmap stays within the pixel budget.
 * Returns the effective scale (never above the requested one).
 */
export function clampScale(page: PageSize, scale: number, maxPixels = MAX_BITMAP_PIXELS): number {
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  const pixels = page.width * scale * page.height * scale;
  if (pixels <= maxPixels) return scale;
  return Math.sqrt(maxPixels / (page.width * page.height));
}
