import type { WorkerRequest, WorkerResponse } from "./protocol";
import {
  type DocHandle,
  EngineError,
  type OpenOptions,
  type PageSize,
  type PdfEngine,
  type RenderOptions,
} from "./types";

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
  private nextReqId = 1;
  private destroyed = false;

  constructor(worker: WorkerLike) {
    this.worker = worker;
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

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.worker.terminate();
    this.failAll(new EngineError("closed", "engine destroyed"));
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
        return this.render(docId, index, scale, options.signal, options.prefetch ?? false);
      },
      renderPage: async (index, scale, options: RenderOptions = {}) => {
        const image = await handle.renderPageImage(index, scale, options);
        return createImageBitmap(image);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await this.request((reqId) => ({ type: "close", reqId, docId }));
      },
    };
    return handle;
  }

  private async render(
    docId: string,
    index: number,
    scale: number,
    signal: AbortSignal | undefined,
    prefetch: boolean,
  ): Promise<ImageData> {
    if (signal?.aborted) throw new EngineError("cancelled", "aborted");
    let reqId = 0;
    const onAbort = () => {
      if (reqId) this.worker.postMessage({ type: "cancel", reqId });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const msg = await this.request<Extract<WorkerResponse, { type: "rendered" }>>((id) => {
        reqId = id;
        return { type: "render", reqId: id, docId, index, scale, prefetch };
      });
      if (signal?.aborted) throw new EngineError("cancelled", "aborted");
      return new ImageData(new Uint8ClampedArray(msg.pixels), msg.width, msg.height);
    } finally {
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

/** Starts the engine worker. One engine per app is enough. */
export function createPdfEngine(): PdfEngine {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "selis-pdf-engine" });
  return new WorkerPdfEngine(worker);
}
