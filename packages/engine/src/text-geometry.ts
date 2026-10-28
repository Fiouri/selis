/**
 * Text geometry as the viewer draws the page (points, top-left origin, the
 * page's /Rotate and crop box applied), read from PDFium here rather than
 * through EmbedPDF's `getPageTextRects` / `getPageGeometry`:
 *
 * - `getPageTextRects` maps only a rect's top-left corner to the page as shown
 *   and keeps the unrotated width and height, so on a /Rotate 90 / 180 / 270
 *   page every rect is off (measured: IoU 0 with the drawn glyphs). The text
 *   layer (selection, copy, accessibility) took its boxes from there.
 * - `getPageGeometry` maps two corners through `FPDF_PageToDevice` at 1 px per
 *   point, rounded to whole points.
 *
 * Both map every corner with EmbedPDF's own point conversion (the one its
 * search highlights, annotations and redaction quads use, and toUserSpace), in
 * floating point (ADR 0034; upstream: https://github.com/embedpdf/embed-pdf-viewer/issues/892).
 */
import type { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { PdfDocumentObject, PdfPageObject } from "@embedpdf/models";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import type { PageRect } from "./geometry";
import { fromUserSpace } from "./pdfium-objects";
import type { Glyph } from "./types";

type PageCtx = { pagePtr: number; release(): void };
type DocCtx = { acquirePage(index: number): PageCtx };
type Internals = { cache: { getContext(id: string): DocCtx | undefined } };

/** A text rect as PDFium groups the page's characters (one per line of a text object). */
export type TextBox = PageRect & { readonly fontSize: number };

type Getter = (ptr: number, type: "double" | "float") => number;

/**
 * Runs `use` with a text page of its own for `page` (EmbedPDF's cached one may
 * be closed under it by an OCR layer change).
 */
function withTextPage<T>(engine: PdfiumNative, pdf: WrappedPdfiumModule, doc: PdfDocumentObject, page: PdfPageObject, empty: T, use: (textPage: number) => T): T {
  const ctx = (engine as unknown as Internals).cache.getContext(doc.id);
  if (!ctx) throw new Error("document is not open");
  const pageCtx = ctx.acquirePage(page.index);
  const textPage = pdf.FPDFText_LoadPage(pageCtx.pagePtr);
  try {
    return textPage ? use(textPage) : empty;
  } finally {
    if (textPage) pdf.FPDFText_ClosePage(textPage);
    pageCtx.release();
  }
}

/** User-space bounds (left, top, right, bottom) as a rect on the page as shown. */
function shown(engine: PdfiumNative, doc: PdfDocumentObject, page: PdfPageObject, left: number, top: number, right: number, bottom: number): PageRect {
  const corners = [
    fromUserSpace(engine, doc, page, { x: left, y: top }),
    fromUserSpace(engine, doc, page, { x: right, y: top }),
    fromUserSpace(engine, doc, page, { x: right, y: bottom }),
    fromUserSpace(engine, doc, page, { x: left, y: bottom }),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The page's text rects (`FPDFText_GetRect`), with the font size at each. */
export function pageTextBoxes(engine: PdfiumNative, pdf: WrappedPdfiumModule, doc: PdfDocumentObject, page: PdfPageObject): TextBox[] {
  return withTextPage(engine, pdf, doc, page, [] as TextBox[], (textPage) => {
    const getValue = pdf.pdfium.getValue as unknown as Getter;
    const buf = pdf.pdfium.wasmExports.malloc(32);
    try {
      const out: TextBox[] = [];
      const count = pdf.FPDFText_CountRects(textPage, 0, -1);
      for (let i = 0; i < count; i++) {
        if (!pdf.FPDFText_GetRect(textPage, i, buf, buf + 8, buf + 16, buf + 24)) continue;
        const [left, top, right, bottom] = [0, 8, 16, 24].map((o) => getValue(buf + o, "double")) as [number, number, number, number];
        const at = pdf.FPDFText_GetCharIndexAtPos(textPage, (left + right) / 2, (top + bottom) / 2, Math.abs(right - left) / 2, Math.abs(top - bottom) / 2);
        const rect = shown(engine, doc, page, left, top, right, bottom);
        out.push({ ...rect, fontSize: at >= 0 ? pdf.FPDFText_GetFontSize(textPage, at) : rect.height });
      }
      return out;
    } finally {
      pdf.pdfium.wasmExports.free(buf);
    }
  });
}

/** PDF font descriptor flags (ISO 32000-1, table 123). */
const FONT_ITALIC = 1 << 6;
const FONT_FORCE_BOLD = 1 << 18;

/** A text rect with the style of the character at its centre (reading structure, ADR 0035). */
export type StyledTextBox = TextBox & { readonly bold: boolean; readonly italic: boolean };

/**
 * The page's text rects like `pageTextBoxes`, each with bold and italic: from the font's
 * weight (≥ 600) and descriptor flags, or its name (`…-Bold`, `…Italic`, `…Oblique`) when
 * a simple font says nothing.
 */
export function pageStyledTextBoxes(engine: PdfiumNative, pdf: WrappedPdfiumModule, doc: PdfDocumentObject, page: PdfPageObject): StyledTextBox[] {
  return withTextPage(engine, pdf, doc, page, [] as StyledTextBox[], (textPage) => {
    const getValue = pdf.pdfium.getValue as unknown as Getter;
    const getInt = pdf.pdfium.getValue as unknown as (ptr: number, type: "i32") => number;
    const buf = pdf.pdfium.wasmExports.malloc(32);
    const nameLen = 128;
    const name = pdf.pdfium.wasmExports.malloc(nameLen);
    const flagsPtr = pdf.pdfium.wasmExports.malloc(4);
    try {
      const out: StyledTextBox[] = [];
      const count = pdf.FPDFText_CountRects(textPage, 0, -1);
      for (let i = 0; i < count; i++) {
        if (!pdf.FPDFText_GetRect(textPage, i, buf, buf + 8, buf + 16, buf + 24)) continue;
        const [left, top, right, bottom] = [0, 8, 16, 24].map((o) => getValue(buf + o, "double")) as [number, number, number, number];
        const at = pdf.FPDFText_GetCharIndexAtPos(textPage, (left + right) / 2, (top + bottom) / 2, Math.abs(right - left) / 2, Math.abs(top - bottom) / 2);
        const rect = shown(engine, doc, page, left, top, right, bottom);
        let bold = false;
        let italic = false;
        let fontSize = rect.height;
        if (at >= 0) {
          fontSize = pdf.FPDFText_GetFontSize(textPage, at);
          const length = pdf.FPDFText_GetFontInfo(textPage, at, name, nameLen, flagsPtr);
          const flags = length > 0 ? getInt(flagsPtr, "i32") : 0;
          const fontName = length > 0 ? (pdf.pdfium as unknown as { UTF8ToString: (ptr: number, max: number) => string }).UTF8ToString(name, Math.min(length, nameLen)) : "";
          bold = pdf.FPDFText_GetFontWeight(textPage, at) >= 600 || (flags & FONT_FORCE_BOLD) !== 0 || /bold|black|heavy/i.test(fontName);
          italic = (flags & FONT_ITALIC) !== 0 || /italic|oblique/i.test(fontName);
        }
        out.push({ ...rect, fontSize, bold, italic });
      }
      return out;
    } finally {
      pdf.pdfium.wasmExports.free(buf);
      pdf.pdfium.wasmExports.free(name);
      pdf.pdfium.wasmExports.free(flagsPtr);
    }
  });
}

/**
 * Every character's loose box (`FPDFText_GetLooseCharBox`: the font's ascent to
 * descent, what selection and markup cover) in PDFium's order, with its text
 * object as the run. Characters without a box (generated spaces, line breaks)
 * have a zero size.
 */
export function pageGlyphs(engine: PdfiumNative, pdf: WrappedPdfiumModule, doc: PdfDocumentObject, page: PdfPageObject): Glyph[] {
  return withTextPage(engine, pdf, doc, page, [] as Glyph[], (textPage) => {
    const getValue = pdf.pdfium.getValue as unknown as Getter;
    const buf = pdf.pdfium.wasmExports.malloc(16);
    try {
      const out: Glyph[] = [];
      const count = pdf.FPDFText_CountChars(textPage);
      let run = -1;
      let object = -1;
      for (let i = 0; i < count; i++) {
        const obj = pdf.FPDFText_GetTextObject(textPage, i);
        if (obj !== object) {
          object = obj;
          run++;
        }
        const space = pdf.FPDFText_GetUnicode(textPage, i) === 32;
        // FS_RECTF: left, top, right, bottom.
        const ok = pdf.FPDFText_GetLooseCharBox(textPage, i, buf);
        const [left, top, right, bottom] = [0, 4, 8, 12].map((o) => getValue(buf + o, "float")) as [number, number, number, number];
        if (!ok || left === right || top === bottom) {
          out.push({ x: 0, y: 0, width: 0, height: 0, run, space });
          continue;
        }
        out.push({ ...shown(engine, doc, page, left, top, right, bottom), run, space });
      }
      return out;
    } finally {
      pdf.pdfium.wasmExports.free(buf);
    }
  });
}
