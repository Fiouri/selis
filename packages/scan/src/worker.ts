/// <reference lib="webworker" />
/**
 * The scan worker (P4c, ADR 0016): page detection on live frames, and for each still the
 * page outline, a preview, filter previews and the straightened page — all in the scan
 * WebAssembly module, off the UI thread. The current still stays here (its pixels never go
 * back to the main thread) until it is kept or dropped.
 *
 * Decoding and encoding use OffscreenCanvas when the WebView has it in workers (Android,
 * iOS 16.4+, desktops); otherwise the client hands over pixels and gets pixels back.
 */
import baseUrl from "../wasm/selis_scan_base.wasm?url";
import simdUrl from "../wasm/selis_scan_simd.wasm?url";
import { PAGE_JPEG_QUALITY, type Picture, type PhotoSource, type WorkerRequest, type WorkerResponse } from "./protocol";
import { downscale } from "./pixels";
import { ScanModule } from "./wasm";

declare const self: DedicatedWorkerGlobalScope;

type Pixels = { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> };

const canvasInWorker = typeof OffscreenCanvas !== "undefined";
/** The module, loading since `init` (requests that arrive meanwhile wait for it). */
let module: Promise<ScanModule> | null = null;
/** The still being adjusted, its preview as shown, and that preview's unfiltered pixels. */
let still: { photo: Pixels; preview: Pixels } | null = null;

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

async function ready(): Promise<ScanModule> {
  if (!module) throw new Error("scan worker not initialised");
  return module;
}

async function pixelsOf(source: PhotoSource, maxPixels: number): Promise<Pixels> {
  if (source.kind === "rgba") return { width: source.width, height: source.height, rgba: new Uint8ClampedArray(source.rgba) };
  // Decoded at most `maxPixels` (a 50-MP sensor photo would not fit a phone's WebView).
  const probe = await createImageBitmap(source.blob, { imageOrientation: "from-image" });
  const scale = Math.min(1, Math.sqrt(maxPixels / (probe.width * probe.height)));
  const width = Math.max(1, Math.round(probe.width * scale));
  const height = Math.max(1, Math.round(probe.height * scale));
  let bitmap = probe;
  if (scale < 1) {
    probe.close();
    bitmap = await createImageBitmap(source.blob, { imageOrientation: "from-image", resizeWidth: width, resizeHeight: height, resizeQuality: "high" });
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { width, height, rgba: ctx.getImageData(0, 0, width, height).data };
}

/** Encodes pixels where the worker can; otherwise hands them back for the main thread. */
async function picture(pixels: Pixels, type: "image/jpeg" | "image/png", quality: number): Promise<{ picture: Picture; transfer: Transferable[] }> {
  if (!canvasInWorker) {
    return { picture: { kind: "rgba", rgba: pixels.rgba.buffer, width: pixels.width, height: pixels.height }, transfer: [pixels.rgba.buffer] };
  }
  const canvas = new OffscreenCanvas(pixels.width, pixels.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.putImageData(new ImageData(pixels.rgba, pixels.width, pixels.height), 0, 0);
  const blob = await canvas.convertToBlob({ type, quality });
  return { picture: { kind: "blob", blob, width: pixels.width, height: pixels.height }, transfer: [] };
}

function copyOf(pixels: Pixels): Pixels {
  return { width: pixels.width, height: pixels.height, rgba: new Uint8ClampedArray(pixels.rgba) };
}

async function handle(req: WorkerRequest): Promise<void> {
  switch (req.type) {
    case "init": {
      module ??= ScanModule.load(fetch(req.simd ? simdUrl : baseUrl));
      try {
        await module;
      } catch (err) {
        module = null;
        throw err;
      }
      post({ type: "ready", reqId: req.reqId, canvas: canvasInWorker });
      return;
    }
    case "detect": {
      const scan = await ready();
      const start = performance.now();
      const quad = scan.detect(new Uint8ClampedArray(req.rgba), req.width, req.height);
      post({ type: "detected", reqId: req.reqId, quad, ms: performance.now() - start });
      return;
    }
    case "still": {
      still = null;
      const photo = await pixelsOf(req.photo, req.maxPixels);
      const quad = (await ready()).findPage(photo.rgba, photo.width, photo.height);
      const preview = downscale(photo, req.previewSide);
      still = { photo, preview };
      const { picture: shown, transfer } = await picture(copyOf(preview), "image/jpeg", 0.85);
      post({ type: "still", reqId: req.reqId, width: photo.width, height: photo.height, quad, preview: shown }, transfer);
      return;
    }
    case "preview": {
      if (!still) throw new Error("no still");
      const filtered = copyOf(still.preview);
      (await ready()).filter(filtered.rgba, filtered.width, filtered.height, req.filter);
      const { picture: shown, transfer } = await picture(filtered, "image/jpeg", 0.85);
      post({ type: "preview", reqId: req.reqId, preview: shown }, transfer);
      return;
    }
    case "keep": {
      if (!still) throw new Error("no still");
      const start = performance.now();
      const { photo } = still;
      still = null;
      const page = (await ready()).straighten(photo.rgba, photo.width, photo.height, req.quad, req.maxPixels, req.filter);
      const thumb = downscale(page, req.thumbSide);
      const mime = req.filter === "bw" ? "image/png" : "image/jpeg";
      const encodedThumb = await picture(thumb, "image/jpeg", 0.8);
      const encodedPage = await picture(page, mime, PAGE_JPEG_QUALITY);
      post(
        { type: "kept", reqId: req.reqId, page: encodedPage.picture, mime, thumb: encodedThumb.picture, ms: performance.now() - start },
        [...encodedPage.transfer, ...encodedThumb.transfer],
      );
      return;
    }
    case "drop": {
      still = null;
      post({ type: "dropped", reqId: req.reqId });
      return;
    }
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  handle(req).catch((err: unknown) => {
    post({ type: "error", reqId: req.reqId, message: err instanceof Error ? err.message : String(err) });
  });
};
