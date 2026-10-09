/// <reference lib="webworker" />
/**
 * PDF engine worker: EmbedPDF's PDFium build (WASM) runs here, off the UI thread.
 * - WASM is loaded from the app bundle (never a CDN).
 * - Font fallback is disabled: no network requests, ever.
 * - Renders are queued: visible pages before prefetch pages, newest first
 *   (= what the user is looking at now); queued renders can be cancelled.
 */
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import { type PdfDocumentObject, PdfErrorCode, type PdfErrorReason } from "@embedpdf/models";
import { init } from "@embedpdf/pdfium";
import wasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";
import { clampScale, type WorkerRequest, type WorkerResponse } from "./protocol";
import type { EngineErrorCode } from "./types";

declare const self: DedicatedWorkerGlobalScope;

type RenderJob = Extract<WorkerRequest, { type: "render" }>;

let nativePromise: Promise<PdfiumNative> | null = null;
const docs = new Map<string, PdfDocumentObject>();
const queue: RenderJob[] = [];
let draining = false;
let nextDocId = 1;

function native(): Promise<PdfiumNative> {
  nativePromise ??= (async () => {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`failed to load PDFium WASM (${response.status})`);
    const wasmBinary = await response.arrayBuffer();
    const module = await init({ wasmBinary });
    const engine = new PdfiumNative(module, { fontFallback: null });
    return engine;
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

/** Newest visible-page job, else newest prefetch job. */
function takeNext(): RenderJob | undefined {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (!queue[i]?.prefetch) return queue.splice(i, 1)[0];
  }
  return queue.pop();
}

/** Yields to the event loop between renders so cancels can arrive. */
function drain(): void {
  if (draining) return;
  draining = true;
  setTimeout(async () => {
    const job = takeNext();
    if (job) await runRender(job);
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
    case "open":
      void handleOpen(req);
      break;
    case "render":
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
