/**
 * Tools on one document (P4a, ADR 0015; docs/design/p4-ui-brief.md §1–4): the Tools sheet,
 * the password sheets and the result. Every operation that changes the file saves a new
 * version (Rust); the host (viewer or library) is told through `onSaved` and reloads.
 */
import type { DocHandle } from "@selis/engine";
import type { EditSession } from "../annotate/session";
import { create } from "zustand";
import { ApiError, api, type Document, type ProtectionView, type ToolProblem, type ToolRequest } from "../../lib/api";
import { upload } from "../../lib/save";
import { clearThumbnailState, markThumbnailLocked } from "../library/thumbnails";

/** Same floor as `.selispack` passphrases. */
export const MIN_PASSWORD = 8;
/** AES-256 (revision 6) reads at most 127 bytes of a password. */
export const MAX_PASSWORD_BYTES = 127;

export type ToolKind = ToolRequest["kind"];

/** The open document and page, when the Tools sheet comes from the viewer (page export, P4b). */
export type PageContext = {
  readonly doc: DocHandle;
  readonly page: number;
  readonly title: string;
  /** The viewer's edit session: OCR adds its text layer as edits (P4d). */
  readonly session: EditSession | null;
};

export type ExportFormat = "png" | "jpeg";
export const EXPORT_DPIS = [96, 150, 300] as const;
export type ExportDpi = (typeof EXPORT_DPIS)[number];

export type ToolsView =
  | { step: "menu" }
  | { step: "protect" }
  | { step: "unprotect"; wrong: boolean }
  | { step: "running"; kind: ToolKind }
  | { step: "compressed"; inputBytes: number; outputBytes: number }
  | { step: "notSmaller"; inputBytes: number }
  | { step: "export" }
  | { step: "exporting" }
  | { step: "ocr" };

/** One-line outcomes shown as a toast (i18n keys under `tools.`). */
export type ToolsNotice =
  | "saved"
  | "alreadyLinearized"
  | "nothingToRepair"
  | "passwordNeeded"
  | "damaged"
  | "unsupported"
  | "notApplicable"
  | "unsavedEdits"
  | "tooLarge"
  | "exported"
  | "exportFailed"
  | "failed";

type ToolsState = {
  docId: string | null;
  protection: ProtectionView | null;
  view: ToolsView;
  notice: { key: ToolsNotice; error: boolean; seq: number } | null;
  /** The host reloads the document (a new version is current). */
  onSaved: ((document: Document) => void) | null;
  page: PageContext | null;
  open: (docId: string, onSaved: (document: Document) => void, page?: PageContext) => Promise<void>;
  exportPage: (format: ExportFormat, dpi: ExportDpi) => Promise<void>;
  close: () => void;
  show: (view: ToolsView) => void;
  run: (request: ToolRequest) => Promise<void>;
};

let noticeSeq = 0;

function problemNotice(problem: ToolProblem): ToolsNotice {
  return problem === "wrongPassword" ? "failed" : problem;
}

export const useTools = create<ToolsState>()((set, get) => ({
  docId: null,
  protection: null,
  view: { step: "menu" },
  notice: null,
  onSaved: null,
  page: null,

  open: async (docId, onSaved, page) => {
    set({ docId, onSaved, page: page ?? null, protection: null, view: { step: "menu" } });
    try {
      const protection = await api.documentProtection(docId);
      if (get().docId === docId) set({ protection });
    } catch {
      // Unknown: every row stays available; the operation itself reports a problem.
      if (get().docId === docId) set({ protection: "none" });
    }
  },

  close: () => {
    const step = get().view.step;
    if (step === "running" || step === "exporting") return;
    set({ docId: null, protection: null, view: { step: "menu" }, onSaved: null, page: null });
  },

  exportPage: async (format, dpi) => {
    const { page, view } = get();
    if (!page || view.step === "exporting") return;
    const notify = (key: ToolsNotice, error = false) => set({ notice: { key, error, seq: ++noticeSeq } });
    set({ view: { step: "exporting" } });
    try {
      const image = await page.doc.exportPageImage(page.page, { dpi, format });
      const ext = format === "png" ? "png" : "jpg";
      const name = `${page.title} p${String(page.page + 1)}.${ext}`;
      const shared = await api.shareExport(await upload(image.bytes), name, image.mime);
      set({ docId: null, protection: null, view: { step: "menu" }, onSaved: null, page: null });
      if (shared) notify("exported");
    } catch (err) {
      console.warn("selis: page export failed", err);
      set({ view: { step: "export" } });
      notify("exportFailed", true);
    }
  },

  show: (view) => set({ view }),

  run: async (request) => {
    const { docId, view } = get();
    if (!docId || view.step === "running") return;
    const notify = (key: ToolsNotice, error = false) => set({ notice: { key, error, seq: ++noticeSeq } });
    const finish = () => set({ docId: null, protection: null, view: { step: "menu" }, onSaved: null, page: null });
    set({ view: { step: "running", kind: request.kind } });
    let outcome;
    try {
      outcome = await api.runTool(docId, request);
    } catch (err) {
      set({ view: { step: "menu" } });
      notify("failed", true);
      if (!(err instanceof ApiError)) throw err;
      return;
    }
    switch (outcome.status) {
      case "saved": {
        const onSaved = get().onSaved;
        if (request.kind === "protect") markThumbnailLocked(docId);
        if (request.kind === "unprotect") clearThumbnailState(docId);
        if (request.kind === "compress") {
          set({ view: { step: "compressed", inputBytes: outcome.inputBytes, outputBytes: outcome.outputBytes } });
        } else {
          finish();
          notify("saved");
        }
        onSaved?.(outcome.document);
        return;
      }
      case "unchanged":
        if (outcome.reason === "notSmaller") {
          set({ view: { step: "notSmaller", inputBytes: outcome.inputBytes } });
        } else {
          finish();
          notify(outcome.reason);
        }
        return;
      case "refused":
        if (outcome.problem === "wrongPassword") {
          set({ view: { step: "unprotect", wrong: true } });
          return;
        }
        finish();
        notify(problemNotice(outcome.problem), true);
        return;
    }
  },
}));

/** Bytes of a password as AES-256 reads them (UTF-8). */
export function passwordBytes(password: string): number {
  return new TextEncoder().encode(password).length;
}
