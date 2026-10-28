/**
 * Viewer → Export (P7c, ADR 0035): the open document as an editable Word file (text,
 * headings, emphasis and images in place; scanned pages read by OCR first), as text or
 * Markdown, or every page as an image in a ZIP. The file goes to the share sheet; the
 * document is not changed.
 */
import type { DocHandle } from "@selis/engine";
import { create } from "zustand";
import { api } from "../../lib/api";
import { upload } from "../../lib/save";

export type ExportKind = "docx" | "txt" | "md" | "images";
export type ImageFormat = "png" | "jpeg";

export type ExportView =
  | { step: "menu" }
  | { step: "images" }
  | { step: "running"; kind: ExportKind; done: number; total: number }
  | { step: "done" };

/** Outcomes shown as a toast (i18n keys under `export.`). */
export type ExportNotice = "shared" | "failed" | "cancelled";

type ExportState = {
  doc: DocHandle | null;
  title: string;
  view: ExportView;
  notice: { key: ExportNotice; error: boolean; seq: number } | null;
  open: (doc: DocHandle, title: string) => void;
  close: () => void;
  show: (view: ExportView) => void;
  run: (kind: ExportKind, format?: ImageFormat) => Promise<void>;
};

const MIME: Record<Exclude<ExportKind, "images">, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
};

/** Images in the Word file and the ZIP: 150 dpi, a sharp print and a modest file. */
const IMAGE_DPI = 150;

let noticeSeq = 0;
let runToken = 0;

export const useExport = create<ExportState>()((set, get) => ({
  doc: null,
  title: "",
  view: { step: "menu" },
  notice: null,

  open: (doc, title) => set({ doc, title, view: { step: "menu" } }),

  close: () => {
    runToken++;
    set({ doc: null, title: "", view: { step: "menu" } });
  },

  show: (view) => set({ view }),

  run: async (kind, format = "png") => {
    const { doc, title, view } = get();
    if (!doc || view.step === "running") return;
    const token = ++runToken;
    let release: () => void = () => undefined;
    const live = () => token === runToken;
    const notify = (key: ExportNotice, error = false) => set({ notice: { key, error, seq: ++noticeSeq } });
    const total = doc.pageCount;
    const progress = (done: number) => {
      if (live()) set({ view: { step: "running", kind, done, total } });
    };
    progress(0);
    try {
      // Loaded only now: the converters, OCR and docx writer stay out of the startup bundle.
      const [convert, { readPageContent, releaseExportOcr }] = await Promise.all([import("@selis/convert/app"), import("./pageContent")]);
      release = releaseExportOcr;
      let bytes: Uint8Array;
      let name: string;
      let mime: string;
      if (kind === "images") {
        const files: Array<{ name: string; data: Uint8Array }> = [];
        const ext = format === "png" ? "png" : "jpg";
        for (let i = 0; i < total; i++) {
          if (!live()) return;
          const image = await doc.exportPageImage(i, { dpi: IMAGE_DPI, format });
          files.push({ name: convert.pageFileName(i, total, ext), data: new Uint8Array(image.bytes) });
          progress(i + 1);
        }
        bytes = await convert.zipFiles(files);
        name = `${title} pages.zip`;
        mime = "application/zip";
      } else {
        const pages = [];
        const images = new Map<string, { type: "png" | "jpg"; data: Uint8Array }>();
        for (let i = 0; i < total; i++) {
          if (!live()) return;
          const content = await readPageContent(doc, i);
          pages.push(content.page);
          if (kind === "docx") {
            for (const [index, image] of content.images(IMAGE_DPI)) images.set(`${String(i)}:${String(index)}`, await image);
          }
          progress(i + 1);
        }
        const structured = convert.structureDocument(pages);
        if (kind === "docx") bytes = await convert.toDocx(structured, images, title);
        else bytes = new TextEncoder().encode(kind === "md" ? convert.toMarkdown(structured) : convert.toPlainText(structured));
        name = `${title}.${kind}`;
        mime = MIME[kind];
      }
      if (!live()) return;
      const shared = await api.shareExport(await upload(bytes.slice().buffer), name, mime);
      if (!live()) return;
      set({ doc: null, title: "", view: { step: "menu" } });
      notify(shared ? "shared" : "cancelled");
    } catch (err) {
      console.warn("selis: export failed", err);
      if (!live()) return;
      set({ view: { step: "menu" } });
      notify("failed", true);
    } finally {
      release();
    }
  },
}));
