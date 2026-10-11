/**
 * Form widgets in and out of PDFium (worker side): EmbedPDF's widget objects →
 * `FormField`, and `FieldChange` → EmbedPDF's `FormFieldValue`.
 */
import type { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import {
  PDF_FORM_FIELD_FLAG,
  PDF_FORM_FIELD_TYPE,
  type FormFieldValue,
  type PdfDocumentObject,
  PdfPageFlattenResult,
  type PdfPageObject,
  type PdfWidgetAnnoObject,
} from "@embedpdf/models";
import type { EmbeddedText } from "./annotations";
import type { FieldChange, FormField, FormFieldKind } from "./types";

function kindOf(type: PDF_FORM_FIELD_TYPE): FormFieldKind {
  switch (type) {
    case PDF_FORM_FIELD_TYPE.TEXTFIELD:
      return "text";
    case PDF_FORM_FIELD_TYPE.CHECKBOX:
      return "checkbox";
    case PDF_FORM_FIELD_TYPE.RADIOBUTTON:
      return "radio";
    case PDF_FORM_FIELD_TYPE.COMBOBOX:
      return "combobox";
    case PDF_FORM_FIELD_TYPE.LISTBOX:
      return "listbox";
    case PDF_FORM_FIELD_TYPE.PUSHBUTTON:
      return "button";
    case PDF_FORM_FIELD_TYPE.SIGNATURE:
      return "signature";
    default:
      return "unknown";
  }
}

function colorOrNull(value: string | undefined): string | null {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

function hexColor(value: string | undefined): string {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : "#000000";
}

/** Whether a checkbox / radio widget is on: its value is its export value (anything but Off). */
function isOn(w: PdfWidgetAnnoObject): boolean {
  const value = w.field.value;
  if (w.exportValue !== undefined && w.exportValue !== "") return value === w.exportValue;
  return value !== "" && value !== "Off";
}

export function toFormField(w: PdfWidgetAnnoObject): FormField {
  const field = w.field;
  const flag = field.flag;
  const kind = kindOf(field.type);
  const options = "options" in field ? field.options.map((o) => ({ label: o.label, selected: o.isSelected })) : [];
  const maxLen = field.type === PDF_FORM_FIELD_TYPE.TEXTFIELD ? (field.maxLen ?? 0) : 0;
  return {
    id: w.id,
    page: w.pageIndex,
    rect: { x: w.rect.origin.x, y: w.rect.origin.y, width: w.rect.size.width, height: w.rect.size.height },
    name: field.name,
    kind,
    value: field.value,
    checked: kind === "checkbox" || kind === "radio" ? isOn(w) : false,
    options,
    readOnly: (flag & PDF_FORM_FIELD_FLAG.READONLY) !== 0,
    required: (flag & PDF_FORM_FIELD_FLAG.REQUIRED) !== 0,
    multiline: kind === "text" && (flag & PDF_FORM_FIELD_FLAG.TEXT_MULTIPLINE) !== 0,
    maxLength: maxLen > 0 ? maxLen : null,
    fontSize: w.fontSize > 0 ? w.fontSize : 0,
    fontColor: hexColor(w.fontColor),
  };
}

export function toFormFieldValue(change: FieldChange): FormFieldValue {
  switch (change.kind) {
    case "text":
      return { kind: "text", text: change.text };
    case "checked":
      return { kind: "checked", checked: change.checked };
    case "select":
      return { kind: "selection", index: change.index, isSelected: true };
  }
}

/** PDFium draws text fields with the standard-14 fonts (WinAnsi): anything beyond Latin-1 needs our font. */
export function needsEmbeddedFont(text: string): boolean {
  for (const ch of text) if ((ch.codePointAt(0) as number) > 0xff) return true;
  return false;
}

export async function pageWidgets(engine: PdfiumNative, doc: PdfDocumentObject, page: PdfPageObject): Promise<PdfWidgetAnnoObject[]> {
  return engine.getPageAnnoWidgets(doc, page).toPromise();
}

/**
 * Changes a field through the widget `id` and returns the page's widgets after
 * the change. The value is always set by PDFium; text PDFium cannot draw
 * (beyond Latin-1) is shown by an overlay in the embedded font.
 */
export async function setField(
  engine: PdfiumNative,
  text: EmbeddedText,
  doc: PdfDocumentObject,
  page: PdfPageObject,
  id: string,
  change: FieldChange,
): Promise<FormField[]> {
  const widget = (await pageWidgets(engine, doc, page)).find((w) => w.id === id);
  if (!widget) throw new Error("form field not found");
  const field = toFormField(widget);
  if (field.readOnly) throw new Error("form field is read-only");
  await engine.setFormFieldValue(doc, page, widget, toFormFieldValue(change)).toPromise();
  if (change.kind === "text") {
    await text.setFieldOverlay(doc, page, id, field.rect, needsEmbeddedFont(change.text) ? change.text : null, {
      fontSize: field.fontSize,
      color: field.fontColor,
      multiline: field.multiline,
      background: colorOrNull(widget.color),
      border: colorOrNull(widget.strokeColor),
      borderWidth: widget.strokeWidth ?? 1,
    });
  }
  return (await pageWidgets(engine, doc, page)).map(toFormField);
}

type DocCtx = { docPtr: number; acquirePage(index: number): { pagePtr: number; release(): void } };
/** FPDF_FORMFIELD types: no AcroForm / XFA. */
const FORMTYPE_NONE = 0;
const SUBTYPE_WIDGET = 20;

/**
 * Every fillable widget of the document, page by page. A document without an
 * AcroForm costs one call; otherwise pages are scanned cheaply (annotation
 * subtypes) and only pages with widgets are read in full.
 */
export async function documentFields(engine: PdfiumNative, pdf: WrappedPdfiumModule, doc: PdfDocumentObject): Promise<FormField[]> {
  const ctx = (engine as unknown as { cache: { getContext(id: string): DocCtx | undefined } }).cache.getContext(doc.id);
  if (!ctx || pdf.FPDF_GetFormType(ctx.docPtr) === FORMTYPE_NONE) return [];
  const out: FormField[] = [];
  for (const page of doc.pages) {
    const pageCtx = ctx.acquirePage(page.index);
    let widgets = 0;
    try {
      const count = pdf.FPDFPage_GetAnnotCount(pageCtx.pagePtr);
      for (let i = 0; i < count && widgets === 0; i++) {
        const annot = pdf.FPDFPage_GetAnnot(pageCtx.pagePtr, i);
        if (!annot) continue;
        if (pdf.FPDFAnnot_GetSubtype(annot) === SUBTYPE_WIDGET) widgets++;
        pdf.FPDFPage_CloseAnnot(annot);
      }
    } finally {
      pageCtx.release();
    }
    if (widgets > 0) out.push(...(await pageWidgets(engine, doc, page)).map(toFormField));
  }
  return out;
}

/** Flattens every page (form fields and annotations become page content); returns the pages changed. */
export async function flattenAll(engine: PdfiumNative, doc: PdfDocumentObject): Promise<number> {
  let pages = 0;
  for (const page of doc.pages) {
    const result = await engine.flattenPage(doc, page).toPromise();
    if (result === PdfPageFlattenResult.Success) pages++;
    else if (result === PdfPageFlattenResult.Fail) throw new Error(`flattening page ${page.index + 1} failed`);
  }
  return pages;
}
