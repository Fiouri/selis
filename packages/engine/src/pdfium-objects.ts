/**
 * Low-level PDFium page-object queries that EmbedPDF does not expose. Shared by
 * the worker and the Node tests (pdfium.node.test.ts), which pin this to the
 * EmbedPDF version in package.json.
 */
import type { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { fromPdfBounds, type PageRect } from "./geometry";
import type { PageSize } from "./types";

/** FPDF_PAGEOBJ_IMAGE */
const PAGEOBJ_IMAGE = 3;

/**
 * The PDFium document pointer behind an EmbedPDF document, read from its
 * internal cache. Returns null if EmbedPDF's internals ever change shape.
 */
export function documentPointer(engine: PdfiumNative, docId: string): number | null {
  const cache = (engine as unknown as { cache?: { getContext?: (id: string) => { docPtr?: unknown } | undefined } }).cache;
  const ptr = cache?.getContext?.(docId)?.docPtr;
  return typeof ptr === "number" && ptr !== 0 ? ptr : null;
}

/** Bounds of every image object on a page (page points, top-left origin). */
export function imageRectsOnPage(pdf: WrappedPdfiumModule, docPtr: number, index: number, size: PageSize): PageRect[] {
  const pagePtr = pdf.FPDF_LoadPage(docPtr, index);
  if (!pagePtr) return [];
  const rects: PageRect[] = [];
  // Emscripten helper; its types come from @types/emscripten, which is not installed.
  const getValue = pdf.pdfium.getValue as unknown as (ptr: number, type: "float") => number;
  const bounds = pdf.pdfium.wasmExports.malloc(16);
  try {
    const count = pdf.FPDFPage_CountObjects(pagePtr);
    for (let i = 0; i < count; i++) {
      const obj = pdf.FPDFPage_GetObject(pagePtr, i);
      if (pdf.FPDFPageObj_GetType(obj) !== PAGEOBJ_IMAGE) continue;
      if (!pdf.FPDFPageObj_GetBounds(obj, bounds, bounds + 4, bounds + 8, bounds + 12)) continue;
      const read = (offset: number) => getValue(bounds + offset, "float");
      rects.push(fromPdfBounds(read(0), read(4), read(8), read(12), size));
    }
  } finally {
    pdf.pdfium.wasmExports.free(bounds);
    pdf.FPDF_ClosePage(pagePtr);
  }
  return rects;
}
