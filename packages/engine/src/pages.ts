/**
 * Page operations (P2c), worker side: rotate, delete, move, insert blank,
 * duplicate, insert another PDF, extract.
 *
 * Every structural change runs on a scratch copy opened from the document's
 * current bytes (which are also the undo snapshot), and the result is a new
 * PDF: the worker then reopens the document from it. EmbedPDF caches page
 * objects (size, rotation) per open document, so editing the structure of an
 * open one in place would leave them stale.
 *
 * Inserting a PDF keeps its form fillable: PDFium's page import does not carry
 * the catalog's /AcroForm, so the imported widgets would be orphans. They are
 * recreated as form fields of the destination (same type, name, options, flags,
 * value and look) and the orphans removed. A name that already exists in the
 * destination gets a suffix (`name_2`) so two forms do not share values by
 * accident. Known loss: a field's tooltip (/TU) is not carried over (PDFium
 * has no way to set it on the field).
 */
import type { PdfiumNative } from "@embedpdf/engines/pdfium";
import {
  PDF_FORM_FIELD_TYPE,
  type PdfDocumentObject,
  PdfStandardFont,
  type PdfPageObject,
  type PdfWidgetAnnoObject,
} from "@embedpdf/models";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import { pageWidgets } from "./forms";

export type PageOp =
  | { readonly op: "rotate"; readonly indices: readonly number[]; readonly turns: 1 | 2 | 3 }
  | { readonly op: "delete"; readonly indices: readonly number[] }
  /** Moves the pages (in their current order) so the first lands at `to` in the result. */
  | { readonly op: "move"; readonly indices: readonly number[]; readonly to: number }
  | { readonly op: "insertBlank"; readonly at: number; readonly width: number; readonly height: number }
  /** Each page is copied right after itself. */
  | { readonly op: "duplicate"; readonly indices: readonly number[] }
  | { readonly op: "insertPdf"; readonly at: number; readonly bytes: ArrayBuffer };

type DocCtx = { docPtr: number };
type Heap = { HEAP32: Int32Array };

let scratchId = 0;

function context(engine: PdfiumNative, doc: PdfDocumentObject): DocCtx {
  const ctx = (engine as unknown as { cache: { getContext(id: string): DocCtx | undefined } }).cache.getContext(doc.id);
  if (!ctx) throw new Error("document is not open");
  return ctx;
}

function sortedUnique(indices: readonly number[], count: number): number[] {
  const out = [...new Set(indices)].sort((a, b) => a - b);
  if (out.length === 0) throw new Error("no pages given");
  if (out.some((i) => !Number.isInteger(i) || i < 0 || i >= count)) throw new Error("page index out of range");
  return out;
}

function withIntArray<T>(pdf: WrappedPdfiumModule, values: readonly number[], use: (ptr: number) => T): T {
  const ptr = pdf.pdfium.wasmExports.malloc(values.length * 4);
  try {
    const heap = pdf.pdfium as unknown as Heap;
    values.forEach((v, i) => {
      heap.HEAP32[(ptr >> 2) + i] = v;
    });
    return use(ptr);
  } finally {
    pdf.pdfium.wasmExports.free(ptr);
  }
}

async function openScratch(engine: PdfiumNative, bytes: ArrayBuffer): Promise<PdfDocumentObject> {
  return engine.openDocumentBuffer({ id: `scratch-${scratchId++}`, content: bytes }).toPromise();
}

/**
 * Applies `op` to the document whose bytes are `current` and returns the new
 * document's bytes. `current` is left untouched (it is the undo snapshot).
 */
export async function applyPageOp(engine: PdfiumNative, pdf: WrappedPdfiumModule, current: ArrayBuffer, op: PageOp): Promise<ArrayBuffer> {
  const doc = await openScratch(engine, current.slice(0));
  try {
    const { docPtr } = context(engine, doc);
    const count = doc.pageCount;
    switch (op.op) {
      case "rotate": {
        for (const index of sortedUnique(op.indices, count)) {
          const page = pdf.FPDF_LoadPage(docPtr, index);
          if (!page) throw new Error(`cannot load page ${index + 1}`);
          try {
            pdf.FPDFPage_SetRotation(page, (pdf.FPDFPage_GetRotation(page) + op.turns) % 4);
          } finally {
            pdf.FPDF_ClosePage(page);
          }
        }
        break;
      }
      case "delete": {
        const indices = sortedUnique(op.indices, count);
        if (indices.length >= count) throw new Error("a document keeps at least one page");
        for (const index of indices.reverse()) pdf.FPDFPage_Delete(docPtr, index);
        break;
      }
      case "move": {
        const indices = sortedUnique(op.indices, count);
        const to = Math.min(Math.max(0, op.to), count - indices.length);
        if (!withIntArray(pdf, indices, (ptr) => pdf.FPDF_MovePages(docPtr, ptr, indices.length, to))) throw new Error("cannot move the pages");
        break;
      }
      case "insertBlank": {
        const at = Math.min(Math.max(0, op.at), count);
        const page = pdf.FPDFPage_New(docPtr, at, op.width, op.height);
        if (!page) throw new Error("cannot add a page");
        pdf.FPDF_ClosePage(page);
        break;
      }
      case "duplicate": {
        const indices = sortedUnique(op.indices, count);
        const source = await openScratch(engine, current.slice(0));
        try {
          const srcPtr = context(engine, source).docPtr;
          // From the last, so earlier insert positions do not move.
          for (const index of [...indices].reverse()) {
            const ok = withIntArray(pdf, [index], (ptr) => pdf.FPDF_ImportPagesByIndex(docPtr, srcPtr, ptr, 1, index + 1));
            if (!ok) throw new Error(`cannot duplicate page ${index + 1}`);
          }
        } finally {
          await engine.closeDocument(source).toPromise();
        }
        break;
      }
      case "insertPdf":
        await insertPdf(engine, doc, op.bytes, Math.min(Math.max(0, op.at), count));
        break;
    }
    return (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
  } finally {
    await engine.closeDocument(doc).toPromise();
  }
}

/** The pages `indices` as a new PDF (extract, split). */
export async function extractPages(engine: PdfiumNative, current: ArrayBuffer, indices: readonly number[]): Promise<ArrayBuffer> {
  const doc = await openScratch(engine, current.slice(0));
  try {
    const sorted = sortedUnique(indices, doc.pageCount);
    const bytes = (await engine.extractPages(doc, sorted).toPromise()) as ArrayBuffer;
    // extractPages imports pages too: put the form back the same way as insertPdf.
    const out = await openScratch(engine, bytes);
    try {
      await rebuildForms(engine, out, doc, sorted, out.pages);
      return (await engine.saveAsCopy(out).toPromise()) as ArrayBuffer;
    } finally {
      await engine.closeDocument(out).toPromise();
    }
  } finally {
    await engine.closeDocument(doc).toPromise();
  }
}

async function insertPdf(engine: PdfiumNative, dest: PdfDocumentObject, bytes: ArrayBuffer, at: number): Promise<void> {
  const source = await openScratch(engine, bytes);
  try {
    const all = source.pages.map((p) => p.index);
    const added = await engine.importPages(dest, source, all, at).toPromise();
    await rebuildForms(engine, dest, source, all, added);
  } finally {
    await engine.closeDocument(source).toPromise();
  }
}

/** Field names already used by the destination's other pages. */
async function existingNames(engine: PdfiumNative, doc: PdfDocumentObject, skip: ReadonlySet<number>): Promise<Set<string>> {
  const names = new Set<string>();
  for (const page of doc.pages) {
    if (skip.has(page.index)) continue;
    for (const w of await pageWidgets(engine, doc, page)) names.add(w.field.name);
  }
  return names;
}

function uniqueName(name: string, taken: Set<string>, renamed: Map<string, string>): string {
  const known = renamed.get(name);
  if (known) return known;
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) candidate = `${name}_${n}`;
  renamed.set(name, candidate);
  taken.add(candidate);
  return candidate;
}

/**
 * Recreates the widgets that arrived on `added` (copies of `sourcePages` of
 * `source`) as real form fields of `dest`. Radio options of one group become
 * one field with several widgets.
 */
async function rebuildForms(
  engine: PdfiumNative,
  dest: PdfDocumentObject,
  source: PdfDocumentObject,
  sourcePages: readonly number[],
  added: readonly PdfPageObject[],
): Promise<void> {
  const addedSet = new Set(added.map((p) => p.index));
  const taken = await existingNames(engine, dest, addedSet);
  const renamed = new Map<string, string>();
  for (let i = 0; i < added.length; i++) {
    const page = added[i] as PdfPageObject;
    const srcPage = source.pages[sourcePages[i] as number];
    if (!srcPage) continue;
    const orphans = await pageWidgets(engine, dest, page);
    if (orphans.length === 0) continue;
    const originals = await pageWidgets(engine, source, srcPage);
    for (const orphan of orphans) await engine.removePageAnnotation(dest, page, orphan).toPromise();
    for (const original of originals) {
      if (original.field.type === PDF_FORM_FIELD_TYPE.PUSHBUTTON || original.field.type === PDF_FORM_FIELD_TYPE.SIGNATURE) continue;
      const name = uniqueName(original.field.name, taken, renamed);
      const copy: PdfWidgetAnnoObject = {
        ...original,
        id: crypto.randomUUID(),
        pageIndex: page.index,
        // A font PDFium could not name (e.g. one EmbedPDF wrote itself) is written back as Helvetica.
        fontFamily: original.fontFamily === PdfStandardFont.Unknown ? PdfStandardFont.Helvetica : original.fontFamily,
        field: { ...original.field, name },
      };
      await engine.createPageAnnotation(dest, page, copy).toPromise();
      await restoreValue(engine, dest, page, copy, original);
    }
  }
}

/** Sets the recreated widget's value / state as the original had it. */
async function restoreValue(
  engine: PdfiumNative,
  doc: PdfDocumentObject,
  page: PdfPageObject,
  copy: PdfWidgetAnnoObject,
  original: PdfWidgetAnnoObject,
): Promise<void> {
  const widget = (await pageWidgets(engine, doc, page)).find((w) => w.id === copy.id);
  if (!widget) return;
  const field = original.field;
  switch (field.type) {
    case PDF_FORM_FIELD_TYPE.TEXTFIELD:
      if (field.value !== "") await engine.setFormFieldValue(doc, page, widget, { kind: "text", text: field.value }).toPromise();
      return;
    case PDF_FORM_FIELD_TYPE.CHECKBOX:
    case PDF_FORM_FIELD_TYPE.RADIOBUTTON: {
      const on = original.exportValue ? field.value === original.exportValue : field.value !== "" && field.value !== "Off";
      if (on) await engine.setFormFieldValue(doc, page, widget, { kind: "checked", checked: true }).toPromise();
      return;
    }
    case PDF_FORM_FIELD_TYPE.COMBOBOX:
    case PDF_FORM_FIELD_TYPE.LISTBOX: {
      const index = field.options.findIndex((o) => o.isSelected);
      if (index >= 0) await engine.setFormFieldValue(doc, page, widget, { kind: "selection", index, isSelected: true }).toPromise();
      return;
    }
    default:
      return;
  }
}
