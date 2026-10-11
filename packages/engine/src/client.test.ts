import { beforeAll, describe, expect, it, vi } from "vitest";
import { WorkerPdfEngine, type WorkerLike } from "./client";
import { renderLimitsFor } from "./limits";
import { thumbnailScale, type WorkerRequest, type WorkerResponse } from "./protocol";
import { EngineError } from "./types";

/** In-memory fake worker; replies are scripted per test. */
class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: WorkerRequest[] = [];
  terminated = false;
  autoReply: ((req: WorkerRequest) => WorkerResponse | null) | null = null;

  postMessage(message: WorkerRequest): void {
    this.sent.push(message);
    const reply = this.autoReply?.(message);
    if (reply) queueMicrotask(() => this.reply(reply));
  }

  reply(msg: WorkerResponse): void {
    this.onmessage?.(new MessageEvent("message", { data: msg }));
  }

  terminate(): void {
    this.terminated = true;
  }
}

beforeAll(() => {
  // Node has no ImageData / createImageBitmap; minimal stand-ins for the client logic.
  class ImageDataStub {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  }
  vi.stubGlobal("ImageData", ImageDataStub);
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn((image: ImageData) => Promise.resolve({ width: image.width, height: image.height, close: vi.fn() })),
  );
});

function rendered(reqId: number, width = 2, height = 3): WorkerResponse {
  return { type: "rendered", reqId, width, height, pixels: new ArrayBuffer(width * height * 4) };
}

function openedEngine() {
  const worker = new FakeWorker();
  worker.autoReply = (req) => {
    if (req.type === "open") {
      return { type: "opened", reqId: req.reqId, docId: "doc-1", pages: [{ width: 100, height: 200 }], title: "T" };
    }
    if (req.type === "close") return { type: "closed", reqId: req.reqId };
    return null;
  };
  return { worker, engine: new WorkerPdfEngine(worker) };
}

describe("WorkerPdfEngine", () => {
  it("opens a document and exposes page info", async () => {
    const { worker, engine } = openedEngine();
    const doc = await engine.open(new ArrayBuffer(8));
    expect(doc.pageCount).toBe(1);
    expect(doc.pages[0]).toEqual({ width: 100, height: 200 });
    expect(doc.title).toBe("T");
    expect(worker.sent[0]).toMatchObject({ type: "open" });
  });

  it("renders raw pixels and ImageBitmaps", async () => {
    const { worker, engine } = openedEngine();
    const doc = await engine.open(new ArrayBuffer(8));
    worker.autoReply = (req) => (req.type === "render" ? rendered(req.reqId) : null);

    const image = await doc.renderPageImage(0, 1.5);
    expect([image.width, image.height, image.data.length]).toEqual([2, 3, 24]);
    expect(worker.sent.at(-1)).toMatchObject({ type: "render", docId: "doc-1", index: 0, scale: 1.5, prefetch: false });

    const bitmap = await doc.renderPage(0, 1, { prefetch: true });
    expect([bitmap.width, bitmap.height]).toEqual([2, 3]);
    expect(worker.sent.at(-1)).toMatchObject({ prefetch: true });
  });

  it("rejects out-of-range pages without asking the worker", async () => {
    const { worker, engine } = openedEngine();
    const doc = await engine.open(new ArrayBuffer(8));
    const before = worker.sent.length;
    await expect(doc.renderPageImage(5, 1)).rejects.toBeInstanceOf(RangeError);
    expect(worker.sent.length).toBe(before);
  });

  it("sends cancel on abort and drops late results", async () => {
    const { worker, engine } = openedEngine();
    const doc = await engine.open(new ArrayBuffer(8));
    const controller = new AbortController();
    const promise = doc.renderPageImage(0, 1, { signal: controller.signal });
    const render = worker.sent.at(-1) as Extract<WorkerRequest, { type: "render" }>;
    controller.abort();
    expect(worker.sent.at(-1)).toEqual({ type: "cancel", reqId: render.reqId });
    worker.reply(rendered(render.reqId));
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
  });

  it("warms up once and allows a retry after failure", async () => {
    const worker = new FakeWorker();
    let fail = true;
    worker.autoReply = (req) =>
      req.type === "warmup"
        ? fail
          ? { type: "error", reqId: req.reqId, code: "init", message: "no wasm" }
          : { type: "ready", reqId: req.reqId }
        : null;
    const engine = new WorkerPdfEngine(worker);
    await expect(engine.warmUp()).rejects.toMatchObject({ code: "init" });
    fail = false;
    await engine.warmUp();
    await engine.warmUp();
    expect(worker.sent.filter((m) => m.type === "warmup")).toHaveLength(2);
  });

  it("maps worker errors to EngineError", async () => {
    const worker = new FakeWorker();
    worker.autoReply = (req) => ({ type: "error", reqId: req.reqId, code: "password", message: "needs password" });
    const engine = new WorkerPdfEngine(worker);
    const err = await engine.open(new ArrayBuffer(1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe("password");
  });

  it("serves repeated renders from the LRU cache and purges it on close", async () => {
    const { worker, engine } = openedEngine();
    const doc = await engine.open(new ArrayBuffer(8));
    const base = worker.autoReply;
    worker.autoReply = (req) => (req.type === "render" ? rendered(req.reqId) : (base?.(req) ?? null));
    const first = await doc.renderPageImage(0, 1);
    const renders = () => worker.sent.filter((m) => m.type === "render").length;
    expect(renders()).toBe(1);
    expect(await doc.renderPageImage(0, 1)).toBe(first);
    expect(renders()).toBe(1);
    await doc.renderPageImage(0, 1.5); // different scale → new render
    expect(renders()).toBe(2);
    await doc.close();
    const doc2 = await engine.open(new ArrayBuffer(8)); // same docId from the fake worker
    await doc2.renderPageImage(0, 1);
    expect(renders()).toBe(3);
  });

  it("clamps the render scale to the bitmap budget of the current limits", async () => {
    const { worker, engine } = openedEngine();
    engine.setLimits({ ...renderLimitsFor(null), maxBitmapPixels: 100 * 200 * 4 });
    const doc = await engine.open(new ArrayBuffer(8));
    worker.autoReply = (req) => (req.type === "render" ? rendered(req.reqId) : null);
    await doc.renderPageImage(0, 10); // 100×200 pt page at 10× = 2 MP > budget
    const sent = worker.sent.at(-1) as Extract<WorkerRequest, { type: "render" }>;
    expect(sent.scale).toBeCloseTo(2);
    expect(engine.limits.maxBitmapPixels).toBe(80_000);
  });

  it("refuses renders after close and fails pending work on destroy", async () => {
    const { worker, engine } = openedEngine();
    const doc = await engine.open(new ArrayBuffer(8));
    await doc.close();
    await expect(doc.renderPageImage(0, 1)).rejects.toMatchObject({ code: "closed" });

    const doc2 = await engine.open(new ArrayBuffer(8));
    worker.autoReply = null;
    const pending = doc2.renderPageImage(0, 1);
    engine.destroy();
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    expect(worker.terminated).toBe(true);
  });

  it("asks the worker for an encoded thumbnail and can cancel it", async () => {
    const { worker, engine } = openedEngine();
    const doc = await engine.open(new ArrayBuffer(8));
    worker.autoReply = (req) =>
      req.type === "thumbnail"
        ? { type: "thumbnail", reqId: req.reqId, width: 150, height: 300, mime: "image/webp", bytes: new ArrayBuffer(10) }
        : null;
    const thumb = await doc.renderThumbnail(0, 300, 420);
    expect(thumb).toMatchObject({ mime: "image/webp", width: 150, height: 300 });
    expect(thumb.bytes.byteLength).toBe(10);
    expect(worker.sent.at(-1)).toMatchObject({ type: "thumbnail", docId: "doc-1", index: 0, maxWidth: 300, maxHeight: 420 });

    worker.autoReply = null;
    const controller = new AbortController();
    const pending = doc.renderThumbnail(0, 300, 420, { signal: controller.signal });
    const sent = worker.sent.at(-1) as Extract<WorkerRequest, { type: "thumbnail" }>;
    controller.abort();
    expect(worker.sent.at(-1)).toEqual({ type: "cancel", reqId: sent.reqId });
    worker.reply({ type: "error", reqId: sent.reqId, code: "cancelled", message: "cancelled" });
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await expect(doc.renderThumbnail(3, 10, 10)).rejects.toBeInstanceOf(RangeError);
  });
});

describe("thumbnailScale", () => {
  it("fits the page inside the box, keeping its aspect ratio", () => {
    expect(thumbnailScale({ width: 600, height: 800 }, 300, 420)).toBeCloseTo(0.5);
    expect(thumbnailScale({ width: 842, height: 595 }, 300, 420)).toBeCloseTo(300 / 842);
    expect(thumbnailScale({ width: 0, height: 800 }, 300, 420)).toBe(0);
  });
});
