/**
 * Main-thread client of the scan worker (P4c, ADR 0016). One worker per scan session: it is
 * started when the camera opens and terminated when the scan screen closes (its WebAssembly
 * memory grows to the largest photo and never shrinks).
 */
import type { Quad } from "./geometry";
import type { Picture, PhotoSource, WorkerRequest, WorkerResponse } from "./protocol";
import { type ScanFilter, simdSupported } from "./wasm";

/** Minimal surface of `Worker` (tests inject a fake). */
export type ScanWorkerLike = {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};

export type Still = { readonly width: number; readonly height: number; readonly quad: Quad | null; readonly preview: Picture };
export type KeptPage = { readonly page: Picture; readonly mime: "image/jpeg" | "image/png"; readonly thumb: Picture; readonly ms: number };

type Pending = { resolve: (msg: WorkerResponse) => void; reject: (err: Error) => void };

type Body<T extends WorkerRequest["type"]> = Omit<Extract<WorkerRequest, { type: T }>, "reqId" | "type">;

export class ScanClient {
  private readonly worker: ScanWorkerLike;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  /** False until `init` resolves; then whether the worker can decode/encode by itself. */
  canvasInWorker = false;

  constructor(worker: ScanWorkerLike) {
    this.worker = worker;
    worker.onmessage = (event) => {
      const msg = event.data;
      const waiting = this.pending.get(msg.reqId);
      if (!waiting) return;
      this.pending.delete(msg.reqId);
      if (msg.type === "error") waiting.reject(new Error(msg.message));
      else waiting.resolve(msg);
    };
    worker.onerror = (event) => this.failAll(new Error(event.message || "scan worker crashed"));
  }

  private failAll(err: Error): void {
    for (const waiting of this.pending.values()) waiting.reject(err);
    this.pending.clear();
  }

  private request<T extends WorkerRequest["type"], R extends WorkerResponse>(
    type: T,
    body: Body<T>,
    transfer: Transferable[] = [],
  ): Promise<R> {
    if (this.closed) return Promise.reject(new Error("scan worker closed"));
    const reqId = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(reqId, { resolve: resolve as (msg: WorkerResponse) => void, reject });
      this.worker.postMessage({ ...body, type, reqId } as unknown as WorkerRequest, transfer);
    });
  }

  async init(): Promise<void> {
    const ready = await this.request<"init", Extract<WorkerResponse, { type: "ready" }>>("init", { simd: simdSupported() });
    this.canvasInWorker = ready.canvas;
  }

  /** The page in a small live frame (its buffer is handed over). Frame pixels. */
  async detect(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): Promise<{ quad: Quad | null; ms: number }> {
    const msg = await this.request<"detect", Extract<WorkerResponse, { type: "detected" }>>("detect", { width, height, rgba: rgba.buffer }, [rgba.buffer]);
    return { quad: msg.quad, ms: msg.ms };
  }

  /** A captured still: its size (after the pixel cap), the page found in it, and a preview. */
  async still(photo: PhotoSource, maxPixels: number, previewSide: number): Promise<Still> {
    const transfer = photo.kind === "rgba" ? [photo.rgba] : [];
    const msg = await this.request<"still", Extract<WorkerResponse, { type: "still" }>>("still", { photo, maxPixels, previewSide }, transfer);
    return { width: msg.width, height: msg.height, quad: msg.quad, preview: msg.preview };
  }

  /** The still's preview with `filter` applied. */
  async preview(filter: ScanFilter): Promise<Picture> {
    return (await this.request<"preview", Extract<WorkerResponse, { type: "preview" }>>("preview", { filter })).preview;
  }

  /** Straightens the still to `quad` (photo pixels), applies `filter`, and lets the still go. */
  async keep(quad: Quad, filter: ScanFilter, maxPixels: number, thumbSide: number): Promise<KeptPage> {
    const msg = await this.request<"keep", Extract<WorkerResponse, { type: "kept" }>>("keep", { quad, filter, maxPixels, thumbSide });
    return { page: msg.page, mime: msg.mime, thumb: msg.thumb, ms: msg.ms };
  }

  async drop(): Promise<void> {
    await this.request("drop", {});
  }

  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    this.failAll(new Error("scan worker closed"));
  }
}

export function createScanClient(): ScanClient {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "selis-scan" });
  return new ScanClient(worker);
}
