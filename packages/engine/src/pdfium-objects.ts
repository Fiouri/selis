/**
 * Low-level PDFium page-object queries that EmbedPDF does not expose. Shared by
 * the worker and the Node tests (pdfium.node.test.ts), which pin this to the
 * EmbedPDF version in package.json.
 */
import type { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { PdfDocumentObject, PdfPageObject } from "@embedpdf/models";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import type { PageRect } from "./geometry";
import type { PageObjectInfo, PageObjectKind, Point } from "./types";

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

/** Bounds of every image object on a page as the viewer draws it (points, top-left origin, /Rotate applied). */
export function imageRectsOnPage(engine: PdfiumNative, pdf: WrappedPdfiumModule, docPtr: number, doc: PdfDocumentObject, page: PdfPageObject): PageRect[] {
  const pagePtr = pdf.FPDF_LoadPage(docPtr, page.index);
  if (!pagePtr) return [];
  const rects: PageRect[] = [];
  const buf = pdf.pdfium.wasmExports.malloc(16);
  try {
    const count = pdf.FPDFPage_CountObjects(pagePtr);
    for (let i = 0; i < count; i++) {
      const obj = pdf.FPDFPage_GetObject(pagePtr, i);
      if (pdf.FPDFPageObj_GetType(obj) !== PAGEOBJ_IMAGE) continue;
      const b = boundsOf(pdf, obj, buf);
      if (b) rects.push(shownRect(engine, doc, page, b));
    }
  } finally {
    pdf.pdfium.wasmExports.free(buf);
    pdf.FPDF_ClosePage(pagePtr);
  }
  return rects;
}

/** User-space bounds (left, bottom, right, top) as a rect on the page as shown. */
function shownRect(engine: PdfiumNative, doc: PdfDocumentObject, page: PdfPageObject, b: readonly [number, number, number, number]): PageRect {
  const a = fromUserSpace(engine, doc, page, { x: b[0], y: b[1] });
  const c = fromUserSpace(engine, doc, page, { x: b[2], y: b[3] });
  return { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), width: Math.abs(c.x - a.x), height: Math.abs(c.y - a.y) };
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
      out.push({ index: i, kind, rect: shownRect(engine, doc, page, b) });
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

/** FPDF_REVERSE_BYTE_ORDER: RGBA instead of BGRA. */
const RENDER_RGBA = 0x10;

/** The PDFium module behind an EmbedPDF engine (its internal field), or null. */
export function pdfiumOf(engine: PdfiumNative): WrappedPdfiumModule | null {
  const module = (engine as unknown as { pdfiumModule?: WrappedPdfiumModule }).pdfiumModule;
  return module ?? null;
}

let rasterId = 0;

/**
 * Page `index` of `bytes` rendered whole at `scale` pixels per point on a
 * transparent background (RGBA, not premultiplied), without annotations:
 * the flattening of redaction (flatten.ts).
 */
export async function renderTransparent(engine: PdfiumNative, bytes: Uint8Array, index: number, scale: number): Promise<{ width: number; height: number; data: Uint8Array }> {
  const pdf = pdfiumOf(engine);
  if (!pdf) throw new Error("engine internals unavailable");
  const doc = await engine.openDocumentBuffer({ id: `raster-${rasterId++}`, content: bytes.slice().buffer }).toPromise();
  try {
    const docPtr = documentPointer(engine, doc.id);
    const pagePtr = docPtr === null ? 0 : pdf.FPDF_LoadPage(docPtr, index);
    if (!pagePtr) throw new Error(`cannot load page ${index + 1}`);
    try {
      const width = Math.max(1, Math.round(pdf.FPDF_GetPageWidthF(pagePtr) * scale));
      const height = Math.max(1, Math.round(pdf.FPDF_GetPageHeightF(pagePtr) * scale));
      const bitmap = pdf.FPDFBitmap_Create(width, height, 1);
      if (!bitmap) throw new Error("no memory for the raster");
      try {
        pdf.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0);
        pdf.FPDF_RenderPageBitmap(bitmap, pagePtr, 0, 0, width, height, 0, RENDER_RGBA);
        const stride = pdf.FPDFBitmap_GetStride(bitmap);
        const buffer = pdf.FPDFBitmap_GetBuffer(bitmap);
        const heap = (pdf.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
        const data = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) data.set(heap.subarray(buffer + y * stride, buffer + y * stride + width * 4), y * width * 4);
        return { width, height, data };
      } finally {
        pdf.FPDFBitmap_Destroy(bitmap);
      }
    } finally {
      pdf.FPDF_ClosePage(pagePtr);
    }
  } finally {
    await engine.closeDocument(doc).toPromise();
  }
}
