import { describe, expect, it } from "vitest";
import { ScanClient, type ScanWorkerLike } from "./client";
import type { WorkerRequest, WorkerResponse } from "./protocol";

function fakeWorker(reply: (req: WorkerRequest) => WorkerResponse | null) {
  const sent: WorkerRequest[] = [];
  const worker: ScanWorkerLike & { terminated: boolean } = {
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage(message) {
      sent.push(message);
      const response = reply(message);
      if (response) queueMicrotask(() => worker.onmessage?.({ data: response } as MessageEvent<WorkerResponse>));
    },
    terminate() {
      worker.terminated = true;
    },
  };
  return { worker, sent };
}

describe("ScanClient", () => {
  it("initialises with the SIMD build where it is supported and learns the worker's canvas support", async () => {
    const { worker, sent } = fakeWorker((req) => (req.type === "init" ? { type: "ready", reqId: req.reqId, canvas: true } : null));
    const client = new ScanClient(worker);
    await client.init();
    expect(sent[0]).toMatchObject({ type: "init", simd: true });
    expect(client.canvasInWorker).toBe(true);
  });

  it("hands frames over and returns the outline", async () => {
    const { worker, sent } = fakeWorker((req) =>
      req.type === "detect"
        ? {
            type: "detected",
            reqId: req.reqId,
            ms: 3,
            quad: [
              [1, 2],
              [3, 4],
              [5, 6],
              [7, 8],
            ],
          }
        : null,
    );
    const client = new ScanClient(worker);
    const result = await client.detect(new Uint8ClampedArray(16), 2, 2);
    expect(result.ms).toBe(3);
    expect(result.quad?.[3]).toEqual([7, 8]);
    expect(sent[0]).toMatchObject({ type: "detect", width: 2, height: 2 });
  });

  it("rejects on a worker error and on terminate", async () => {
    const { worker } = fakeWorker((req) => (req.type === "drop" ? { type: "error", reqId: req.reqId, message: "no still" } : null));
    const client = new ScanClient(worker);
    await expect(client.drop()).rejects.toThrow("no still");
    const pending = client.preview("grey");
    client.terminate();
    await expect(pending).rejects.toThrow("closed");
    expect(worker.terminated).toBe(true);
    await expect(client.drop()).rejects.toThrow("closed");
  });
});
