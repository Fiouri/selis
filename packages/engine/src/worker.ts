/// <reference lib="webworker" />
/**
 * PDF engine worker: EmbedPDF's PDFium build (WASM) runs here, off the UI thread.
 * - WASM is loaded from the app bundle (never a CDN).
 * - Font fallback is disabled: no network requests, ever.
 * - Renders are queued: visible pages before prefetch pages and thumbnails, in
 *   request order. Pages that scroll away cancel their queued renders, so the
 *   queue only holds what is (about to be) on screen.
 * - Thumbnails are encoded here (OffscreenCanvas → WebP, JPEG where the WebView
 *   cannot encode WebP), so the UI thread only receives a small file. WebKits
 *   without OffscreenCanvas in workers (iOS < 16.4) get raw pixels instead and
 *   the client encodes the small image.
 */
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import { type PdfDocumentObject, PdfErrorCode, type PdfErrorReason } from "@embedpdf/models";
import { init } from "@embedpdf/pdfium";
import wasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";
import { clampScale, RAW_RGBA, thumbnailScale, type WorkerRequest, type WorkerResponse } from "./protocol";
import type { EngineErrorCode } from "./types";

declare const self: DedicatedWorkerGlobalScope;

type RenderJob = Extract<WorkerRequest, { type: "render" }>;
type ThumbnailJob = Extract<WorkerRequest, { type: "thumbnail" }>;
type Job = RenderJob | ThumbnailJob;

const WEBP_QUALITY = 0.8;
const JPEG_QUALITY = 0.85;

let nativePromise: Promise<PdfiumNative> | null = null;
const docs = new Map<string, PdfDocumentObject>();
const queue: Job[] = [];
let draining = false;
let nextDocId = 1;

function native(): Promise<PdfiumNative> {
  nativePromise ??= (async () => {
    // Pointing emscripten at the bundled URL (instead of passing bytes) lets it use
    // WebAssembly.instantiateStreaming: compilation overlaps the read.
    const module = await init({ locateFile: () => wasmUrl });
    return new PdfiumNative(module, { fontFallback: null });
  })();
  return nativePromise;
}

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

function isPdfErrorReason(value: unknown): value is PdfErrorReason {
  return typeof value === "object" && value !== null && "code" in value && typeof value.code === "number";
}

function toError(err: unknown): { code: EngineErrorCode; message: string } {
  const reason = typeof err === "object" && err !== null && "reason" in err ? err.reason : err;
  if (isPdfErrorReason(reason)) {
    switch (reason.code) {
      case PdfErrorCode.Password:
        return { code: "password", message: reason.message };
      case PdfErrorCode.WrongFormat:
      case PdfErrorCode.LoadDoc:
        return { code: "format", message: reason.message };
      case PdfErrorCode.Cancelled:
        return { code: "cancelled", message: reason.message };
      default:
        return { code: "unknown", message: reason.message };
    }
  }
  return { code: "unknown", message: err instanceof Error ? err.message : String(err) };
}

async function handleOpen(req: Extract<WorkerRequest, { type: "open" }>): Promise<void> {
  let engine: PdfiumNative;
  try {
    engine = await native();
  } catch (err) {
    post({ type: "error", reqId: req.reqId, code: "init", message: toError(err).message });
    return;
  }
  try {
    const id = `doc-${nextDocId++}`;
    const doc = await engine
      .openDocumentBuffer(
        { id, content: req.bytes },
        req.password === undefined ? {} : { password: req.password },
      )
      .toPromise();
    docs.set(id, doc);
    let title: string | null = null;
    try {
      title = (await engine.getMetadata(doc).toPromise()).title?.trim() || null;
    } catch {
      title = null; // Metadata is optional; a broken /Info must not block viewing.
    }
    post({
      type: "opened",
      reqId: req.reqId,
      docId: id,
      pages: doc.pages.map((p) => ({ width: p.size.width, height: p.size.height })),
      title,
    });
  } catch (err) {
    post({ type: "error", reqId: req.reqId, ...toError(err) });
  }
}

async function runRender(job: RenderJob): Promise<void> {
  const doc = docs.get(job.docId);
  const page = doc?.pages[job.index];
  if (!doc || !page) {
    post({ type: "error", reqId: job.reqId, code: "closed", message: "document or page not available" });
    return;
  }
  const scale = clampScale(page.size, job.scale);
  if (scale <= 0) {
    post({ type: "error", reqId: job.reqId, code: "unknown", message: "invalid scale" });
    return;
  }
  try {
    const engine = await native();
    const raw = await engine
      .renderPageRaw(doc, page, { scaleFactor: scale, dpr: 1, withAnnotations: true, withForms: true })
      .toPromise();
    // Raw RGBA, transferred (zero-copy). ImageBitmaps created here would each pin a
    // shared-memory/GPU resource in the WebView until GC; plain buffers do not.
    const pixels = raw.data.buffer;
    post({ type: "rendered", reqId: job.reqId, width: raw.width, height: raw.height, pixels }, [pixels]);
  } catch (err) {
    post({ type: "error", reqId: job.reqId, ...toError(err) });
  }
}

async function encodeImage(width: number, height: number, data: Uint8ClampedArray): Promise<{ mime: string; bytes: ArrayBuffer }> {
  if (typeof OffscreenCanvas === "undefined") return { mime: RAW_RGBA, bytes: data.slice().buffer };
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context for thumbnail encoding");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  let blob = await canvas.convertToBlob({ type: "image/webp", quality: WEBP_QUALITY });
  // Unsupported types silently fall back to PNG (e.g. WKWebView); JPEG is far smaller.
  if (blob.type !== "image/webp") blob = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  return { mime: blob.type, bytes: await blob.arrayBuffer() };
}

async function runThumbnail(job: ThumbnailJob): Promise<void> {
  const doc = docs.get(job.docId);
  const page = doc?.pages[job.index];
  if (!doc || !page) {
    post({ type: "error", reqId: job.reqId, code: "closed", message: "document or page not available" });
    return;
  }
  const scale = thumbnailScale(page.size, job.maxWidth, job.maxHeight);
  if (scale <= 0) {
    post({ type: "error", reqId: job.reqId, code: "unknown", message: "invalid thumbnail size" });
    return;
  }
  try {
    const engine = await native();
    const raw = await engine
      .renderPageRaw(doc, page, { scaleFactor: scale, dpr: 1, withAnnotations: true, withForms: true })
      .toPromise();
    const { mime, bytes } = await encodeImage(raw.width, raw.height, raw.data);
    post({ type: "thumbnail", reqId: job.reqId, width: raw.width, height: raw.height, mime, bytes }, [bytes]);
  } catch (err) {
    post({ type: "error", reqId: job.reqId, ...toError(err) });
  }
}

/** Oldest visible-page job, else the oldest prefetch or thumbnail job. */
function takeNext(): Job | undefined {
  const visible = queue.findIndex((job) => job.type === "render" && !job.prefetch);
  return queue.splice(visible >= 0 ? visible : 0, 1)[0];
}

/** Yields to the event loop between renders so cancels can arrive. */
function drain(): void {
  if (draining) return;
  draining = true;
  setTimeout(async () => {
    const job = takeNext();
    if (job?.type === "render") await runRender(job);
    else if (job) await runThumbnail(job);
    draining = false;
    if (queue.length > 0) drain();
  }, 0);
}

async function handleClose(req: Extract<WorkerRequest, { type: "close" }>): Promise<void> {
  const doc = docs.get(req.docId);
  docs.delete(req.docId);
  for (let i = queue.length - 1; i >= 0; i--) {
    const job = queue[i];
    if (job && job.docId === req.docId) {
      queue.splice(i, 1);
      post({ type: "error", reqId: job.reqId, code: "cancelled", message: "document closed" });
    }
  }
  if (doc) {
    try {
      await (await native()).closeDocument(doc).toPromise();
    } catch {
      // Already gone; nothing else to free.
    }
  }
  post({ type: "closed", reqId: req.reqId });
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  switch (req.type) {
    case "warmup":
      void (async () => {
        try {
          await native();
          post({ type: "ready", reqId: req.reqId });
        } catch (err) {
          post({ type: "error", reqId: req.reqId, code: "init", message: toError(err).message });
        }
      })();
      break;
    case "open":
      void handleOpen(req);
      break;
    case "render":
    case "thumbnail":
      queue.push(req);
      drain();
      break;
    case "cancel": {
      const idx = queue.findIndex((j) => j.reqId === req.reqId);
      if (idx >= 0) {
        queue.splice(idx, 1);
        post({ type: "error", reqId: req.reqId, code: "cancelled", message: "cancelled" });
      }
      break;
    }
    case "close":
      void handleClose(req);
      break;
  }
};
