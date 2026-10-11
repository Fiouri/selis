import { DEFAULT_RENDER_LIMITS, type RenderLimits } from "./limits";
import { LruCache } from "./lru";
import { clampScale, RAW_RGBA, type WorkerRequest, type WorkerResponse } from "./protocol";
import type { QuarterTurns } from "./geometry";
import {
  type DocHandle,
  EngineError,
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
    const frozenPages = Object.freeze(pages.map((p) => Object.freeze({ ...p })));
    const handle: DocHandle = {
      id: docId,
      pageCount: frozenPages.length,
      pages: frozenPages,
      title,
      renderPageImage: (index, scale, options: RenderOptions = {}) => {
        if (closed) return Promise.reject(new EngineError("closed", "document is closed"));
        if (!Number.isInteger(index) || index < 0 || index >= frozenPages.length) {
          return Promise.reject(new RangeError(`page index ${index} out of range`));
        }
        const page = frozenPages[index] as PageSize;
        const effective = clampScale(page, scale, this.currentLimits.maxBitmapPixels);
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
      renderPage: async (index, scale, options: RenderOptions = {}) => {
        const image = await handle.renderPageImage(index, scale, options);
        return createImageBitmap(image);
      },
      close: async () => {
        if (closed) return;
        closed = true;
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
    if (signal?.aborted) throw new EngineError("cancelled", "aborted");
    const key = `${docId}:${index}:${scale.toFixed(4)}:${rotation}:${night ? "n" : "d"}`;
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
        return { type: "render", reqId: id, docId, index, scale, prefetch, rotation, night };
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
