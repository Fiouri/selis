import { DEFAULT_RENDER_LIMITS, type RenderLimits } from "./limits";
import { LruCache } from "./lru";
import { clampScale, RAW_RGBA, type WorkerRequest, type WorkerResponse } from "./protocol";
import type { QuarterTurns } from "./geometry";
import {
  type Annotation,
  type DocHandle,
  EngineError,
  type ExportedImage,
  type ImagePdfSession,
  type OpenOptions,
  type PageSize,
  type PdfEngine,
  type RenderOptions,
  type SearchHit,
  type SearchOptions,
  type TextRun,
  type Thumbnail,
} from "./types";

/** Text runs of this many pages stay cached per engine (selection layers re-mount on scroll). */
const TEXT_CACHE_PAGES = 24;

type Pending = {
  resolve: (msg: WorkerResponse) => void;
  reject: (err: EngineError) => void;
};

/** Minimal surface of `Worker` used by the client (lets tests inject a fake). */
export type WorkerLike = {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};

/** Main-thread client for the engine worker. */
export class WorkerPdfEngine implements PdfEngine {
  private readonly worker: WorkerLike;
  private readonly pending = new Map<number, Pending>();
  /** Search requests: progress messages before the final reply. */
  private readonly progress = new Map<number, (page: number, hits: SearchHit[]) => void>();
  private readonly textCache = new LruCache<string, TextRun[]>(TEXT_CACHE_PAGES, Number.MAX_SAFE_INTEGER, () => 1);
  private nextReqId = 1;
  private destroyed = false;
  private currentLimits: RenderLimits;
  /** Recently rendered pages (doc:page:scale → RGBA), bounded by count and bytes. */
  private cache: LruCache<string, ImageData>;

  constructor(worker: WorkerLike, limits: RenderLimits = DEFAULT_RENDER_LIMITS) {
    this.worker = worker;
    this.currentLimits = limits;
    this.cache = WorkerPdfEngine.makeCache(limits);
    this.worker.onmessage = (event) => this.onMessage(event.data);
    this.worker.onerror = (event) => this.failAll(new EngineError("init", event.message || "engine worker crashed"));
  }

  async createImagePdf(): Promise<ImagePdfSession> {
    const begun = await this.request<Extract<WorkerResponse, { type: "imagesBuilder" }>>((reqId) => ({ type: "imagesBegin", reqId }));
    const builder = begun.builder;
    let over = false;
    const ensure = () => {
      if (over) throw new EngineError("closed", "image session is over");
    };
    return {
      add: async (bytes, mime, size) => {
        ensure();
        const msg = await this.request<Extract<WorkerResponse, { type: "imagesAdded" }>>(
          (reqId) => ({ type: "imagesAdd", reqId, builder, bytes, mime, size }),
          [bytes],
        );
        return msg.pages;
      },
      addSheet: async (width, height, items) => {
        ensure();
        const msg = await this.request<Extract<WorkerResponse, { type: "imagesAdded" }>>(
          (reqId) => ({ type: "imagesAddSheet", reqId, builder, width, height, items: [...items] }),
          items.map((i) => i.bytes),
        );
        return msg.pages;
      },
      finish: async () => {
        ensure();
        over = true;
        const msg = await this.request<Extract<WorkerResponse, { type: "imagesDone" }>>((reqId) => ({ type: "imagesFinish", reqId, builder }));
        return msg.bytes;
      },
      discard: async () => {
        if (over) return;
        over = true;
        await this.request<Extract<WorkerResponse, { type: "closed" }>>((reqId) => ({ type: "imagesDiscard", reqId, builder }));
      },
    };
  }

  async open(bytes: ArrayBuffer, options: OpenOptions = {}): Promise<DocHandle> {
    const msg = await this.request<Extract<WorkerResponse, { type: "opened" }>>(
      (reqId) =>
        options.password === undefined
          ? { type: "open", reqId, bytes }
          : { type: "open", reqId, bytes, password: options.password },
      [bytes],
    );
    return this.makeHandle(msg.docId, msg.pages, msg.title);
  }

  private warming: Promise<void> | null = null;

  warmUp(): Promise<void> {
    this.warming ??= (async () => {
      try {
        await this.request((reqId) => ({ type: "warmup", reqId }));
      } catch (err) {
        this.warming = null; // allow a retry
        throw err;
      }
    })();
    return this.warming;
  }

  get limits(): RenderLimits {
    return this.currentLimits;
  }

  /** Applies new limits; the page cache is rebuilt (and emptied) with the new bounds. */
  setLimits(limits: RenderLimits): void {
    this.currentLimits = limits;
    this.cache = WorkerPdfEngine.makeCache(limits);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.worker.terminate();
    this.cache.clear();
    this.failAll(new EngineError("closed", "engine destroyed"));
  }

  private static makeCache(limits: RenderLimits): LruCache<string, ImageData> {
    return new LruCache<string, ImageData>(limits.cacheMaxPages, limits.cacheMaxBytes, (image) => image.data.byteLength);
  }

  private makeHandle(docId: string, pages: PageSize[], title: string | null): DocHandle {
    let closed = false;
    const freeze = (list: readonly PageSize[]) => Object.freeze(list.map((p) => Object.freeze({ ...p })));
    let frozenPages = freeze(pages);
    let structure = 0;
    const revisions = new Map<number, number>();
    const listeners = new Set<(index: number) => void>();
    const structureListeners = new Set<() => void>();
    /** The page list changed: every cached bitmap and text run of the document is stale. */
    const restructured = (next: readonly PageSize[]) => {
      frozenPages = freeze(next);
      structure++;
      revisions.clear();
      this.cache.deleteWhere((key) => key.startsWith(`${docId}:`));
      this.textCache.deleteWhere((key) => key.startsWith(`${docId}:`));
      for (const listener of structureListeners) listener();
    };
    const checkIndex = (index: number) => {
      if (!Number.isInteger(index) || index < 0 || index >= frozenPages.length) {
        throw new RangeError(`page index ${index} out of range`);
      }
    };
    const ensureOpen = () => {
      if (closed) throw new EngineError("closed", "document is closed");
    };
    /** A page changed: its cached bitmaps are stale, and viewers redraw it. */
    const changed = (index: number) => {
      this.cache.deleteWhere((key) => key.startsWith(`${docId}:${index}:`));
      revisions.set(index, (revisions.get(index) ?? 0) + 1);
      for (const listener of listeners) listener(index);
    };
    const handle: DocHandle = {
      id: docId,
      get pageCount() {
        return frozenPages.length;
      },
      get pages() {
        return frozenPages;
      },
      title,
      renderPageImage: (index, scale, options: RenderOptions = {}) => {
        if (closed) return Promise.reject(new EngineError("closed", "document is closed"));
        if (!Number.isInteger(index) || index < 0 || index >= frozenPages.length) {
          return Promise.reject(new RangeError(`page index ${index} out of range`));
        }
        const page = frozenPages[index] as PageSize;
        // A tile is small by construction: the page-wide pixel budget would blur it.
        const effective = options.rect ? scale : clampScale(page, scale, this.currentLimits.maxBitmapPixels);
        return this.render(docId, index, effective, options);
      },
      outline: async () => {
        if (closed) throw new EngineError("closed", "document is closed");
        const msg = await this.request<Extract<WorkerResponse, { type: "outline" }>>((reqId) => ({
          type: "outline",
          reqId,
          docId,
        }));
        return msg.items;
      },
      search: (query, options: SearchOptions = {}) => {
        if (closed) return Promise.reject(new EngineError("closed", "document is closed"));
        return this.search(docId, query, options);
      },
      textRuns: async (index) => {
        if (closed) throw new EngineError("closed", "document is closed");
        if (!Number.isInteger(index) || index < 0 || index >= frozenPages.length) {
          throw new RangeError(`page index ${index} out of range`);
        }
        const key = `${docId}:${index}`;
        const cached = this.textCache.get(key);
        if (cached) return cached;
        const msg = await this.request<Extract<WorkerResponse, { type: "text" }>>((reqId) => ({
          type: "text",
          reqId,
          docId,
          index,
        }));
        this.textCache.set(key, msg.runs);
        return msg.runs;
      },
      renderThumbnail: (index, maxWidth, maxHeight, options: RenderOptions = {}) => {
        if (closed) return Promise.reject(new EngineError("closed", "document is closed"));
        if (!Number.isInteger(index) || index < 0 || index >= frozenPages.length) {
          return Promise.reject(new RangeError(`page index ${index} out of range`));
        }
        return this.thumbnail(docId, index, maxWidth, maxHeight, options.signal);
      },
      pageContent: async (index) => {
        ensureOpen();
        checkIndex(index);
        const msg = await this.request<Extract<WorkerResponse, { type: "content" }>>((reqId) => ({ type: "content", reqId, docId, index }));
        return msg.content;
      },
      glyphs: async (index) => {
        ensureOpen();
        checkIndex(index);
        const msg = await this.request<Extract<WorkerResponse, { type: "glyphs" }>>((reqId) => ({ type: "glyphs", reqId, docId, index }));
        return msg.glyphs;
      },
      annotations: async (index) => {
        ensureOpen();
        checkIndex(index);
        const msg = await this.request<Extract<WorkerResponse, { type: "annotations" }>>((reqId) => ({
          type: "annotations",
          reqId,
          docId,
          index,
        }));
        return msg.items;
      },
      addAnnotation: async (annotation: Annotation) => {
        ensureOpen();
        checkIndex(annotation.page);
        const msg = await this.request<Extract<WorkerResponse, { type: "annotation" }>>((reqId) => ({
          type: "addAnnotation",
          reqId,
          docId,
          annotation,
        }));
        changed(annotation.page);
        return msg.annotation;
      },
      removeAnnotation: async (index, id) => {
        ensureOpen();
        checkIndex(index);
        const msg = await this.request<Extract<WorkerResponse, { type: "removed" }>>((reqId) => ({
          type: "removeAnnotation",
          reqId,
          docId,
          index,
          id,
        }));
        if (msg.removed) changed(index);
        return msg.removed;
      },
      documentFields: async () => {
        ensureOpen();
        const msg = await this.request<Extract<WorkerResponse, { type: "formFields" }>>((reqId) => ({ type: "documentFields", reqId, docId }));
        return msg.fields;
      },
      formFields: async (index) => {
        ensureOpen();
        checkIndex(index);
        const msg = await this.request<Extract<WorkerResponse, { type: "formFields" }>>((reqId) => ({
          type: "formFields",
          reqId,
          docId,
          index,
        }));
        return msg.fields;
      },
      setFormField: async (page, id, change) => {
        ensureOpen();
        checkIndex(page);
        const msg = await this.request<Extract<WorkerResponse, { type: "formFields" }>>((reqId) => ({
          type: "setFormField",
          reqId,
          docId,
          index: page,
          id,
          change,
        }));
        changed(page);
        return msg.fields;
      },
      flatten: async () => {
        ensureOpen();
        const msg = await this.request<Extract<WorkerResponse, { type: "flattened" }>>((reqId) => ({ type: "flatten", reqId, docId }));
        for (let i = 0; i < frozenPages.length; i++) changed(i);
        return msg.pages;
      },
      reload: async (bytes) => {
        ensureOpen();
        const msg = await this.request<Extract<WorkerResponse, { type: "reloaded" }>>(
          (reqId) => ({ type: "reload", reqId, docId, bytes }),
          [bytes],
        );
        restructured(msg.pages);
      },
      editPages: async (op) => {
        ensureOpen();
        const transfer = op.op === "insertPdf" ? [op.bytes] : [];
        const msg = await this.request<Extract<WorkerResponse, { type: "pagesEdited" }>>(
          (reqId) => ({ type: "editPages", reqId, docId, op }),
          transfer,
        );
        restructured(msg.pages);
        return msg.before;
      },
      applyRedactions: async () => {
        ensureOpen();
        const msg = await this.request<Extract<WorkerResponse, { type: "redacted" }>>((reqId) => ({
          type: "applyRedactions",
          reqId,
          docId,
        }));
        restructured(msg.pages);
        return { before: msg.before, applied: msg.applied, annotations: msg.annotations };
      },
      redactionPreview: async () => {
        ensureOpen();
        const msg = await this.request<Extract<WorkerResponse, { type: "redactionPreview" }>>((reqId) => ({
          type: "redactionPreview",
          reqId,
          docId,
        }));
        return msg.preview;
      },
      erase: async (area) => {
        ensureOpen();
        checkIndex(area.page);
        const msg = await this.request<Extract<WorkerResponse, { type: "contentErased" }>>((reqId) => ({
          type: "erase",
          reqId,
          docId,
          area: { page: area.page, rects: area.rects.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })), fill: area.fill },
        }));
        restructured(msg.pages);
        return { before: msg.before, annotations: msg.annotations };
      },
      pageObjects: async (index) => {
        ensureOpen();
        checkIndex(index);
        const msg = await this.request<Extract<WorkerResponse, { type: "pageObjects" }>>((reqId) => ({ type: "pageObjects", reqId, docId, index }));
        return msg.objects;
      },
      deleteObject: async (index, object) => {
        ensureOpen();
        checkIndex(index);
        const msg = await this.request<Extract<WorkerResponse, { type: "contentErased" }>>((reqId) => ({
          type: "deleteObject",
          reqId,
          docId,
          index,
          object: { index: object.index, kind: object.kind, rect: { ...object.rect } },
        }));
        restructured(msg.pages);
        return { before: msg.before };
      },
      sampleColor: async (index, rects) => {
        ensureOpen();
        checkIndex(index);
        const msg = await this.request<Extract<WorkerResponse, { type: "sampledColor" }>>((reqId) => ({
          type: "sampleColor",
          reqId,
          docId,
          index,
          rects: rects.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
        }));
        return msg.color;
      },
      importLosses: async (bytes) => {
        ensureOpen();
        const copy = bytes.slice(0);
        const msg = await this.request<Extract<WorkerResponse, { type: "importLosses" }>>(
          (reqId) => ({ type: "importLosses", reqId, docId, bytes: copy }),
          [copy],
        );
        return msg.losses;
      },
      exportPageImage: async (index, options) => {
        ensureOpen();
        checkIndex(index);
        const msg = await this.request<Extract<WorkerResponse, { type: "exportedImage" }>>((reqId) => ({
          type: "exportImage",
          reqId,
          docId,
          index,
          dpi: options.dpi,
          format: options.format,
          maxPixels: options.maxPixels ?? this.currentLimits.maxBitmapPixels,
        }));
        if (msg.mime !== RAW_RGBA) return { bytes: msg.bytes, mime: msg.mime, width: msg.width, height: msg.height };
        // A WebKit without OffscreenCanvas in workers: encode here.
        return encodeExportOnMainThread(msg.width, msg.height, msg.bytes, options.format);
      },
      setTextLayer: async (index, words) => {
        ensureOpen();
        checkIndex(index);
        const msg = await this.request<Extract<WorkerResponse, { type: "textLayer" }>>((reqId) => ({
          type: "setTextLayer",
          reqId,
          docId,
          index,
          words: [...words],
        }));
        // Invisible, but the page's text (search, selection) changed.
        changed(index);
        return msg.replaced;
      },
      renderPageGray: async (index, options) => {
        ensureOpen();
        checkIndex(index);
        const size = frozenPages[index];
        if (!size) throw new RangeError(`page index ${String(index)} out of range`);
        // 300 dpi within the pixel and side caps (a page larger than A4 is read at a lower dpi).
        const byArea = Math.sqrt(options.maxPixels / (size.width * size.height));
        const bySide = options.maxSide / Math.max(size.width, size.height);
        const scale = Math.min(options.dpi / 72, byArea, bySide);
        const msg = await this.request<Extract<WorkerResponse, { type: "pageGray" }>>((reqId) => ({
          type: "pageGray",
          reqId,
          docId,
          index,
          scale,
        }));
        return { bytes: msg.bytes, width: msg.width, height: msg.height };
      },
      pageTextInfo: async (index) => {
        ensureOpen();
        checkIndex(index);
        const msg = await this.request<Extract<WorkerResponse, { type: "pageTextInfo" }>>((reqId) => ({
          type: "pageTextInfo",
          reqId,
          docId,
          index,
        }));
        return msg.info;
      },
      extractPages: async (indices) => {
        ensureOpen();
        const msg = await this.request<Extract<WorkerResponse, { type: "extracted" }>>((reqId) => ({
          type: "extract",
          reqId,
          docId,
          indices: [...indices],
        }));
        return msg.bytes;
      },
      structureRevision: () => structure,
      onStructureChange: (listener) => {
        structureListeners.add(listener);
        return () => structureListeners.delete(listener);
      },
      annotationAppearance: async (page, id) => {
        ensureOpen();
        checkIndex(page);
        const msg = await this.request<Extract<WorkerResponse, { type: "appearance" }>>((reqId) => ({
          type: "appearance",
          reqId,
          docId,
          index: page,
          id,
        }));
        return msg.image;
      },
      pageRevision: (index) => revisions.get(index) ?? 0,
      onPageChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      save: async () => {
        ensureOpen();
        const msg = await this.request<Extract<WorkerResponse, { type: "saved" }>>((reqId) => ({ type: "save", reqId, docId }));
        return msg.bytes;
      },
      renderPage: async (index, scale, options: RenderOptions = {}) => {
        const image = await handle.renderPageImage(index, scale, options);
        return createImageBitmap(image);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        listeners.clear();
        structureListeners.clear();
        this.cache.deleteWhere((key) => key.startsWith(`${docId}:`));
        this.textCache.deleteWhere((key) => key.startsWith(`${docId}:`));
        await this.request((reqId) => ({ type: "close", reqId, docId }));
      },
    };
    return handle;
  }

  private async render(docId: string, index: number, scale: number, options: RenderOptions): Promise<ImageData> {
    const { signal, prefetch = false, night = false } = options;
    const rotation: QuarterTurns = options.rotation ?? 0;
    const { rect } = options;
    if (signal?.aborted) throw new EngineError("cancelled", "aborted");
    const area = rect ? `:${String(rect.x)},${String(rect.y)},${String(rect.width)},${String(rect.height)}` : "";
    const key = `${docId}:${index}:${scale.toFixed(4)}:${rotation}:${night ? "n" : "d"}${area}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    let reqId = 0;
    const onAbort = () => {
      if (reqId) this.worker.postMessage({ type: "cancel", reqId });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const msg = await this.request<Extract<WorkerResponse, { type: "rendered" }>>((id) => {
        reqId = id;
        return { type: "render", reqId: id, docId, index, scale, prefetch, rotation, night, ...(rect ? { rect } : {}) };
      });
      const image = new ImageData(new Uint8ClampedArray(msg.pixels), msg.width, msg.height);
      // Cache even if the caller gave up: scrolling back to it will be instant.
      this.cache.set(key, image);
      if (signal?.aborted) throw new EngineError("cancelled", "aborted");
      return image;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async thumbnail(
    docId: string,
    index: number,
    maxWidth: number,
    maxHeight: number,
    signal: AbortSignal | undefined,
  ): Promise<Thumbnail> {
    if (signal?.aborted) throw new EngineError("cancelled", "aborted");
    let reqId = 0;
    const onAbort = () => {
      if (reqId) this.worker.postMessage({ type: "cancel", reqId });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const msg = await this.request<Extract<WorkerResponse, { type: "thumbnail" }>>((id) => {
        reqId = id;
        return { type: "thumbnail", reqId: id, docId, index, maxWidth, maxHeight };
      });
      if (msg.mime === RAW_RGBA) return await encodeOnMainThread(msg.width, msg.height, msg.bytes);
      return { mime: msg.mime, bytes: msg.bytes, width: msg.width, height: msg.height };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async search(docId: string, query: string, options: SearchOptions): Promise<number> {
    const { signal, onHits } = options;
    if (signal?.aborted) throw new EngineError("cancelled", "aborted");
    let reqId = 0;
    const onAbort = () => {
      if (reqId) this.worker.postMessage({ type: "cancel", reqId });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const msg = await this.request<Extract<WorkerResponse, { type: "searchDone" }>>((id) => {
        reqId = id;
        this.progress.set(id, (page, hits) => {
          if (!signal?.aborted) onHits?.(page, hits);
        });
        return { type: "search", reqId: id, docId, query };
      });
      return msg.total;
    } finally {
      this.progress.delete(reqId);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private request<T extends WorkerResponse>(
    build: (reqId: number) => WorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<T> {
    if (this.destroyed) return Promise.reject(new EngineError("closed", "engine destroyed"));
    const reqId = this.nextReqId++;
    return new Promise<T>((resolve, reject) => {
      // The worker answers each reqId with the response type matching its request.
      const settle = (msg: WorkerResponse) => resolve(msg as T);
      this.pending.set(reqId, { resolve: settle, reject });
      this.worker.postMessage(build(reqId), transfer);
    });
  }

  private onMessage(msg: WorkerResponse): void {
    if (msg.type === "searchHits") {
      this.progress.get(msg.reqId)?.(msg.page, msg.hits);
      return;
    }
    const pending = this.pending.get(msg.reqId);
    if (!pending) return; // Late reply for a request we gave up on; the buffer is simply dropped.
    this.pending.delete(msg.reqId);
    if (msg.type === "error") pending.reject(new EngineError(msg.code, msg.message));
    else pending.resolve(msg);
  }

  private failAll(err: EngineError): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

async function encodeExportOnMainThread(width: number, height: number, pixels: ArrayBuffer, format: "png" | "jpeg"): Promise<ExportedImage> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new EngineError("unknown", "no 2d context for export");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, format === "png" ? "image/png" : "image/jpeg", 0.92);
  });
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new EngineError("unknown", "export encoding failed");
  return { bytes: await blob.arrayBuffer(), mime: blob.type, width, height };
}

/** Fallback for WebKits without OffscreenCanvas in workers: encode a (small) thumbnail here. */
async function encodeOnMainThread(width: number, height: number, pixels: ArrayBuffer): Promise<Thumbnail> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new EngineError("unknown", "no 2d context for thumbnail encoding");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  const toBlob = (type: string, quality: number) =>
    new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, type, quality);
    });
  let blob = await toBlob("image/webp", 0.8);
  if (blob?.type !== "image/webp") blob = await toBlob("image/jpeg", 0.85);
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new EngineError("unknown", "thumbnail encoding failed");
  return { mime: blob.type, bytes: await blob.arrayBuffer(), width, height };
}

/** Starts the engine worker. One engine per app is enough. */
export function createPdfEngine(limits: RenderLimits = DEFAULT_RENDER_LIMITS): PdfEngine {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "selis-pdf-engine" });
  return new WorkerPdfEngine(worker, limits);
}
