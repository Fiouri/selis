import type { KeptPage, Picture, Quad, ScanFilter, Still } from "@selis/scan";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ScanModule from "@selis/scan";
import type * as ApiModule from "../../lib/api";
import type { Document, ImportOutcome } from "../../lib/api";

const importUpload = vi.fn<(uploadId: string, title: string) => Promise<ImportOutcome>>();
const upload = vi.fn<(bytes: ArrayBuffer) => Promise<string>>();
const session = {
  add: vi.fn<(bytes: ArrayBuffer, mime: string, size: string) => Promise<number>>(),
  finish: vi.fn<() => Promise<ArrayBuffer>>(),
  discard: vi.fn<() => Promise<void>>(),
};
const client = {
  canvasInWorker: true,
  init: vi.fn<() => Promise<void>>(),
  still: vi.fn<(photo: unknown, maxPixels: number, previewSide: number) => Promise<Still>>(),
  preview: vi.fn<(filter: ScanFilter) => Promise<Picture>>(),
  keep: vi.fn<(quad: Quad, filter: ScanFilter, maxPixels: number, thumbSide: number) => Promise<KeptPage>>(),
  drop: vi.fn<() => Promise<void>>(),
  terminate: vi.fn<() => void>(),
};

vi.mock("@selis/scan", async (importOriginal) => {
  const actual = await importOriginal<typeof ScanModule>();
  return { ...actual, createScanClient: () => client };
});
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { ...actual.api, importUpload } };
});
vi.mock("../../lib/save", () => ({ upload }));
vi.mock("../../lib/engine", () => ({
  getEngine: () => ({ createImagePdf: () => Promise.resolve(session) }),
  currentRenderLimits: () => ({ maxRenderScale: 1.25, maxBitmapPixels: 6_000_000, cacheMaxPages: 4, cacheMaxBytes: 1 }),
}));

const { useScan } = await import("./scanStore");

const blob = (type: string) => new Blob([new Uint8Array([1, 2, 3])], { type });
const picture = (type: string): Picture => ({ kind: "blob", blob: blob(type), width: 30, height: 40 });
const QUAD: Quad = [
  [10, 10],
  [290, 12],
  [288, 390],
  [12, 388],
];
const doc = { id: "d1", title: "Scan" } as Document;

async function capture(found: Quad | null = QUAD): Promise<boolean> {
  client.still.mockResolvedValueOnce({ width: 300, height: 400, quad: found, preview: picture("image/jpeg") });
  return useScan.getState().capture(() => Promise.resolve({ kind: "blob", blob: blob("image/jpeg") }));
}

async function keepPage(mime: "image/jpeg" | "image/png" = "image/jpeg"): Promise<void> {
  client.keep.mockResolvedValueOnce({ page: picture(mime), mime, thumb: picture("image/jpeg"), ms: 12 });
  await useScan.getState().keep();
}

describe("scan session", () => {
  beforeEach(() => {
    for (const f of [importUpload, upload, session.add, session.finish, session.discard, ...Object.values(client).filter((v) => typeof v === "function")]) {
      (f as ReturnType<typeof vi.fn>).mockReset();
    }
    client.init.mockResolvedValue();
    client.drop.mockResolvedValue();
    globalThis.URL.createObjectURL = vi.fn(() => `blob:${String(Math.random())}`);
    globalThis.URL.revokeObjectURL = vi.fn();
    useScan.getState().close();
  });

  it("captures, adjusts and keeps pages; the still's pixel cap follows the device", async () => {
    await useScan.getState().open();
    expect(client.init).toHaveBeenCalled();
    expect(await capture()).toBe(true);
    expect(client.still.mock.calls[0]?.[1]).toBe(6_000_000);
    const phase = useScan.getState().phase;
    expect(phase.step).toBe("adjust");
    if (phase.step !== "adjust") return;
    expect(phase.still.detected).toBe(true);
    expect(phase.still.quad).toEqual(QUAD);

    const moved: Quad = [[20, 20], QUAD[1], QUAD[2], QUAD[3]];
    useScan.getState().setQuad(moved);
    client.preview.mockResolvedValueOnce(picture("image/jpeg"));
    await useScan.getState().setFilter("bw");
    await keepPage("image/png");
    // The adjusted outline and the filter go to the worker; the page is capped at A4 300 dpi
    // or the device's limit, whichever is smaller.
    expect(client.keep).toHaveBeenCalledWith(moved, "bw", 6_000_000, 360);
    expect(useScan.getState().phase).toEqual({ step: "camera" });
    expect(useScan.getState().pages).toHaveLength(1);
    expect(useScan.getState().pages[0]?.mime).toBe("image/png");
  });

  it("falls back to an inset outline when no page is found", async () => {
    await useScan.getState().open();
    await capture(null);
    const phase = useScan.getState().phase;
    if (phase.step !== "adjust") throw new Error(phase.step);
    expect(phase.still.detected).toBe(false);
    expect(phase.still.quad).toEqual([
      [24, 32],
      [276, 32],
      [276, 368],
      [24, 368],
    ]);
  });

  it("retake lets the still go and returns to the camera", async () => {
    await useScan.getState().open();
    await capture();
    useScan.getState().retake();
    expect(client.drop).toHaveBeenCalled();
    expect(useScan.getState().phase).toEqual({ step: "camera" });
  });

  it("a failed capture or straightening keeps the session usable", async () => {
    await useScan.getState().open();
    client.still.mockRejectedValueOnce(new Error("decode"));
    expect(await useScan.getState().capture(() => Promise.resolve({ kind: "blob", blob: blob("image/jpeg") }))).toBe(false);
    expect(useScan.getState().phase).toEqual({ step: "camera" });
    await capture();
    client.keep.mockRejectedValueOnce(new Error("oom"));
    expect(await useScan.getState().keep()).toBe(false);
    expect(useScan.getState().phase.step).toBe("adjust");
  });

  it("orders the queue, saves the pages as one PDF in that order and closes", async () => {
    await useScan.getState().open();
    for (const mime of ["image/jpeg", "image/png", "image/jpeg"] as const) {
      await capture();
      await keepPage(mime);
    }
    const ids = useScan.getState().pages.map((p) => p.id);
    useScan.getState().showQueue();
    expect(useScan.getState().phase).toEqual({ step: "queue" });
    useScan.getState().move(ids[2] ?? "", -1);
    expect(useScan.getState().pages.map((p) => p.id)).toEqual([ids[0], ids[2], ids[1]]);

    session.add.mockResolvedValue(1);
    session.finish.mockResolvedValue(new ArrayBuffer(8));
    upload.mockResolvedValue("u1");
    importUpload.mockResolvedValue({ document: doc, duplicate: false });
    const result = await useScan.getState().save("Scan 2026-10-14");
    expect(result).toEqual({ kind: "created", document: doc });
    expect(session.add.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["image/jpeg", "fit"],
      ["image/jpeg", "fit"],
      ["image/png", "fit"],
    ]);
    expect(importUpload).toHaveBeenCalledWith("u1", "Scan 2026-10-14");
    expect(useScan.getState().phase).toEqual({ step: "closed" });
    expect(useScan.getState().pages).toHaveLength(0);
    expect(client.terminate).toHaveBeenCalled();
  });

  it("keeps the pages when the PDF cannot be made", async () => {
    await useScan.getState().open();
    await capture();
    await keepPage();
    useScan.getState().showQueue();
    session.add.mockRejectedValue(new Error("engine"));
    expect(await useScan.getState().save("Scan")).toEqual({ kind: "failed" });
    expect(session.discard).toHaveBeenCalled();
    expect(useScan.getState().phase).toEqual({ step: "queue" });
    expect(useScan.getState().pages).toHaveLength(1);
  });

  it("removing the last page leaves the queue for the camera", async () => {
    await useScan.getState().open();
    await capture();
    await keepPage();
    useScan.getState().showQueue();
    useScan.getState().remove(useScan.getState().pages[0]?.id ?? "");
    expect(useScan.getState().phase).toEqual({ step: "camera" });
  });
});
