/**
 * OCR → searchable PDF (P4d, ADR 0018; docs/design/p4-ui-brief.md §8). One job per open
 * document: each page is rendered by the engine at 300 dpi (within the device's bitmap
 * limit), read by Tesseract in its worker (@selis/ocr), and gets an invisible text layer as an
 * edit of the viewer's EditSession — so every finished page is autosaved with the working copy
 * (an interrupted job keeps its pages, even across a crash), undo works, and the end of the job
 * is one new version. Pages that already have text are skipped unless asked for.
 */
import type { DocHandle } from "@selis/engine";
import { appOcrPaths, createOcr, layoutWords, type Ocr, type OcrLanguages } from "@selis/ocr";
import { simdSupported } from "@selis/scan";
import { create } from "zustand";
import type { Command, EditSession } from "../annotate/session";

/** Pages with at least this many characters of their own text count as having text. */
export const MIN_TEXT_CHARS = 20;
/** Render resolution for Tesseract (A4 at 300 dpi: 2480 × 3508), clamped to the device tier. */
export const OCR_DPI = 300;

export type OcrPhase =
  | { step: "idle" }
  | { step: "preparing" }
  | { step: "running"; done: number; total: number; page: number }
  | { step: "stopped"; done: number; total: number; reason: "cancelled" | "failed" }
  | { step: "finishing"; total: number };

export type OcrOutcome = { kind: "saved"; pages: number } | { kind: "nothingToDo" } | { kind: "stopped" } | { kind: "failed" };

type Job = {
  readonly docId: string;
  readonly doc: DocHandle;
  readonly session: EditSession;
  readonly languages: OcrLanguages;
  /** Pages still to read, in order. */
  queue: number[];
  readonly total: number;
  done: number;
};

type OcrState = {
  phase: OcrPhase;
  docId: string | null;
  languages: OcrLanguages;
  includeText: boolean;
  setLanguages: (languages: OcrLanguages) => void;
  setIncludeText: (include: boolean) => void;
  start: (docId: string, doc: DocHandle, session: EditSession) => Promise<OcrOutcome>;
  cancel: () => void;
  resume: () => Promise<OcrOutcome>;
  /** The viewer closed or another document opened: the job ends where it is. */
  reset: () => void;
};

let job: Job | null = null;
let ocr: Ocr | null = null;
/** Bumped by cancel/reset: a running loop sees it changed and stops. */
let generation = 0;

function assetsBase(): string {
  return new URL("ocr/", document.baseURI).href;
}

async function engineOcr(languages: OcrLanguages): Promise<Ocr> {
  ocr ??= await createOcr(languages, appOcrPaths(assetsBase(), simdSupported()));
  return ocr;
}

function dropOcr(): void {
  const current = ocr;
  ocr = null;
  void current?.terminate().catch(() => undefined);
}

/** The text layer of one page as an undoable edit. */
function textLayerCommand(doc: DocHandle, page: number, words: Parameters<DocHandle["setTextLayer"]>[1]): Command {
  let replaced: Awaited<ReturnType<DocHandle["setTextLayer"]>> = [];
  return {
    tool: "ocr",
    apply: async () => {
      replaced = await doc.setTextLayer(page, words);
    },
    revert: async () => {
      await doc.setTextLayer(page, replaced);
    },
  };
}

export const useOcr = create<OcrState>()((set, get) => {
  const runQueue = async (): Promise<OcrOutcome> => {
    const current = job;
    if (!current) return { kind: "failed" };
    const mine = generation;
    try {
      const reader = await engineOcr(current.languages);
      while (current.queue.length > 0) {
        if (mine !== generation) return { kind: "stopped" };
        const page = current.queue[0] ?? 0;
        set({ phase: { step: "running", done: current.done, total: current.total, page } });
        const started = performance.now();
        const image = await current.doc.exportPageImage(page, { dpi: OCR_DPI, format: "png" });
        const size = current.doc.pages[page];
        if (!size) throw new Error(`page ${String(page)} is gone`);
        // The engine may have rendered below 300 dpi (device limit): tell Tesseract the truth.
        const dpi = (image.width / size.width) * 72;
        const read = await reader.recognize(new Uint8Array(image.bytes), dpi);
        if (mine !== generation) return { kind: "stopped" };
        const words = layoutWords(read, size.width, size.height);
        await current.session.run(textLayerCommand(current.doc, page, words));
        current.queue.shift();
        current.done += 1;
        console.info(
          `[selis:perf] ocr page=${String(page + 1)} ms=${String(Math.round(performance.now() - started))} dpi=${String(Math.round(dpi))} px=${String(image.width)}x${String(image.height)} words=${String(words.length)}`,
        );
      }
      set({ phase: { step: "finishing", total: current.total } });
      await current.session.commit();
      dropOcr();
      job = null;
      set({ phase: { step: "idle" }, docId: null });
      return { kind: "saved", pages: current.total };
    } catch (err) {
      if (mine !== generation) return { kind: "stopped" };
      console.warn("selis: OCR failed", err);
      dropOcr();
      set({ phase: { step: "stopped", done: current.done, total: current.total, reason: "failed" } });
      return { kind: "failed" };
    }
  };

  return {
    phase: { step: "idle" },
    docId: null,
    languages: "ell+eng",
    includeText: false,
    setLanguages: (languages) => set({ languages }),
    setIncludeText: (includeText) => set({ includeText }),

    start: async (docId, doc, session) => {
      if (get().phase.step === "running" || get().phase.step === "preparing" || get().phase.step === "finishing") return { kind: "failed" };
      get().reset();
      set({ phase: { step: "preparing" }, docId });
      const mine = generation;
      try {
        const { languages, includeText } = get();
        const queue: number[] = [];
        for (let page = 0; page < doc.pageCount; page++) {
          if (includeText) {
            queue.push(page);
            continue;
          }
          const info = await doc.pageTextInfo(page);
          if (!info.ocr && info.chars < MIN_TEXT_CHARS) queue.push(page);
        }
        if (mine !== generation) return { kind: "stopped" };
        if (queue.length === 0) {
          set({ phase: { step: "idle" }, docId: null });
          return { kind: "nothingToDo" };
        }
        job = { docId, doc, session, languages, queue, total: queue.length, done: 0 };
        return await runQueue();
      } catch (err) {
        console.warn("selis: OCR could not start", err);
        set({ phase: { step: "idle" }, docId: null });
        return { kind: "failed" };
      }
    },

    cancel: () => {
      const phase = get().phase;
      if (phase.step !== "running" || !job) return;
      generation += 1;
      // Stops the page being read now; the finished pages stay (they are edits already).
      dropOcr();
      set({ phase: { step: "stopped", done: job.done, total: job.total, reason: "cancelled" } });
    },

    resume: async () => {
      if (get().phase.step !== "stopped" || !job) return { kind: "failed" };
      generation += 1;
      return runQueue();
    },

    reset: () => {
      generation += 1;
      dropOcr();
      job = null;
      set({ phase: { step: "idle" }, docId: null });
    },
  };
});
