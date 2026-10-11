import type { QuarterTurns } from "./geometry";
import type { EngineErrorCode, OutlineItem, PageSize, SearchHit, TextRun } from "./types";

/** Max pixels per rendered bitmap (≈ 4096²): bounds WebView memory on mobile. */
export const MAX_BITMAP_PIXELS = 16_777_216;

export type WorkerRequest =
  | { type: "warmup"; reqId: number }
  | { type: "open"; reqId: number; bytes: ArrayBuffer; password?: string }
  | {
      type: "render";
      reqId: number;
      docId: string;
      index: number;
      scale: number;
      prefetch: boolean;
      rotation: QuarterTurns;
      night: boolean;
    }
  | { type: "outline"; reqId: number; docId: string }
  | { type: "search"; reqId: number; docId: string; query: string }
  | { type: "text"; reqId: number; docId: string; index: number }
  | { type: "thumbnail"; reqId: number; docId: string; index: number; maxWidth: number; maxHeight: number }
  | { type: "cancel"; reqId: number }
  | { type: "close"; reqId: number; docId: string };

export type WorkerResponse =
  | { type: "ready"; reqId: number }
  | { type: "opened"; reqId: number; docId: string; pages: PageSize[]; title: string | null }
  | { type: "rendered"; reqId: number; width: number; height: number; pixels: ArrayBuffer }
  | { type: "thumbnail"; reqId: number; width: number; height: number; mime: string; bytes: ArrayBuffer }
  | { type: "outline"; reqId: number; items: OutlineItem[] }
  /** Progress of a search (not its final reply): hits on one page. */
  | { type: "searchHits"; reqId: number; page: number; hits: SearchHit[] }
  | { type: "searchDone"; reqId: number; total: number }
  | { type: "text"; reqId: number; runs: TextRun[] }
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

/** Thumbnail `mime` when the worker could not encode: width × height RGBA pixels. */
export const RAW_RGBA = "application/x-selis-rgba";

/** Largest scale at which the page fits in a maxWidth × maxHeight pixel box. */
export function thumbnailScale(page: PageSize, maxWidth: number, maxHeight: number): number {
  if (page.width <= 0 || page.height <= 0 || maxWidth <= 0 || maxHeight <= 0) return 0;
  return Math.min(maxWidth / page.width, maxHeight / page.height);
}
