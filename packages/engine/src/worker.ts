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
import {
  type PdfAnnotationObject,
  type PdfBookmarkObject,
  type PdfDocumentObject,
  type PdfPageObject,
  PdfErrorCode,
  type PdfErrorReason,
  type PdfLinkTarget,
  type PdfTextRectObject,
  Rotation,
} from "@embedpdf/models";
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import wasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";
import fontUrl from "../assets/SelisSans-LatinGreek.ttf?url";
import { EmbeddedText, fromPdfAnnotation, TEXT_STAMP_PREFIX, toPdfAnnotation, toSignatureStamp } from "./annotations";
import { documentFields, flattenAll, pageWidgets, setField, toFormField } from "./forms";
import { applyPageOp, extractPages } from "./pages";
import { applyNightMode, type PageRect, rotateRect } from "./geometry";
import { documentPointer, imageRectsOnPage } from "./pdfium-objects";
import { clampScale, RAW_RGBA, thumbnailScale, type WorkerRequest, type WorkerResponse } from "./protocol";
import type { Annotation, EngineErrorCode, Glyph, OutlineItem, SearchHit, TextRun } from "./types";

declare const self: DedicatedWorkerGlobalScope;

type RenderJob = Extract<WorkerRequest, { type: "render" }>;
type ThumbnailJob = Extract<WorkerRequest, { type: "thumbnail" }>;
type Job = RenderJob | ThumbnailJob;

const WEBP_QUALITY = 0.8;
const JPEG_QUALITY = 0.85;

const ROTATIONS = [Rotation.Degree0, Rotation.Degree90, Rotation.Degree180, Rotation.Degree270] as const;
/** Pages searched between yields to the render queue. */
const SEARCH_BATCH = 8;

let nativePromise: Promise<PdfiumNative> | null = null;
let wasmModule: WrappedPdfiumModule | null = null;
let textStamps: EmbeddedText | null = null;
let fontPromise: Promise<Uint8Array> | null = null;
/** Image rects per page (page points, top-left), for night mode. */
const imageRectCache = new Map<string, PageRect[]>();
/** Searches cancelled by the client (checked between pages). */
const cancelledSearches = new Set<number>();
const docs = new Map<string, PdfDocumentObject>();
const queue: Job[] = [];
let draining = false;
let nextDocId = 1;

function native(): Promise<PdfiumNative> {
  nativePromise ??= (async () => {
    // Pointing emscripten at the bundled URL (instead of passing bytes) lets it use
    // WebAssembly.instantiateStreaming: compilation overlaps the read.
    const module = await init({ locateFile: () => wasmUrl });
    wasmModule = module;
    const engine = new PdfiumNative(module, { fontFallback: null });
    textStamps = new EmbeddedText(engine, module, embeddedFont);
    return engine;
  })();
  return nativePromise;
}

/** The typed-text font, fetched from the app bundle on first use. */
function embeddedFont(): Promise<Uint8Array> {
  fontPromise ??= (async () => {
    const response = await fetch(fontUrl);
    if (!response.ok) throw new Error(`font: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  })();
  return fontPromise;
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

/** Image bounds of a page, cached; empty if PDFium internals are unreachable (images then invert too). */
function imageRects(engine: PdfiumNative, doc: PdfDocumentObject, index: number): PageRect[] {
  const key = `${doc.id}:${index}`;
  let rects = imageRectCache.get(key);
  if (!rects) {
    const ptr = documentPointer(engine, doc.id);
    const page = doc.pages[index];
    rects = wasmModule && ptr !== null && page ? imageRectsOnPage(wasmModule, ptr, index, page.size) : [];
    imageRectCache.set(key, rects);
  }
  return rects;
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
      .renderPageRaw(doc, page, {
        scaleFactor: scale,
        dpr: 1,
        rotation: ROTATIONS[job.rotation],
        withAnnotations: true,
        withForms: true,
      })
      .toPromise();
    if (job.night) {
      const keep = imageRects(engine, doc, job.index).map((r) => {
        const turned = rotateRect(r, page.size, job.rotation);
        return { x: turned.x * scale, y: turned.y * scale, width: turned.width * scale, height: turned.height * scale };
      });
      applyNightMode(raw.data, raw.width, raw.height, keep);
    }
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
  // Software canvas: a GPU-backed 2D context in a worker keeps a GPU context alive in
  // the WebView renderer (~30 MB on Android) for one small image.
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context for thumbnail encoding");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  let blob = await canvas.convertToBlob({ type: "image/webp", quality: WEBP_QUALITY });
  // Unsupported types silently fall back to PNG (e.g. WKWebView); JPEG is far smaller.
  if (blob.type !== "image/webp") blob = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  // Release the backing store now instead of at the next GC.
  canvas.width = 0;
  canvas.height = 0;
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

function destinationPage(target: PdfLinkTarget | undefined): number | null {
  if (!target) return null;
  if (target.type === "destination") return target.destination.pageIndex;
  const action = target.action as { destination?: { pageIndex?: unknown } };
  return typeof action.destination?.pageIndex === "number" ? action.destination.pageIndex : null;
}

function toOutline(items: readonly PdfBookmarkObject[]): OutlineItem[] {
  return items.map((b) => ({
    title: b.title.trim(),
    page: destinationPage(b.target),
    children: toOutline(b.children ?? []),
  }));
}

async function handleOutline(req: Extract<WorkerRequest, { type: "outline" }>): Promise<void> {
  const doc = docs.get(req.docId);
  if (!doc) {
    post({ type: "error", reqId: req.reqId, code: "closed", message: "document not available" });
    return;
  }
  try {
    const result = (await (await native()).getBookmarks(doc).toPromise()) as { bookmarks: PdfBookmarkObject[] };
    post({ type: "outline", reqId: req.reqId, items: toOutline(result.bookmarks) });
  } catch (err) {
    post({ type: "error", reqId: req.reqId, ...toError(err) });
  }
}

function yieldToQueue(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function handleSearch(req: Extract<WorkerRequest, { type: "search" }>): Promise<void> {
  const doc = docs.get(req.docId);
  const query = req.query.trim();
  if (!doc || query === "") {
    post({ type: "searchDone", reqId: req.reqId, total: 0 });
    return;
  }
  try {
    const engine = await native();
    let total = 0;
    for (const page of doc.pages) {
      if (cancelledSearches.delete(req.reqId) || !docs.has(req.docId)) {
        post({ type: "error", reqId: req.reqId, code: "cancelled", message: "search cancelled" });
        return;
      }
      const results = await engine.searchInPage(doc, page, query, 0).toPromise();
      if (results.length > 0) {
        const hits: SearchHit[] = results.map((r) => ({
          rects: r.rects.map((rect) => ({ x: rect.origin.x, y: rect.origin.y, width: rect.size.width, height: rect.size.height })),
        }));
        total += hits.length;
        post({ type: "searchHits", reqId: req.reqId, page: page.index, hits });
      }
      // Let visible-page renders (and cancels) through while a long document is searched.
      if (page.index % SEARCH_BATCH === SEARCH_BATCH - 1) await yieldToQueue();
    }
    post({ type: "searchDone", reqId: req.reqId, total });
  } catch (err) {
    post({ type: "error", reqId: req.reqId, ...toError(err) });
  }
}

async function handleText(req: Extract<WorkerRequest, { type: "text" }>): Promise<void> {
  const doc = docs.get(req.docId);
  const page = doc?.pages[req.index];
  if (!doc || !page) {
    post({ type: "error", reqId: req.reqId, code: "closed", message: "document or page not available" });
    return;
  }
  try {
    const rects = (await (await native()).getPageTextRects(doc, page).toPromise()) as PdfTextRectObject[];
    const runs: TextRun[] = rects
      .filter((r) => r.content.trim() !== "")
      .map((r) => ({
        x: r.rect.origin.x,
        y: r.rect.origin.y,
        width: r.rect.size.width,
        height: r.rect.size.height,
        text: r.content,
        fontSize: r.font.size,
      }));
    post({ type: "text", reqId: req.reqId, runs });
  } catch (err) {
    post({ type: "error", reqId: req.reqId, ...toError(err) });
  }
}

type DocRequest = Extract<WorkerRequest, { docId: string }>;

/** The open document (and page) a request names; posts a "closed" error if gone. */
function target(req: DocRequest, index?: number): { doc: PdfDocumentObject; page: PdfPageObject | undefined } | null {
  const doc = docs.get(req.docId);
  const page = index === undefined ? undefined : doc?.pages[index];
  if (!doc || (index !== undefined && !page)) {
    post({ type: "error", reqId: req.reqId, code: "closed", message: "document or page not available" });
    return null;
  }
  return { doc, page };
}

async function handleGlyphs(req: Extract<WorkerRequest, { type: "glyphs" }>): Promise<void> {
  const t = target(req, req.index);
  if (!t?.page) return;
  try {
    const geometry = await (await native()).getPageGeometry(t.doc, t.page).toPromise();
    const glyphs: Glyph[] = [];
    geometry.runs.forEach((run, r) => {
      for (const g of run.glyphs) {
        // flags: 1 = space, 2 = empty (no box).
        const empty = g.flags === 2;
        glyphs.push({ x: g.x, y: g.y, width: empty ? 0 : g.width, height: empty ? 0 : g.height, run: r, space: g.flags === 1 });
      }
    });
    post({ type: "glyphs", reqId: req.reqId, glyphs });
  } catch (err) {
    post({ type: "error", reqId: req.reqId, ...toError(err) });
  }
}

async function pageAnnotations(engine: PdfiumNative, doc: PdfDocumentObject, page: PdfPageObject): Promise<Annotation[]> {
  const raw = (await engine.getPageAnnotations(doc, page).toPromise()) as PdfAnnotationObject[];
  const ours = raw.filter((a) => a.id.startsWith(TEXT_STAMP_PREFIX)).map((a) => a.id);
  const styles = textStamps?.styles(doc, page, ours);
  return raw.map((a) => fromPdfAnnotation(a, styles?.get(a.id) ?? null));
}

async function handleAnnotations(req: Extract<WorkerRequest, { type: "annotations" }>): Promise<void> {
  const t = target(req, req.index);
  if (!t?.page) return;
  try {
    post({ type: "annotations", reqId: req.reqId, items: await pageAnnotations(await native(), t.doc, t.page) });
  } catch (err) {
    post({ type: "error", reqId: req.reqId, ...toError(err) });
  }
}

async function removeById(engine: PdfiumNative, doc: PdfDocumentObject, page: PdfPageObject, id: string): Promise<boolean> {
  const raw = (await engine.getPageAnnotations(doc, page).toPromise()) as PdfAnnotationObject[];
  const found = raw.find((a) => a.id === id);
  if (!found) return false;
  return (await engine.removePageAnnotation(doc, page, found).toPromise()) as boolean;
}

async function handleAddAnnotation(req: Extract<WorkerRequest, { type: "addAnnotation" }>): Promise<void> {
  const a = req.annotation;
  const t = target(req, a.page);
  if (!t?.page) return;
  try {
    const engine = await native();
    let stored: Annotation;
    if (a.kind === "other") throw new Error("cannot create an annotation of an unknown kind");
    if (a.kind === "text") {
      if (!textStamps) throw new Error("engine not ready");
      stored = { ...a, rect: await textStamps.create(t.doc, t.page, a) };
    } else if (a.kind === "signature") {
      if (!a.image) throw new Error("a signature needs its image");
      await removeById(engine, t.doc, t.page, a.id);
      await engine.createPageAnnotation(t.doc, t.page, toSignatureStamp(a), { data: a.image.bytes }).toPromise();
      // The image stays with the caller (undo); the worker does not keep a copy.
      stored = { ...a, image: null };
    } else {
      await removeById(engine, t.doc, t.page, a.id);
      await engine.createPageAnnotation(t.doc, t.page, toPdfAnnotation(a)).toPromise();
      stored = a;
    }
    post({ type: "annotation", reqId: req.reqId, annotation: stored });
  } catch (err) {
    post({ type: "error", reqId: req.reqId, ...toError(err) });
  }
}

async function handleRemoveAnnotation(req: Extract<WorkerRequest, { type: "removeAnnotation" }>): Promise<void> {
  const t = target(req, req.index);
  if (!t?.page) return;
  try {
    post({ type: "removed", reqId: req.reqId, removed: await removeById(await native(), t.doc, t.page, req.id) });
  } catch (err) {
    post({ type: "error", reqId: req.reqId, ...toError(err) });
  }
}

async function handleSave(req: Extract<WorkerRequest, { type: "save" }>): Promise<void> {
  const t = target(req);
  if (!t) return;
  try {
    const bytes = (await (await native()).saveAsCopy(t.doc).toPromise()) as ArrayBuffer;
    post({ type: "saved", reqId: req.reqId, bytes }, [bytes]);
  } catch (err) {
    post({ type: "error", reqId: req.reqId, ...toError(err) });
  }
}

async function handleFormFields(req: Extract<WorkerRequest, { type: "formFields" }>): Promise<void> {
  const t = target(req, req.index);
  if (!t?.page) return;
  try {
    const list = await pageWidgets(await native(), t.doc, t.page);
    post({ type: "formFields", reqId: req.reqId, fields: list.map(toFormField) });
  } catch (err) {
    post({ type: "error", reqId: req.reqId, ...toError(err) });
  }
}

async function handleDocumentFields(req: Extract<WorkerRequest, { type: "documentFields" }>): Promise<void> {
  const t = target(req);
  if (!t) return;
  try {
    const engine = await native();
    if (!wasmModule) throw new Error("engine not ready");
    post({ type: "formFields", reqId: req.reqId, fields: await documentFields(engine, wasmModule, t.doc) });
  } catch (err) {
    post({ type: "error", reqId: req.reqId, ...toError(err) });
  }
}

async function handleSetFormField(req: Extract<WorkerRequest, { type: "setFormField" }>): Promise<void> {
  const t = target(req, req.index);
  if (!t?.page) return;
  try {
    const engine = await native();
    if (!textStamps) throw new Error("engine not ready");
    const fields = await setField(engine, textStamps, t.doc, t.page, req.id, req.change);
    post({ type: "formFields", reqId: req.reqId, fields });
  } catch (err) {
    post({ type: "error", reqId: req.reqId, ...toError(err) });
  }
}

async function handleFlatten(req: Extract<WorkerRequest, { type: "flatten" }>): Promise<void> {
  const t = target(req);
  if (!t) return;
  try {
    const pages = await flattenAll(await native(), t.doc);
    for (const key of imageRectCache.keys()) if (key.startsWith(`${t.doc.id}:`)) imageRectCache.delete(key);
    post({ type: "flattened", reqId: req.reqId, pages });
  } catch (err) {
    post({ type: "error", reqId: req.reqId, ...toError(err) });
  }
}

/** Swaps the open document for `bytes` (same document id for the client). */
async function replaceDocument(docId: string, current: PdfDocumentObject, bytes: ArrayBuffer): Promise<PdfDocumentObject> {
  const engine = await native();
  const fresh = await engine.openDocumentBuffer({ id: `${docId}-r${nextDocId++}`, content: bytes }).toPromise();
  textStamps?.forget(current.id);
  for (const key of imageRectCache.keys()) if (key.startsWith(`${current.id}:`)) imageRectCache.delete(key);
  await engine.closeDocument(current).toPromise();
  docs.set(docId, fresh);
  return fresh;
}

const pageSizes = (doc: PdfDocumentObject) => doc.pages.map((p) => ({ width: p.size.width, height: p.size.height }));

async function handleReload(req: Extract<WorkerRequest, { type: "reload" }>): Promise<void> {
  const t = target(req);
  if (!t) return;
  try {
    const fresh = await replaceDocument(req.docId, t.doc, req.bytes);
    post({ type: "reloaded", reqId: req.reqId, pages: pageSizes(fresh) });
  } catch (err) {
    post({ type: "error", reqId: req.reqId, ...toError(err) });
  }
}

async function handleEditPages(req: Extract<WorkerRequest, { type: "editPages" }>): Promise<void> {
  const t = target(req);
  if (!t) return;
  try {
    const engine = await native();
    if (!wasmModule) throw new Error("engine not ready");
    const before = (await engine.saveAsCopy(t.doc).toPromise()) as ArrayBuffer;
    const after = await applyPageOp(engine, wasmModule, before, req.op);
    const fresh = await replaceDocument(req.docId, t.doc, after);
    post({ type: "pagesEdited", reqId: req.reqId, pages: pageSizes(fresh), before }, [before]);
  } catch (err) {
    post({ type: "error", reqId: req.reqId, ...toError(err) });
  }
}

async function handleExtract(req: Extract<WorkerRequest, { type: "extract" }>): Promise<void> {
  const t = target(req);
  if (!t) return;
  try {
    const engine = await native();
    const current = (await engine.saveAsCopy(t.doc).toPromise()) as ArrayBuffer;
    const bytes = await extractPages(engine, current, req.indices);
    post({ type: "extracted", reqId: req.reqId, bytes }, [bytes]);
  } catch (err) {
    post({ type: "error", reqId: req.reqId, ...toError(err) });
  }
}

async function handleAppearance(req: Extract<WorkerRequest, { type: "appearance" }>): Promise<void> {
  const t = target(req, req.index);
  if (!t?.page) return;
  try {
    const engine = await native();
    const raw = (await engine.getPageAnnotations(t.doc, t.page).toPromise()) as PdfAnnotationObject[];
    const found = raw.find((a) => a.id === req.id);
    if (!found) throw new Error("annotation not found");
    const bytes = await engine.exportAnnotationAppearanceAsPdf(t.doc, t.page, found).toPromise();
    post({ type: "appearance", reqId: req.reqId, image: { mime: "application/pdf", bytes } }, [bytes]);
  } catch (err) {
    post({ type: "error", reqId: req.reqId, ...toError(err) });
  }
}

async function handleClose(req: Extract<WorkerRequest, { type: "close" }>): Promise<void> {
  const doc = docs.get(req.docId);
  docs.delete(req.docId);
  for (const key of imageRectCache.keys()) if (key.startsWith(`${req.docId}:`)) imageRectCache.delete(key);
  for (let i = queue.length - 1; i >= 0; i--) {
    const job = queue[i];
    if (job && job.docId === req.docId) {
      queue.splice(i, 1);
      post({ type: "error", reqId: job.reqId, code: "cancelled", message: "document closed" });
    }
  }
  textStamps?.forget(req.docId);
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
      } else {
        // Not a queued render: a running search stops before its next page.
        cancelledSearches.add(req.reqId);
      }
      break;
    }
    case "outline":
      void handleOutline(req);
      break;
    case "search":
      void handleSearch(req);
      break;
    case "text":
      void handleText(req);
      break;
    case "glyphs":
      void handleGlyphs(req);
      break;
    case "annotations":
      void handleAnnotations(req);
      break;
    case "addAnnotation":
      void handleAddAnnotation(req);
      break;
    case "removeAnnotation":
      void handleRemoveAnnotation(req);
      break;
    case "save":
      void handleSave(req);
      break;
    case "formFields":
      void handleFormFields(req);
      break;
    case "documentFields":
      void handleDocumentFields(req);
      break;
    case "setFormField":
      void handleSetFormField(req);
      break;
    case "flatten":
      void handleFlatten(req);
      break;
    case "reload":
      void handleReload(req);
      break;
    case "editPages":
      void handleEditPages(req);
      break;
    case "extract":
      void handleExtract(req);
      break;
    case "appearance":
      void handleAppearance(req);
      break;
    case "close":
      void handleClose(req);
      break;
  }
};
