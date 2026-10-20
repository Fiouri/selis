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
 * The words that went (the text under the marks, emptied field values, the
 * removed annotations' text) are then taken out of the rest of the document as
 * well (metadata, outline, names, fields, structure: sanitize.ts), and the file
 * is written anew with no older revision or unused object in it. A document
 * with a security handler (an owner password; one with a user password does
 * not open in Selis) is written without it: its strings must be readable to be
 * checked.
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
import { type EmbeddedText, fromPdfAnnotation, TEXT_STAMP_PREFIX } from "./annotations";
import type { PageRect } from "./geometry";
import type { Box } from "./path-clip";
import { toUserSpace } from "./pdfium-objects";
import { sanitizeRedacted } from "./sanitize";
import { unsharePages } from "./unshare";

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

/** The text a field shows: its value, or the selected options. */
function fieldText(widget: PdfWidgetAnnoObject): string {
  const field = widget.field;
  if (field.type === PDF_FORM_FIELD_TYPE.COMBOBOX || field.type === PDF_FORM_FIELD_TYPE.LISTBOX) {
    return field.options
      .filter((o) => o.isSelected)
      .map((o) => o.label)
      .join(" ");
  }
  return typeof field.value === "string" ? field.value : "";
}

/** A viewer rect as a box in PDF user space. */
function userBox(engine: PdfiumNative, doc: PdfDocumentObject, page: PdfPageObject, r: PageRect): Box {
  const a = toUserSpace(engine, doc, page, { x: r.x, y: r.y });
  const c = toUserSpace(engine, doc, page, { x: r.x + r.width, y: r.y + r.height });
  return { x0: Math.min(a.x, c.x), y0: Math.min(a.y, c.y), x1: Math.max(a.x, c.x), y1: Math.max(a.y, c.y) };
}

/**
 * Pass 1: empties the form fields under the marks and collects what goes: the
 * page text under each mark, the emptied values, the covered annotations' text,
 * and the marks' areas in user space (for the copy-on-write of shared XObjects).
 * Returns how many marks the page has.
 */
async function emptyFields(
  engine: PdfiumNative,
  text: EmbeddedText,
  doc: PdfDocumentObject,
  page: PdfPageObject,
  terms: string[],
  areas: Map<number, Box[]>,
): Promise<number> {
  const annots = await pageAnnotations(engine, doc, page);
  const marks = marksOf(annots);
  if (marks.areas.length > 0) areas.set(page.index, marks.areas.map((r) => userBox(engine, doc, page, r)));
  for (const r of marks.areas) terms.push(text.boundedText(doc, page, r));
  for (const a of covered(annots, marks.areas)) {
    if (a.contents) terms.push(a.contents);
    if (a.type !== PdfAnnotationSubtype.WIDGET) continue;
    terms.push(fieldText(a));
    const empty = emptyValue(a);
    if (empty) await engine.setFormFieldValue(doc, page, a, empty).toPromise();
  }
  return marks.count;
}

/** Pass 2: removes the covered annotations, applies the marks, writes whiteout text. */
async function redactPage(
  engine: PdfiumNative,
  text: EmbeddedText,
  doc: PdfDocumentObject,
  page: PdfPageObject,
  stamps: Set<string>,
): Promise<void> {
  const annots = await pageAnnotations(engine, doc, page);
  const marks = marksOf(annots);
  if (marks.count === 0) return;
  for (const a of covered(annots, marks.areas)) await engine.removePageAnnotation(doc, page, a).toPromise();
  if (!(await engine.applyAllRedactions(doc, page).toPromise())) throw new Error(`cannot apply the redactions on page ${page.index + 1}`);
  for (const w of marks.whiteouts) {
    const fontSize = Math.min(MAX_FONT_PT, Math.max(MIN_FONT_PT, (w.rect.height - 4) / LINE_HEIGHT_EM));
    const id = `${TEXT_STAMP_PREFIX}${crypto.randomUUID()}`;
    stamps.add(id);
    await text.create(doc, page, {
      kind: "text",
      id,
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
 * Applies all redaction marks of the document `current`; returns the new bytes
 * and what was taken out of the rest of the document. Two passes with a save
 * between them: removing a widget makes PDFium drop a field value set in the
 * same session (measured), so the values are emptied and saved first. Between
 * them every image or form XObject drawn over a mark gets a copy of its own
 * (unshare.ts): PDFium blanks image pixels and rewrites forms in place, which
 * would change every other page (or draw) that shares them.
 */
export async function applyRedactions(
  engine: PdfiumNative,
  text: EmbeddedText,
  current: ArrayBuffer,
): Promise<{ bytes: ArrayBuffer; applied: number; sanitized: string[]; annotations: string[]; ownerPassword: boolean }> {
  let applied = 0;
  let ownerPassword = false;
  const terms: string[] = [];
  const areas = new Map<number, Box[]>();
  const emptied = await withScratch(engine, current, async (doc) => {
    for (const page of doc.pages) applied += await emptyFields(engine, text, doc, page, terms, areas);
    ownerPassword = text.isEncrypted(doc);
    if (ownerPassword) text.removeEncryption(doc);
    return (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
  });
  if (applied === 0) throw new Error("no redaction marks to apply");
  const unshared = await unsharePages(new Uint8Array(emptied), areas);
  const stamps = new Set<string>();
  const redacted = await withScratch(engine, unshared.slice().buffer, async (doc) => {
    try {
      for (const page of doc.pages) await redactPage(engine, text, doc, page, stamps);
      return (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
    } finally {
      text.forget(doc.id);
    }
  });
  // The whiteouts' new text stamps hold the user's new words: kept as written.
  const { bytes, report } = await sanitizeRedacted(new Uint8Array(redacted), terms, (nm) => stamps.has(nm));
  return { bytes: bytes.slice().buffer, applied, sanitized: report.removed, annotations: report.annotations, ownerPassword };
}
