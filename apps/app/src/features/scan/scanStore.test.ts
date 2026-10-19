import type { SheetImage } from "@selis/engine";
import type { KeptPage, PageEdits, Picture, Quad, ScanFilter, Still } from "@selis/scan";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ScanModule from "@selis/scan";
import type * as ApiModule from "../../lib/api";
import type { Document, ImportOutcome } from "../../lib/api";

const limits = { maxRenderScale: 1.25, maxBitmapPixels: 6_000_000, cacheMaxPages: 4, cacheMaxBytes: 1 };
const importUpload = vi.fn<(uploadId: string, title: string) => Promise<ImportOutcome>>();
const upload = vi.fn<(bytes: ArrayBuffer) => Promise<string>>();
const session = {
  add: vi.fn<(bytes: ArrayBuffer, mime: string, size: string) => Promise<number>>(),
  addSheet: vi.fn<(width: number, height: number, items: readonly SheetImage[]) => Promise<number>>(),
  finish: vi.fn<() => Promise<ArrayBuffer>>(),
  discard: vi.fn<() => Promise<void>>(),
};
const client = {
  canvasInWorker: true,
  init: vi.fn<() => Promise<void>>(),
  still: vi.fn<(photo: unknown, maxPixels: number, previewSide: number, quad?: Quad | null) => Promise<Still>>(),
  preview: vi.fn<(filter: ScanFilter) => Promise<Picture>>(),
  render: vi.fn<(edits: PageEdits, maxPixels: number) => Promise<Picture>>(),
  resetAuto: vi.fn<() => Promise<void>>(),
  resumeAuto: vi.fn<() => Promise<void>>(),
  keep: vi.fn<(edits: PageEdits, maxPixels: number, thumbSide: number) => Promise<KeptPage>>(),
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
  currentRenderLimits: () => limits,
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
  client.still.mockResolvedValueOnce({ width: 300, height: 400, quad: found, preview: picture("image/jpeg"), source: null });
  return useScan.getState().capture(() => Promise.resolve({ kind: "blob", blob: blob("image/jpeg") }));
}

async function keepPage(mime: "image/jpeg" | "image/png" = "image/jpeg", page: Picture = picture(mime)): Promise<void> {
  client.keep.mockResolvedValueOnce({ page, mime, thumb: picture("image/jpeg"), ms: 12 });
  await useScan.getState().keep();
}

/** Captures and keeps `n` pages; returns their ids. */
async function scanPages(n: number): Promise<string[]> {
  for (let i = 0; i < n; i++) {
    await capture();
    await keepPage();
  }
  return useScan.getState().pages.map((p) => p.id);
}

function stillOf(): Still {
  return { width: 300, height: 400, quad: QUAD, preview: picture("image/jpeg"), source: null };
}

describe("scan session", () => {
  beforeEach(() => {
    for (const f of [importUpload, upload, session.add, session.finish, session.discard, ...Object.values(client).filter((v) => typeof v === "function")]) {
      (f as ReturnType<typeof vi.fn>).mockReset();
    }
    client.init.mockResolvedValue();
    client.drop.mockResolvedValue();
    client.resetAuto.mockResolvedValue();
    client.preview.mockResolvedValue(picture("image/jpeg"));
    client.render.mockResolvedValue(picture("image/jpeg"));
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
    // Enhance is the default filter for documents.
    expect(phase.still.filter).toBe("enhance");

    const moved: Quad = [[20, 20], QUAD[1], QUAD[2], QUAD[3]];
    useScan.getState().setQuad(moved);
    client.preview.mockResolvedValueOnce(picture("image/jpeg"));
    await useScan.getState().setFilter("bw");
    await keepPage("image/png");
    // The adjusted outline and the filter go to the worker; the page is capped at A4 300 dpi
    // or the device's limit, whichever is smaller.
    expect(client.keep).toHaveBeenCalledWith({ quad: moved, filter: "bw", strokes: [], turns: 0 }, 6_000_000, 360);
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

  it("retake lets the still go and returns to the camera (auto-capture resumes, not reset)", async () => {
    await useScan.getState().open();
    await capture();
    useScan.getState().retake();
    expect(client.drop).toHaveBeenCalled();
    expect(client.resetAuto).not.toHaveBeenCalled();
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

  it("a batch: reorder, rotate, delete one, retake one, then one PDF in that order", async () => {
    await useScan.getState().open();
    const ids = await scanPages(10);
    expect(useScan.getState().phase).toEqual({ step: "camera" });
    useScan.getState().showQueue();
    // Page 3 dragged to the front.
    useScan.getState().moveTo(ids[2] ?? "", 0);
    // Page 5 rotated in its page screen.
    client.still.mockResolvedValueOnce(stillOf());
    expect(await useScan.getState().openPage(ids[4] ?? "")).toBe(true);
    expect(client.still.mock.lastCall?.[3]).toEqual(QUAD);
    useScan.getState().rotatePage();
    await vi.waitFor(() => expect(client.render).toHaveBeenLastCalledWith({ quad: QUAD, filter: "enhance", strokes: [], turns: 1 }, 1200 * 1700));
    client.keep.mockResolvedValueOnce({ page: picture("image/jpeg"), mime: "image/jpeg", thumb: picture("image/jpeg"), ms: 9 });
    expect(await useScan.getState().closePage()).toBe(true);
    expect(useScan.getState().phase).toEqual({ step: "queue" });
    // Page 7 deleted, page 2 retaken through the camera (it keeps its place).
    useScan.getState().remove(ids[6] ?? "");
    useScan.getState().retakePage(ids[1] ?? "");
    expect(useScan.getState().phase).toEqual({ step: "camera" });
    await capture();
    const adjust = useScan.getState().phase;
    if (adjust.step !== "adjust") throw new Error(adjust.step);
    expect(adjust.still.target).toEqual({ kind: "replace", id: ids[1] });
    await keepPage("image/png");
    expect(useScan.getState().phase).toEqual({ step: "queue" });
    expect(useScan.getState().retaking).toBeNull();

    const order = [ids[2], ids[0], ids[1], ids[3], ids[4], ids[5], ids[7], ids[8], ids[9]];
    expect(useScan.getState().pages.map((p) => p.id)).toEqual(order);
    expect(useScan.getState().pages.find((p) => p.id === ids[4])?.edits.turns).toBe(1);
    expect(useScan.getState().pages.find((p) => p.id === ids[1])?.mime).toBe("image/png");

    session.add.mockResolvedValue(1);
    session.finish.mockResolvedValue(new ArrayBuffer(8));
    upload.mockResolvedValue("u1");
    importUpload.mockResolvedValue({ document: doc, duplicate: false });
    expect(await useScan.getState().save("Scan")).toEqual({ kind: "created", document: doc });
    expect(session.add).toHaveBeenCalledTimes(9);
    expect(session.add.mock.calls[2]?.[1]).toBe("image/png");
  });

  it("a page: corners, filter and touch-ups are edited from its page screen", async () => {
    await useScan.getState().open();
    const [id] = await scanPages(1);
    useScan.getState().showQueue();
    client.still.mockResolvedValueOnce(stillOf());
    await useScan.getState().openPage(id ?? "");
    useScan.getState().editPage({ filter: "bw" });
    const stroke = { radius: 0.02, points: [[0.1, 0.1] as const, [0.4, 0.1] as const] };
    useScan.getState().addStroke(stroke);
    useScan.getState().addStroke(stroke);
    useScan.getState().undoStroke();
    useScan.getState().adjustPage();
    const adjusting = useScan.getState().phase;
    if (adjusting.step !== "adjust") throw new Error(adjusting.step);
    expect(adjusting.still.target).toEqual({ kind: "edit", id });
    const moved: Quad = [[30, 30], QUAD[1], QUAD[2], QUAD[3]];
    useScan.getState().setQuad(moved);
    expect(await useScan.getState().keep()).toBe(true);
    // Back on the page screen with the new corners; nothing kept yet.
    const editing = useScan.getState().phase;
    if (editing.step !== "page") throw new Error(editing.step);
    expect(editing.page.edits).toEqual({ quad: moved, filter: "bw", strokes: [stroke], turns: 0 });
    expect(client.keep).toHaveBeenCalledTimes(1);
    client.keep.mockResolvedValueOnce({ page: picture("image/png"), mime: "image/png", thumb: picture("image/jpeg"), ms: 9 });
    await useScan.getState().closePage();
    expect(client.keep).toHaveBeenLastCalledWith({ quad: moved, filter: "bw", strokes: [stroke], turns: 0 }, 6_000_000, 360);
    expect(useScan.getState().pages[0]?.edits.filter).toBe("bw");
  });

  it("leaving a page unchanged lets its still go without rendering it again", async () => {
    await useScan.getState().open();
    const [id] = await scanPages(1);
    useScan.getState().showQueue();
    client.still.mockResolvedValueOnce(stillOf());
    await useScan.getState().openPage(id ?? "");
    client.drop.mockClear();
    await useScan.getState().closePage();
    expect(client.drop).toHaveBeenCalled();
    expect(client.keep).toHaveBeenCalledTimes(1);
  });

  it("stops at the memory cap of the device tier and offers to save", async () => {
    await useScan.getState().open();
    // A low-tier device holds 120 MB; pages of about 41 MB (photo + page) reach it on the third.
    const big = (mb: number) => new Blob([new Uint8Array(mb * 1024 * 1024)], { type: "image/jpeg" });
    for (let i = 0; i < 3; i++) {
      client.still.mockResolvedValueOnce(stillOf());
      await useScan.getState().capture(() => Promise.resolve({ kind: "blob", blob: big(21) }));
      await keepPage("image/jpeg", { kind: "blob", blob: big(20), width: 30, height: 40 });
    }
    expect(useScan.getState().full).toBe(true);
    expect(await capture()).toBe(false);
    useScan.getState().showQueue();
    useScan.getState().remove(useScan.getState().pages[0]?.id ?? "");
    expect(useScan.getState().full).toBe(false);
  });

  it("an ID card: front and back, then one A4 sheet", async () => {
    await useScan.getState().open();
    useScan.getState().setMode("idcard");
    expect(client.resetAuto).toHaveBeenCalled();
    await capture();
    const front = useScan.getState().phase;
    if (front.step !== "adjust") throw new Error(front.step);
    // Cards keep their colours: Original by default.
    expect(front.still.filter).toBe("original");
    await keepPage("image/jpeg", { kind: "blob", blob: blob("image/jpeg"), width: 856, height: 540 });
    expect(useScan.getState().phase).toEqual({ step: "camera" });
    await capture();
    await keepPage("image/jpeg", { kind: "blob", blob: blob("image/jpeg"), width: 850, height: 545 });
    // Both sides: straight to the review; the mode is fixed now.
    expect(useScan.getState().phase).toEqual({ step: "queue" });
    useScan.getState().setMode("document");
    expect(useScan.getState().mode).toBe("idcard");

    session.addSheet.mockResolvedValue(1);
    session.finish.mockResolvedValue(new ArrayBuffer(8));
    upload.mockResolvedValue("u1");
    importUpload.mockResolvedValue({ document: doc, duplicate: false });
    expect(await useScan.getState().save("ID card")).toEqual({ kind: "created", document: doc });
    expect(session.add).not.toHaveBeenCalled();
    const [width, height, items] = session.addSheet.mock.calls[0] ?? [0, 0, []];
    const mm = (pt: number) => (pt * 25.4) / 72;
    expect(mm(width)).toBeCloseTo(210, 1);
    expect(mm(height)).toBeCloseTo(297, 1);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(mm(item.box.width)).toBeCloseTo(85.6, 1);
      expect(mm(item.box.height)).toBeCloseTo(54, 1);
    }
  });

  describe("automatic capture in a batch", () => {
    const photo = () => Promise.resolve({ kind: "blob" as const, blob: blob("image/jpeg") });
    const kept = (): KeptPage => ({ page: picture("image/jpeg"), mime: "image/jpeg", thumb: picture("image/jpeg"), ms: 7 });

    it("keeps a confident page at once with the default filter once a page is kept", async () => {
      await useScan.getState().open();
      // The first page always goes through Adjust.
      client.still.mockResolvedValueOnce(stillOf());
      expect(await useScan.getState().autoCapture(photo, 0.99)).toBe("adjust");
      expect(useScan.getState().phase.step).toBe("adjust");
      await keepPage();
      client.still.mockResolvedValueOnce(stillOf());
      client.keep.mockResolvedValueOnce(kept());
      expect(await useScan.getState().autoCapture(photo, 0.9)).toBe("kept");
      expect(client.keep).toHaveBeenLastCalledWith({ quad: QUAD, filter: "enhance", strokes: [], turns: 0 }, 6_000_000, 360);
      expect(useScan.getState().phase).toEqual({ step: "camera" });
      expect(useScan.getState().pages).toHaveLength(2);
      expect(useScan.getState().pages[1]?.edits.filter).toBe("enhance");
    });

    it("keeps a page the still missed with the live outline when the still has the frame's shape", async () => {
      await useScan.getState().open();
      await scanPages(1);
      // Live frame 240 × 320 (3:4); still 300 × 400 (3:4): the live outline, scaled.
      const live = { quad: [[8, 8], [232, 10], [230, 310], [10, 312]] as Quad, width: 240, height: 320 };
      client.still.mockResolvedValueOnce({ ...stillOf(), quad: null });
      client.keep.mockResolvedValueOnce(kept());
      expect(await useScan.getState().autoCapture(photo, 0.95, live)).toBe("kept");
      expect(client.keep.mock.lastCall?.[0].quad).toEqual([
        [10, 10],
        [290, 12.5],
        [287.5, 387.5],
        [12.5, 390],
      ]);
      // A still of another shape (a 4:3 photo from a 16:9 preview) goes through Adjust.
      client.still.mockResolvedValueOnce({ ...stillOf(), quad: null });
      expect(await useScan.getState().autoCapture(photo, 0.95, { ...live, width: 180, height: 320 })).toBe("adjust");
    });

    it("opens Adjust for a doubtful outline, a page not found in the still, a retake or an ID card", async () => {
      await useScan.getState().open();
      await scanPages(1);
      // Edge support under 85 %.
      client.still.mockResolvedValueOnce(stillOf());
      expect(await useScan.getState().autoCapture(photo, 0.8)).toBe("adjust");
      useScan.getState().retake();
      // Confident live outline, but the still has no page.
      client.still.mockResolvedValueOnce({ ...stillOf(), quad: null });
      expect(await useScan.getState().autoCapture(photo, 0.95)).toBe("adjust");
      useScan.getState().retake();
      // A retake from the review.
      useScan.getState().showQueue();
      useScan.getState().retakePage(useScan.getState().pages[0]?.id ?? "");
      client.still.mockResolvedValueOnce(stillOf());
      expect(await useScan.getState().autoCapture(photo, 0.95)).toBe("adjust");
      expect(client.keep).toHaveBeenCalledTimes(1);

      useScan.getState().close();
      await useScan.getState().open();
      useScan.getState().setMode("idcard");
      await capture();
      await keepPage();
      client.still.mockResolvedValueOnce(stillOf());
      expect(await useScan.getState().autoCapture(photo, 0.99)).toBe("adjust");
    });
  });
});

