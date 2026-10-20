/**
 * Low-level PDFium page-object queries that EmbedPDF does not expose. Shared by
 * the worker and the Node tests (pdfium.node.test.ts), which pin this to the
 * EmbedPDF version in package.json.
 */
import type { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { PdfDocumentObject, PdfPageObject } from "@embedpdf/models";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { fromPdfBounds, type PageRect } from "./geometry";
import type { PageObjectInfo, PageObjectKind, PageSize, Point } from "./types";

/** FPDF_PAGEOBJ_IMAGE */
const PAGEOBJ_IMAGE = 3;
/** FPDF_PAGEOBJ_* 1–5. */
const KINDS: Record<number, PageObjectKind> = { 1: "text", 2: "path", 3: "image", 4: "shading", 5: "form" };

type Converter = {
  convertDevicePointToPagePoint(doc: PdfDocumentObject, page: PdfPageObject, p: Point): Point;
  convertPagePointToDevicePoint(doc: PdfDocumentObject, page: PdfPageObject, p: Point): Point;
};

/**
 * A point on the page as the viewer draws it (points, top-left origin, page
 * rotation applied) in PDF user space, with EmbedPDF's own conversion: the same
 * one its redaction uses for the quads.
 */
export function toUserSpace(engine: PdfiumNative, doc: PdfDocumentObject, page: PdfPageObject, p: Point): Point {
  return (engine as unknown as Converter).convertDevicePointToPagePoint(doc, page, p);
}

/** The reverse of toUserSpace. */
export function fromUserSpace(engine: PdfiumNative, doc: PdfDocumentObject, page: PdfPageObject, p: Point): Point {
  return (engine as unknown as Converter).convertPagePointToDevicePoint(doc, page, p);
}

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

/** Reads FPDFPageObj_GetBounds into user-space corners, or null. */
function boundsOf(pdf: WrappedPdfiumModule, obj: number, buf: number): [number, number, number, number] | null {
  if (!pdf.FPDFPageObj_GetBounds(obj, buf, buf + 4, buf + 8, buf + 12)) return null;
  const getValue = pdf.pdfium.getValue as unknown as (ptr: number, type: "float") => number;
  return [getValue(buf, "float"), getValue(buf + 4, "float"), getValue(buf + 8, "float"), getValue(buf + 12, "float")];
}

/**
 * The page's top-level objects in drawing order (P7b "Delete object"): kind and
 * bounds as the viewer draws the page. A form XObject is one object.
 */
export function pageObjects(engine: PdfiumNative, pdf: WrappedPdfiumModule, docPtr: number, doc: PdfDocumentObject, page: PdfPageObject): PageObjectInfo[] {
  const pagePtr = pdf.FPDF_LoadPage(docPtr, page.index);
  if (!pagePtr) return [];
  const buf = pdf.pdfium.wasmExports.malloc(16);
  const out: PageObjectInfo[] = [];
  try {
    const count = pdf.FPDFPage_CountObjects(pagePtr);
    for (let i = 0; i < count; i++) {
      const obj = pdf.FPDFPage_GetObject(pagePtr, i);
      const kind = KINDS[pdf.FPDFPageObj_GetType(obj)];
      const b = kind ? boundsOf(pdf, obj, buf) : null;
      if (!kind || !b) continue;
      const a = fromUserSpace(engine, doc, page, { x: b[0], y: b[1] });
      const c = fromUserSpace(engine, doc, page, { x: b[2], y: b[3] });
      const rect = { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), width: Math.abs(c.x - a.x), height: Math.abs(c.y - a.y) };
      out.push({ index: i, kind, rect });
    }
  } finally {
    pdf.pdfium.wasmExports.free(buf);
    pdf.FPDF_ClosePage(pagePtr);
  }
  return out;
}

/**
 * Removes the top-level object `target.index` from the page and rewrites the
 * page content. The object there must still be the one the user picked (same
 * kind and bounds within 0.5 pt), or nothing is removed and false comes back.
 */
export function removePageObject(
  engine: PdfiumNative,
  pdf: WrappedPdfiumModule,
  docPtr: number,
  doc: PdfDocumentObject,
  page: PdfPageObject,
  target: PageObjectInfo,
): boolean {
  const now = pageObjects(engine, pdf, docPtr, doc, page).find((o) => o.index === target.index);
  const close = (a: number, b: number) => Math.abs(a - b) <= 0.5;
  if (
    !now ||
    now.kind !== target.kind ||
    !close(now.rect.x, target.rect.x) ||
    !close(now.rect.y, target.rect.y) ||
    !close(now.rect.width, target.rect.width) ||
    !close(now.rect.height, target.rect.height)
  ) {
    return false;
  }
  const pagePtr = pdf.FPDF_LoadPage(docPtr, page.index);
  if (!pagePtr) return false;
  try {
    const obj = pdf.FPDFPage_GetObject(pagePtr, target.index);
    if (!obj || !pdf.FPDFPage_RemoveObject(pagePtr, obj)) return false;
    pdf.FPDFPageObj_Destroy(obj);
    return pdf.FPDFPage_GenerateContent(pagePtr);
  } finally {
    pdf.FPDF_ClosePage(pagePtr);
  }
}
