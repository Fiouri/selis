/**
 * True redaction (P2d), worker side. PDFium's EPDFPage_ApplyRedactions removes
 * the page content under each /Redact mark (text, image pixels, paths) and
 * paints its interior color, but it leaves annotations alone: a note, a typed
 * text stamp or a form field over the area would keep the very content that was
 * meant to go (measured: a note's /Contents and a text field's /V and
 * appearance survive). So before applying, everything else whose box meets a
 * mark is removed too; form fields there are emptied first (their value lives
 * in the field, not only in the widget).
 *
 * Runs on a scratch copy and returns new bytes, like page operations (the
 * worker swaps the open document for them).
 */
import type { PdfiumNative } from "@embedpdf/engines/pdfium";
import {
  type FormFieldValue,
  PDF_FORM_FIELD_TYPE,
  type PdfAnnotationObject,
  PdfAnnotationSubtype,
  type PdfDocumentObject,
  type PdfPageObject,
  type PdfWidgetAnnoObject,
  type Rect,
} from "@embedpdf/models";
import { type EmbeddedText, fromPdfAnnotation } from "./annotations";
import type { PageRect } from "./geometry";

/** Replacement text size: fits one line in the whiteout's height, within bounds. */
const MIN_FONT_PT = 6;
const MAX_FONT_PT = 24;
const LINE_HEIGHT_EM = 1.36;

let scratchId = 0;

const toPageRect = (r: Rect): PageRect => ({ x: r.origin.x, y: r.origin.y, width: r.size.width, height: r.size.height });

function intersects(a: PageRect, b: PageRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The value a field gets when its content is redacted. */
function emptyValue(widget: PdfWidgetAnnoObject): FormFieldValue | null {
  const field = widget.field;
  switch (field.type) {
    case PDF_FORM_FIELD_TYPE.TEXTFIELD:
      return field.value === "" ? null : { kind: "text", text: "" };
    case PDF_FORM_FIELD_TYPE.CHECKBOX:
    case PDF_FORM_FIELD_TYPE.RADIOBUTTON:
      return { kind: "checked", checked: false };
    case PDF_FORM_FIELD_TYPE.COMBOBOX:
    case PDF_FORM_FIELD_TYPE.LISTBOX: {
      const index = field.options.findIndex((o) => o.isSelected);
      return index >= 0 ? { kind: "selection", index, isSelected: false } : null;
    }
    default:
      return null;
  }
}

type Whiteout = { rect: PageRect; text: string };
type Marks = { count: number; areas: PageRect[]; whiteouts: Whiteout[] };

async function pageAnnotations(engine: PdfiumNative, doc: PdfDocumentObject, page: PdfPageObject): Promise<PdfAnnotationObject[]> {
  return (await engine.getPageAnnotations(doc, page).toPromise()) as PdfAnnotationObject[];
}

function marksOf(annots: readonly PdfAnnotationObject[]): Marks {
  const marks: Marks = { count: 0, areas: [], whiteouts: [] };
  for (const a of annots) {
    if (a.type !== PdfAnnotationSubtype.REDACT) continue;
    const parsed = fromPdfAnnotation(a);
    if (parsed.kind !== "redact") continue;
    marks.count++;
    marks.areas.push(...parsed.segments);
    if (parsed.fill === "white" && parsed.text.trim() !== "") marks.whiteouts.push({ rect: parsed.rect, text: parsed.text });
  }
  return marks;
}

/** Annotations (not marks, not popups: those go with their parent) whose box meets a mark. */
function covered(annots: readonly PdfAnnotationObject[], areas: readonly PageRect[]): PdfAnnotationObject[] {
  return annots.filter(
    (a) =>
      a.type !== PdfAnnotationSubtype.REDACT &&
      a.type !== PdfAnnotationSubtype.POPUP &&
      areas.some((r) => intersects(r, toPageRect(a.rect))),
  );
}

/** Pass 1: empties the form fields under the marks. Returns how many marks the page has. */
async function emptyFields(engine: PdfiumNative, doc: PdfDocumentObject, page: PdfPageObject): Promise<number> {
  const annots = await pageAnnotations(engine, doc, page);
  const marks = marksOf(annots);
  for (const a of covered(annots, marks.areas)) {
    if (a.type !== PdfAnnotationSubtype.WIDGET) continue;
    const empty = emptyValue(a);
    if (empty) await engine.setFormFieldValue(doc, page, a, empty).toPromise();
  }
  return marks.count;
}

/** Pass 2: removes the covered annotations, applies the marks, writes whiteout text. */
async function redactPage(engine: PdfiumNative, text: EmbeddedText, doc: PdfDocumentObject, page: PdfPageObject): Promise<void> {
  const annots = await pageAnnotations(engine, doc, page);
  const marks = marksOf(annots);
  if (marks.count === 0) return;
  for (const a of covered(annots, marks.areas)) await engine.removePageAnnotation(doc, page, a).toPromise();
  if (!(await engine.applyAllRedactions(doc, page).toPromise())) throw new Error(`cannot apply the redactions on page ${page.index + 1}`);
  for (const w of marks.whiteouts) {
    const fontSize = Math.min(MAX_FONT_PT, Math.max(MIN_FONT_PT, (w.rect.height - 4) / LINE_HEIGHT_EM));
    await text.create(doc, page, {
      kind: "text",
      id: `selis-text-${crypto.randomUUID()}`,
      page: page.index,
      rect: w.rect,
      color: "#000000",
      opacity: 1,
      text: w.text,
      fontSize,
    });
  }
}

async function withScratch<T>(engine: PdfiumNative, bytes: ArrayBuffer, use: (doc: PdfDocumentObject) => Promise<T>): Promise<T> {
  const doc = await engine.openDocumentBuffer({ id: `redact-${scratchId++}`, content: bytes.slice(0) }).toPromise();
  try {
    return await use(doc);
  } finally {
    await engine.closeDocument(doc).toPromise();
  }
}

/**
 * Applies all redaction marks of the document `current`; returns the new bytes.
 * Two passes with a save between them: removing a widget makes PDFium drop a
 * field value set in the same session (measured), so the values are emptied
 * and saved first.
 */
export async function applyRedactions(
  engine: PdfiumNative,
  text: EmbeddedText,
  current: ArrayBuffer,
): Promise<{ bytes: ArrayBuffer; applied: number }> {
  let applied = 0;
  const emptied = await withScratch(engine, current, async (doc) => {
    for (const page of doc.pages) applied += await emptyFields(engine, doc, page);
    return (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
  });
  if (applied === 0) throw new Error("no redaction marks to apply");
  const bytes = await withScratch(engine, emptied, async (doc) => {
    try {
      for (const page of doc.pages) await redactPage(engine, text, doc, page);
      return (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
    } finally {
      text.forget(doc.id);
    }
  });
  return { bytes, applied };
}
