/** Messages between the scan client (main thread) and the scan worker. */
import type { Quad } from "./geometry";
import type { ScanFilter } from "./wasm";

/** A captured photo: a still (`Blob`, decoded in the worker) or pixels the main thread read. */
export type PhotoSource =
  | { readonly kind: "blob"; readonly blob: Blob }
  | { readonly kind: "rgba"; readonly width: number; readonly height: number; readonly rgba: ArrayBuffer };

export type WorkerRequest =
  | { type: "init"; reqId: number; simd: boolean }
  | { type: "detect"; reqId: number; width: number; height: number; rgba: ArrayBuffer }
  | { type: "still"; reqId: number; photo: PhotoSource; maxPixels: number; previewSide: number }
  | { type: "preview"; reqId: number; filter: ScanFilter }
  | { type: "keep"; reqId: number; quad: Quad; filter: ScanFilter; maxPixels: number; thumbSide: number }
  | { type: "drop"; reqId: number };

/** An image the worker could encode (`blob`) or, without OffscreenCanvas, raw pixels. */
export type Picture =
  | { readonly kind: "blob"; readonly blob: Blob; readonly width: number; readonly height: number }
  | { readonly kind: "rgba"; readonly rgba: ArrayBuffer; readonly width: number; readonly height: number };

export type WorkerResponse =
  | { type: "ready"; reqId: number; canvas: boolean }
  | { type: "detected"; reqId: number; quad: Quad | null; ms: number }
  | { type: "still"; reqId: number; width: number; height: number; quad: Quad | null; preview: Picture }
  | { type: "preview"; reqId: number; preview: Picture }
  | { type: "kept"; reqId: number; page: Picture; mime: "image/jpeg" | "image/png"; thumb: Picture; ms: number }
  | { type: "dropped"; reqId: number }
  | { type: "error"; reqId: number; message: string };

/** JPEG quality of colour and grey pages (black-and-white pages are PNG). */
export const PAGE_JPEG_QUALITY = 0.9;
