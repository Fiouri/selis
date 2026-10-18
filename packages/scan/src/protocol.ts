/** Messages between the scan client (main thread) and the scan worker. */
import type { Quad } from "./geometry";
import type { LiveFrame, PageEdits, ScanFilter } from "./wasm";

/** A captured photo: a still (`Blob`, decoded in the worker) or pixels the main thread read. */
export type PhotoSource =
  | { readonly kind: "blob"; readonly blob: Blob }
  | { readonly kind: "rgba"; readonly width: number; readonly height: number; readonly rgba: ArrayBuffer };

export type WorkerRequest =
  | { type: "init"; reqId: number; simd: boolean }
  | { type: "live"; reqId: number; width: number; height: number; rgba: ArrayBuffer; now: number }
  | { type: "resetAuto"; reqId: number }
  | { type: "still"; reqId: number; photo: PhotoSource; maxPixels: number; previewSide: number; quad: Quad | null }
  | { type: "preview"; reqId: number; filter: ScanFilter }
  | { type: "render"; reqId: number; edits: PageEdits; maxPixels: number }
  | { type: "keep"; reqId: number; edits: PageEdits; maxPixels: number; thumbSide: number }
  | { type: "drop"; reqId: number };

/** An image the worker could encode (`blob`) or, without OffscreenCanvas, raw pixels. */
export type Picture =
  | { readonly kind: "blob"; readonly blob: Blob; readonly width: number; readonly height: number }
  | { readonly kind: "rgba"; readonly rgba: ArrayBuffer; readonly width: number; readonly height: number };

export type WorkerResponse =
  | { type: "ready"; reqId: number; canvas: boolean }
  | ({ type: "live"; reqId: number; ms: number } & LiveFrame)
  | { type: "autoReset"; reqId: number }
  | {
      type: "still";
      reqId: number;
      width: number;
      height: number;
      quad: Quad | null;
      preview: Picture;
      /** The photo as a JPEG (at most `maxPixels`) when it came as pixels: kept to edit the page later. */
      source: Picture | null;
    }
  | { type: "preview"; reqId: number; preview: Picture }
  | { type: "rendered"; reqId: number; page: Picture }
  | { type: "kept"; reqId: number; page: Picture; mime: "image/jpeg" | "image/png"; thumb: Picture; ms: number }
  | { type: "dropped"; reqId: number }
  | { type: "error"; reqId: number; message: string };

/** JPEG quality of colour and grey pages (black-and-white pages are PNG). */
export const PAGE_JPEG_QUALITY = 0.9;
/** JPEG quality of a photo kept to edit its page later. */
export const SOURCE_JPEG_QUALITY = 0.92;
