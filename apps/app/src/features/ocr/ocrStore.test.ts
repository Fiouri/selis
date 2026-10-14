import type { DocHandle, PageTextInfo, TextLayerWord } from "@selis/engine";
import type * as OcrModule from "@selis/ocr";
import type { OcrPage } from "@selis/ocr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditSession } from "../annotate/session";

const recognize = vi.fn<(image: Blob | Uint8Array, dpi: number) => Promise<OcrPage>>();
const terminate = vi.fn<() => Promise<void>>();
const createOcr = vi.fn(() => Promise.resolve({ recognize, terminate }));

vi.mock("@selis/ocr", async (importOriginal) => {
  const actual = await importOriginal<typeof OcrModule>();
  return { ...actual, createOcr };
});

const { useOcr } = await import("./ocrStore");

const PAGE: OcrPage = {
  width: 1240,
  height: 1754,
  lines: [
    {
      bbox: { x0: 100, y0: 100, x1: 400, y1: 140 },
      baseline: { x0: 100, y0: 132, x1: 400, y1: 132 },
      words: [{ text: "Σελίς", confidence: 90, bbox: { x0: 100, y0: 100, x1: 220, y1: 140 } }],
    },
  ],
};

type FakeDoc = DocHandle & { layers: Map<number, TextLayerWord[]>; exported: number[] };

function fakeDoc(texts: PageTextInfo[]): FakeDoc {
  const layers = new Map<number, TextLayerWord[]>();
  const exported: number[] = [];
  const doc = {
    id: "doc",
    pageCount: texts.length,
    pages: texts.map(() => ({ width: 595.28, height: 841.89 })),
    layers,
    exported,
    exportPageImage: (i: number) => {
      exported.push(i);
      return Promise.resolve({ bytes: new ArrayBuffer(8), mime: "image/png", width: 1240, height: 1754 });
    },
    pageTextInfo: vi.fn((i: number) => Promise.resolve(texts[i] ?? { chars: 0, ocr: false })),
    setTextLayer: vi.fn((i: number, words: readonly TextLayerWord[]) => {
      const before = layers.get(i) ?? [];
      layers.set(i, [...words]);
      return Promise.resolve(before);
    }),
    save: vi.fn(() => Promise.resolve(new ArrayBuffer(4))),
  };
  return doc as unknown as FakeDoc;
}

function session(doc: DocHandle) {
  const saveVersion = vi.fn(() => Promise.resolve({ document: { blake3: "next" } } as never));
  const s = new EditSession(doc, "doc", "base", {
    saveWorkingCopy: vi.fn(() => Promise.resolve({} as never)),
    saveVersion,
    setTimer: () => 0,
    clearTimer: () => undefined,
  });
  return { s, saveVersion };
}

describe("OCR job", () => {
  beforeEach(() => {
    recognize.mockReset();
    terminate.mockReset().mockResolvedValue();
    createOcr.mockClear();
    useOcr.getState().reset();
    useOcr.setState({ languages: "ell+eng", includeText: false });
  });

  it("reads the pages without text, adds each layer as an edit and saves one version", async () => {
    const doc = fakeDoc([
      { chars: 0, ocr: false },
      { chars: 400, ocr: false },
      { chars: 3, ocr: false },
    ]);
    const { s, saveVersion } = session(doc);
    recognize.mockResolvedValue(PAGE);
    const outcome = await useOcr.getState().start("doc", doc, s);
    expect(outcome).toEqual({ kind: "saved", pages: 2 });
    // Page 2 has its own text: skipped. 300 dpi asked; the PNG came back at 150 dpi.
    expect(doc.exported).toEqual([0, 2]);
    expect(recognize.mock.calls[0]?.[1]).toBeCloseTo(150, 0);
    expect(doc.layers.get(0)?.[0]?.text).toBe("Σελίς");
    expect(doc.layers.has(1)).toBe(false);
    expect(saveVersion).toHaveBeenCalledTimes(1);
    expect(s.state.canUndo).toBe(true);
    // Undo takes the last page's layer away again.
    await s.undo();
    expect(doc.layers.get(2)).toEqual([]);
    expect(useOcr.getState().phase).toEqual({ step: "idle" });
    expect(terminate).toHaveBeenCalled();
  });

  it("asks for the languages chosen, and can include pages with text", async () => {
    useOcr.setState({ languages: "ell", includeText: true });
    const doc = fakeDoc([{ chars: 400, ocr: false }]);
    recognize.mockResolvedValue(PAGE);
    expect(await useOcr.getState().start("doc", doc, session(doc).s)).toEqual({ kind: "saved", pages: 1 });
    expect(createOcr.mock.calls[0]).toEqual(["ell", expect.objectContaining({ langPath: expect.stringMatching(/\/ocr\/tessdata$/) as unknown })]);
  });

  it("says when every page already has text", async () => {
    const doc = fakeDoc([{ chars: 400, ocr: false }, { chars: 0, ocr: true }]);
    expect(await useOcr.getState().start("doc", doc, session(doc).s)).toEqual({ kind: "nothingToDo" });
    expect(createOcr).not.toHaveBeenCalled();
  });

  it("cancel keeps the finished pages; resume reads the rest", async () => {
    const doc = fakeDoc([
      { chars: 0, ocr: false },
      { chars: 0, ocr: false },
    ]);
    const { s, saveVersion } = session(doc);
    let releaseSecond: (page: OcrPage) => void = () => undefined;
    recognize.mockResolvedValueOnce(PAGE).mockImplementationOnce(() => new Promise((resolve) => (releaseSecond = resolve)));
    const run = useOcr.getState().start("doc", doc, s);
    await vi.waitFor(() => expect(useOcr.getState().phase).toMatchObject({ step: "running", done: 1, total: 2 }));
    useOcr.getState().cancel();
    expect(useOcr.getState().phase).toEqual({ step: "stopped", done: 1, total: 2, reason: "cancelled" });
    releaseSecond(PAGE);
    expect(await run).toEqual({ kind: "stopped" });
    expect(doc.layers.has(0)).toBe(true);
    expect(doc.layers.has(1)).toBe(false);
    expect(saveVersion).not.toHaveBeenCalled();

    recognize.mockResolvedValue(PAGE);
    expect(await useOcr.getState().resume()).toEqual({ kind: "saved", pages: 2 });
    expect(doc.layers.has(1)).toBe(true);
    // A new Tesseract worker for the resumed job (the cancelled one was stopped).
    expect(createOcr).toHaveBeenCalledTimes(2);
  });

  it("stops with the reason when a page cannot be read", async () => {
    const doc = fakeDoc([{ chars: 0, ocr: false }]);
    recognize.mockRejectedValue(new Error("worker crashed"));
    expect(await useOcr.getState().start("doc", doc, session(doc).s)).toEqual({ kind: "failed" });
    expect(useOcr.getState().phase).toEqual({ step: "stopped", done: 0, total: 1, reason: "failed" });
  });
});
