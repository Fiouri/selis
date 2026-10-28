import type { PdfiumNative } from "@embedpdf/engines/pdfium";
import { type ImageDataLike, type PdfDocumentObject, type PdfPageObject, Rotation } from "@embedpdf/models";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { type QuarterTurns, rotateSize, unrotateRect } from "./geometry";
import type { DeviceRect } from "./tiles";

const ROTATIONS = [Rotation.Degree0, Rotation.Degree90, Rotation.Degree180, Rotation.Degree270] as const;
/** FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER (RGBA), as EmbedPDF renders. */
const RENDER_FLAGS = 0x01 | 0x10;

type PageContext = { pagePtr: number; withFormHandle: (fn: (form: number) => void) => void; release: () => void };
type DocContext = { acquirePage?: (index: number) => PageContext };

/** Whole-page bitmap size at `scale` (pixels, as PDFium sizes it), on the page as shown. */
export function pageBitmapSize(page: PdfPageObject, scale: number, rotation: QuarterTurns): { width: number; height: number } {
  const shown = rotateSize(page.size, rotation);
  return { width: Math.max(1, Math.round(shown.width * scale)), height: Math.max(1, Math.round(shown.height * scale)) };
}

/**
 * Renders a page, or one tile of it, at `scale` device pixels per point. `tile` is a
 * rect of the whole-page bitmap (`pageBitmapSize`), in pixels. Pages and tiles go
 * through PDFium's FPDF_RenderPageBitmap with the page placed at a whole-pixel
 * offset, so a tile is the same pixels as the page rendered whole: tiles side by
 * side show no seams (tiles.node.test.ts). EmbedPDF's matrix render rounds glyph
 * baselines differently per bitmap, which shifted text lines by a pixel between
 * tiles; it remains the fallback if EmbedPDF's internals ever change shape.
 */
export function renderArea(
  engine: PdfiumNative,
  pdf: WrappedPdfiumModule | null,
  doc: PdfDocumentObject,
  page: PdfPageObject,
  scale: number,
  rotation: QuarterTurns,
  tile?: DeviceRect,
): Promise<ImageDataLike> {
  const whole = pageBitmapSize(page, scale, rotation);
  const area = tile ?? { x: 0, y: 0, width: whole.width, height: whole.height };
  const context = (engine as unknown as { cache?: { getContext?: (id: string) => DocContext | undefined } }).cache?.getContext?.(doc.id);
  if (pdf && context?.acquirePage) return Promise.resolve(renderAt(pdf, context.acquirePage(page.index), whole, area, rotation));
  const options = { scaleFactor: scale, dpr: 1, rotation: ROTATIONS[rotation], withAnnotations: true, withForms: true };
  if (!tile) return engine.renderPageRaw(doc, page, options).toPromise();
  const points = unrotateRect(
    { x: tile.x / scale, y: tile.y / scale, width: tile.width / scale, height: tile.height / scale },
    page.size,
    rotation,
  );
  return engine
    .renderPageRect(doc, page, { origin: { x: points.x, y: points.y }, size: { width: points.width, height: points.height } }, options)
    .toPromise();
}

function renderAt(
  pdf: WrappedPdfiumModule,
  pageContext: PageContext,
  whole: { width: number; height: number },
  area: DeviceRect,
  rotation: QuarterTurns,
): ImageDataLike {
  const { width, height } = area;
  const stride = width * 4;
  const heap = pdf.pdfium.wasmExports.malloc(stride * height);
  let bitmap = 0;
  try {
    bitmap = pdf.FPDFBitmap_CreateEx(width, height, 4, heap, stride);
    pdf.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
    // FPDF_RenderPageBitmap takes the size before the rotation it applies.
    const sizeX = rotation % 2 === 0 ? whole.width : whole.height;
    const sizeY = rotation % 2 === 0 ? whole.height : whole.width;
    pdf.FPDF_RenderPageBitmap(bitmap, pageContext.pagePtr, -area.x, -area.y, sizeX, sizeY, rotation, RENDER_FLAGS);
    pageContext.withFormHandle((form) => {
      pdf.FPDF_FFLDraw(form, bitmap, pageContext.pagePtr, -area.x, -area.y, sizeX, sizeY, rotation, RENDER_FLAGS);
    });
    const memory = (pdf.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
    return { data: new Uint8ClampedArray(memory.subarray(heap, heap + stride * height)), width, height };
  } finally {
    if (bitmap) pdf.FPDFBitmap_Destroy(bitmap);
    pdf.pdfium.wasmExports.free(heap);
    pageContext.release();
  }
}
