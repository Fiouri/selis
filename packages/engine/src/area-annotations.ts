/**
 * Annotations over an erased area (ADR 0033 amendment). They are not page
 * content, so the content erase alone would leave a note, a stamp or a form
 * field floating over the blank area. Ink and text markup are clipped (the
 * strokes and the marked spans outside the area stay); every other kind whose
 * box meets the area is removed, form widgets included (their fields leave
 * /AcroForm when no widget is left: `pruneOrphanFields`). Pop-ups go with
 * their parent.
 */
import type { PdfiumNative } from "@embedpdf/engines/pdfium";
import { type PdfAnnotationObject, PdfAnnotationSubtype, type PdfDocumentObject, type PdfPageObject, type Rect } from "@embedpdf/models";
import type { PageRect } from "./geometry";
import { type Box, clipStroke, complementCells } from "./path-clip";

export type AnnotationChanges = { readonly removed: number; readonly clipped: number };

const MARKUP = new Set<PdfAnnotationSubtype>([
  PdfAnnotationSubtype.HIGHLIGHT,
  PdfAnnotationSubtype.UNDERLINE,
  PdfAnnotationSubtype.STRIKEOUT,
  PdfAnnotationSubtype.SQUIGGLY,
]);

const boxOf = (r: PageRect, grow = 0): Box => ({ x0: r.x - grow, y0: r.y - grow, x1: r.x + r.width + grow, y1: r.y + r.height + grow });
const fromRect = (r: Rect): Box => ({ x0: r.origin.x, y0: r.origin.y, x1: r.origin.x + r.size.width, y1: r.origin.y + r.size.height });
const toRect = (b: Box): Rect => ({ origin: { x: b.x0, y: b.y0 }, size: { width: b.x1 - b.x0, height: b.y1 - b.y0 } });
const meets = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const union = (boxes: readonly Box[]): Box => ({
  x0: Math.min(...boxes.map((b) => b.x0)),
  y0: Math.min(...boxes.map((b) => b.y0)),
  x1: Math.max(...boxes.map((b) => b.x1)),
  y1: Math.max(...boxes.map((b) => b.y1)),
});

type Point = { x: number; y: number };

/** The parts of the polylines outside `areas` (viewer coordinates), each with at least two points. */
export function clipPolylines(lines: readonly (readonly Point[])[], areas: readonly Box[]): Point[][] {
  const subpaths = lines
    .filter((l) => l.length >= 2)
    .map((l) => ({ start: l[0] as Point, segs: l.slice(1).map((to) => ({ kind: "line" as const, to })), closed: false }));
  return clipStroke(subpaths, areas)
    .map((sp) => [sp.start, ...sp.segs.map((s) => s.to)])
    .filter((l) => l.length >= 2);
}

/** The parts of the rects outside `areas`, as rects (cells of at least 0.5 pt). */
export function clipRects(rects: readonly Box[], areas: readonly Box[]): Box[] {
  return rects.flatMap((r) => (areas.some((a) => meets(a, r)) ? complementCells(areas, r) : [r])).filter((c) => c.x1 - c.x0 >= 0.5 && c.y1 - c.y0 >= 0.5);
}

/** Clips or removes the annotations of `page` whose box meets `rects` (viewer coordinates). */
export async function clearAnnotations(engine: PdfiumNative, doc: PdfDocumentObject, page: PdfPageObject, rects: readonly PageRect[]): Promise<AnnotationChanges> {
  const areas = rects.map((r) => boxOf(r));
  const annots = (await engine.getPageAnnotations(doc, page).toPromise()) as PdfAnnotationObject[];
  let removed = 0;
  let clipped = 0;
  for (const a of annots) {
    if (a.type === PdfAnnotationSubtype.POPUP || !areas.some((b) => meets(b, fromRect(a.rect)))) continue;
    let replacement: PdfAnnotationObject | null = null;
    if (a.type === PdfAnnotationSubtype.INK) {
      const half = (a.strokeWidth || 1) / 2;
      const strokes = clipPolylines(
        a.inkList.map((s) => s.points),
        rects.map((r) => boxOf(r, half)),
      );
      if (strokes.length > 0) {
        const bounds = union(strokes.flat().map((p) => ({ x0: p.x - half, y0: p.y - half, x1: p.x + half, y1: p.y + half })));
        replacement = { ...a, inkList: strokes.map((points) => ({ points })), rect: toRect(bounds) };
      }
    } else if (MARKUP.has(a.type) && "segmentRects" in a) {
      const segments = clipRects((a.segmentRects.length > 0 ? a.segmentRects : [a.rect]).map(fromRect), areas);
      if (segments.length > 0) replacement = { ...a, segmentRects: segments.map(toRect), rect: toRect(union(segments)) };
    }
    if (!(await engine.removePageAnnotation(doc, page, a).toPromise())) continue;
    if (replacement && (await engine.createPageAnnotation(doc, page, replacement).toPromise())) clipped++;
    else removed++;
  }
  return { removed, clipped };
}
