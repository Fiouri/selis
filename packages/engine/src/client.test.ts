import { beforeAll, describe, expect, it, vi } from "vitest";
import { WorkerPdfEngine, type WorkerLike } from "./client";
import type { WorkerRequest, WorkerResponse } from "./protocol";
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

  it("maps worker errors to EngineError", async () => {
    const worker = new FakeWorker();
    worker.autoReply = (req) => ({ type: "error", reqId: req.reqId, code: "password", message: "needs password" });
    const engine = new WorkerPdfEngine(worker);
    const err = await engine.open(new ArrayBuffer(1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe("password");
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
});
