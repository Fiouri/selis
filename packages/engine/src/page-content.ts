import type { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { PdfDocumentObject, PdfPageObject } from "@embedpdf/models";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import type { EmbeddedText } from "./annotations";
import type { PageRect } from "./geometry";
import { pageStyledTextBoxes } from "./text-geometry";
import type { PageContent } from "./types";

/**
 * A page's styled text runs (exact text per PDFium rect, with bold / italic) and its image
 * placements, as the page is shown: what "Export as Word" rebuilds the reading structure
 * from (ADR 0035).
 */
export function readPageContent(
  engine: PdfiumNative,
  pdf: WrappedPdfiumModule,
  text: EmbeddedText | null,
  doc: PdfDocumentObject,
  page: PdfPageObject,
  images: readonly PageRect[],
): PageContent {
  const boxes = pageStyledTextBoxes(engine, pdf, doc, page);
  const texts = text ? text.boundedTexts(doc, page, boxes) : [];
  const runs = boxes
    .map((b, i) => ({ x: b.x, y: b.y, width: b.width, height: b.height, text: texts[i] ?? "", fontSize: b.fontSize, bold: b.bold, italic: b.italic }))
    .filter((r) => r.text.trim() !== "");
  return { runs, images };
}
