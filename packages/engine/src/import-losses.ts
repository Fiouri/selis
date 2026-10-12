/**
 * What inserting a PDF will not carry over (ADR 0008, "known losses"): PDFium's
 * page import plus the form rebuild keep text, choice and check fields with
 * their values, but not signature fields, push buttons, field tooltips or
 * JavaScript (document scripts, open and field actions, calculation order).
 * The pages UI lists these before the insert so nothing is lost silently.
 *
 * Reads the document's objects (pdf-objects.ts) from a PDFium-saved scratch
 * copy: that also covers files PDFium opens with an owner password only (the
 * scratch drops the encryption; the source is never written).
 */
import type { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { EmbeddedText } from "./annotations";
import { type PdfDict, PdfDocumentObjects, type PdfObj } from "./pdf-objects";
import type { ImportLosses } from "./types";

/** Field flag: a button field is a push button (PDF 32000-1, table 226). */
const PUSHBUTTON = 1 << 16;

let scratchId = 0;

export async function importLosses(engine: PdfiumNative, text: EmbeddedText, bytes: ArrayBuffer): Promise<ImportLosses> {
  const doc = await engine.openDocumentBuffer({ id: `inspect-${scratchId++}`, content: bytes.slice(0) }).toPromise();
  let saved: ArrayBuffer;
  try {
    if (text.isEncrypted(doc)) text.removeEncryption(doc);
    saved = (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
  } finally {
    await engine.closeDocument(doc).toPromise();
  }
  return countLosses(await PdfDocumentObjects.parse(new Uint8Array(saved)));
}

function countLosses(doc: PdfDocumentObjects): ImportLosses {
  const losses = { signatures: 0, buttons: 0, tooltips: 0, scripts: 0 };
  const isScript = (action: PdfObj | undefined) => {
    const a = doc.dict(action);
    const s = a?.get("S");
    return s?.t === "name" && s.v === "JavaScript";
  };
  const actionScripts = (dict: PdfDict) => {
    let n = isScript(dict.get("A")) ? 1 : 0;
    for (const action of doc.dict(dict.get("AA"))?.values() ?? []) if (isScript(action)) n++;
    return n;
  };

  const catalog = doc.catalog();
  if (!catalog) return losses;
  const names = doc.dict(catalog.get("Names"));
  const scripts = new Set<PdfDict>();
  const visitNames = (node: PdfDict | null) => {
    if (!node || scripts.has(node)) return;
    scripts.add(node);
    const list = doc.array(node.get("Names")) ?? [];
    losses.scripts += Math.floor(list.length / 2);
    for (const kid of doc.array(node.get("Kids")) ?? []) visitNames(doc.dict(kid));
  };
  visitNames(doc.dict(names?.get("JavaScript")));
  if (isScript(catalog.get("OpenAction"))) losses.scripts++;
  losses.scripts += actionScripts(catalog);

  const form = doc.dict(catalog.get("AcroForm"));
  if ((doc.array(form?.get("CO"))?.length ?? 0) > 0) losses.scripts++;
  const seen = new Set<PdfDict>();
  const visitField = (field: PdfDict, inheritedType: string | null, inheritedFlags: number) => {
    if (seen.has(field)) return;
    seen.add(field);
    const ft = field.get("FT");
    const type = ft?.t === "name" ? ft.v : inheritedType;
    const ff = field.get("Ff");
    const flags = ff?.t === "num" ? Number(ff.v) : inheritedFlags;
    const kids = (doc.array(field.get("Kids")) ?? []).map((k) => doc.dict(k)).filter((k): k is PdfDict => k !== null);
    // A terminal field: no kids, or only widget kids (no /T of their own).
    const terminal = kids.every((k) => !k.has("T"));
    if (terminal) {
      if (type === "Sig") losses.signatures++;
      if (type === "Btn" && (flags & PUSHBUTTON) !== 0) losses.buttons++;
    }
    if (field.has("TU")) losses.tooltips++;
    losses.scripts += actionScripts(field);
    for (const kid of kids) visitField(kid, type, flags);
  };
  for (const f of doc.array(form?.get("Fields")) ?? []) {
    const d = doc.dict(f);
    if (d) visitField(d, null, 0);
  }
  return losses;
}
