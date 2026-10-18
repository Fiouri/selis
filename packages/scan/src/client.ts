/**
 * Main-thread client of the scan worker (P4c, ADR 0016; Scan 2.0, ADR 0032). One worker per scan session: it is
 * started when the camera opens and terminated when the scan screen closes (its WebAssembly
 * memory grows to the largest photo and never shrinks).
 */
import type { Quad } from "./geometry";
import type { Picture, PhotoSource, WorkerRequest, WorkerResponse } from "./protocol";
import { type LiveFrame, type PageEdits, type ScanFilter, simdSupported } from "./wasm";

/** Minimal surface of `Worker` (tests inject a fake). */
export type ScanWorkerLike = {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};

export type Still = {
  readonly width: number;
  readonly height: number;
  readonly quad: Quad | null;
  readonly preview: Picture;
  /** The photo as a JPEG when it came as pixels (to edit the page later); null for a Blob photo. */
  readonly source: Picture | null;
};
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

  /** One live frame (its buffer is handed over) taken at `now`: outline (frame pixels) and auto-capture verdict. */
  async live(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, now: number): Promise<LiveFrame & { ms: number }> {
    const msg = await this.request<"live", Extract<WorkerResponse, { type: "live" }>>("live", { width, height, rgba: rgba.buffer, now }, [rgba.buffer]);
    const { type: _type, reqId: _reqId, ...frame } = msg;
    return frame;
  }

  /** Forgets the automatic-capture state: the next steady page fires even if it was just captured. */
  async resetAuto(): Promise<void> {
    await this.request("resetAuto", {});
  }

  /**
   * A captured still: its size (after the pixel cap), the page found in it (or `quad`, when
   * the outline is already known), and a preview.
   */
  async still(photo: PhotoSource, maxPixels: number, previewSide: number, quad: Quad | null = null): Promise<Still> {
    const transfer = photo.kind === "rgba" ? [photo.rgba] : [];
    const msg = await this.request<"still", Extract<WorkerResponse, { type: "still" }>>("still", { photo, maxPixels, previewSide, quad }, transfer);
    return { width: msg.width, height: msg.height, quad: msg.quad, preview: msg.preview, source: msg.source };
  }

  /** The still's preview with `filter` applied. */
  async preview(filter: ScanFilter): Promise<Picture> {
    return (await this.request<"preview", Extract<WorkerResponse, { type: "preview" }>>("preview", { filter })).preview;
  }

  /** The still's page made with `edits` (at most `maxPixels`, JPEG); the still stays. */
  async render(edits: PageEdits, maxPixels: number): Promise<Picture> {
    return (await this.request<"render", Extract<WorkerResponse, { type: "rendered" }>>("render", { edits, maxPixels })).page;
  }

  /** Makes the still's page with `edits` and lets the still go. */
  async keep(edits: PageEdits, maxPixels: number, thumbSide: number): Promise<KeptPage> {
    const msg = await this.request<"keep", Extract<WorkerResponse, { type: "kept" }>>("keep", { edits, maxPixels, thumbSide });
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
