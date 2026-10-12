/**
 * Page operations through the real PDFium WASM. mixed-sizes has seven pages of
 * different sizes, so the order of pages can be read from their sizes.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { PdfDocumentObject } from "@embedpdf/models";
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import { FIXTURES, type FixtureName } from "@selis/fixtures";
import { checkSample } from "@selis/fixtures/oracle";
import { beforeAll, describe, expect, it } from "vitest";
import { documentFields, pageWidgets } from "./forms";
import { applyPageOp, extractPages } from "./pages";

const require = createRequire(import.meta.url);
let pdf: WrappedPdfiumModule;
let engine: PdfiumNative;
let nextId = 0;

beforeAll(async () => {
  const wasm = readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
  pdf = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
  engine = new PdfiumNative(pdf, { fontFallback: null });
}, 60_000);

function fixture(name: FixtureName): ArrayBuffer {
  const f = FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(name);
  return f.build().slice().buffer;
}

async function open(bytes: ArrayBuffer): Promise<PdfDocumentObject> {
  return engine.openDocumentBuffer({ id: `p-${nextId++}`, content: bytes.slice(0) }).toPromise();
}

/** "w×h" of every page (rounded), in order. */
async function sizes(bytes: ArrayBuffer): Promise<string[]> {
  const doc = await open(bytes);
  try {
    return doc.pages.map((p) => `${Math.round(p.size.width)}x${Math.round(p.size.height)}`);
  } finally {
    await engine.closeDocument(doc).toPromise();
  }
}

describe("page operations", () => {
  const base = () => fixture("mixed-sizes");

  it("rotate turns the chosen pages only, and the source bytes stay as they were", async () => {
    const before = base();
    const copy = before.slice(0);
    const original = await sizes(before);
    const after = await sizes(await applyPageOp(engine, pdf, before, { op: "rotate", indices: [0, 2], turns: 1 }));
    const swapped = (s: string) => s.split("x").reverse().join("x");
    expect(after).toEqual(original.map((s, i) => (i === 0 || i === 2 ? swapped(s) : s)));
    expect(new Uint8Array(before)).toEqual(new Uint8Array(copy));
  });

  it("delete removes pages but never the last one", async () => {
    const original = await sizes(base());
    const after = await sizes(await applyPageOp(engine, pdf, base(), { op: "delete", indices: [1, 3] }));
    expect(after).toEqual(original.filter((_, i) => i !== 1 && i !== 3));
    await expect(applyPageOp(engine, pdf, base(), { op: "delete", indices: [0, 1, 2, 3, 4, 5, 6] })).rejects.toThrow("at least one page");
  });

  it("move puts the selected pages, in order, at the destination", async () => {
    const original = await sizes(base());
    const after = await sizes(await applyPageOp(engine, pdf, base(), { op: "move", indices: [5, 6], to: 0 }));
    expect(after).toEqual([original[5], original[6], ...original.slice(0, 5)]);
  });

  it("inserts a blank page and duplicates pages right after themselves", async () => {
    const original = await sizes(base());
    const blank = await sizes(await applyPageOp(engine, pdf, base(), { op: "insertBlank", at: 1, width: 595, height: 842 }));
    expect(blank).toEqual([original[0], "595x842", ...original.slice(1)]);
    const dup = await sizes(await applyPageOp(engine, pdf, base(), { op: "duplicate", indices: [0, 2] }));
    expect(dup).toEqual([original[0], original[0], original[1], original[2], original[2], ...original.slice(3)]);
  });

  it("extract makes a new PDF of the chosen pages", async () => {
    const original = await sizes(base());
    expect(await sizes(await extractPages(engine, base(), [4, 1]))).toEqual([original[1], original[4]]);
  });
});

describe("merging keeps forms fillable", () => {
  it("an inserted AcroForm PDF is a real form in the result (fields listed, fillable, values kept)", async () => {
    const merged = await applyPageOp(engine, pdf, fixture("mixed-sizes"), { op: "insertPdf", at: 7, bytes: fixture("acroform") });
    const doc = await open(merged);
    // FPDF_GetFormType > 0: the catalog has an /AcroForm again.
    const fields = await documentFields(engine, pdf, doc);
    expect(fields.map((f) => [f.name, f.page])).toEqual([
      ["full_name", 7],
      ["email", 7],
      ["agree", 7],
      ["plan", 7],
    ]);
    expect(fields.find((f) => f.name === "full_name")?.value).toBe("Ada Lovelace");
    expect(fields.find((f) => f.name === "agree")?.checked).toBe(true);
    expect(fields.find((f) => f.name === "plan")?.value).toBe("Editor");
    // Fillable: a value set now reads back after a save.
    const page = doc.pages[7];
    if (!page) throw new Error("no page 8");
    const email = (await pageWidgets(engine, doc, page)).find((w) => w.field.name === "email");
    if (!email) throw new Error("no email field");
    await engine.setFormFieldValue(doc, page, email, { kind: "text", text: "merged@example.org" }).toPromise();
    const again = await open((await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer);
    const after = await documentFields(engine, pdf, again);
    expect(after.find((f) => f.name === "email")?.value).toBe("merged@example.org");
  });

  it("merging the same form twice renames the second copy's fields instead of sharing values", async () => {
    const once = await applyPageOp(engine, pdf, fixture("acroform"), { op: "insertPdf", at: 1, bytes: fixture("acroform") });
    const doc = await open(once);
    const names = (await documentFields(engine, pdf, doc)).map((f) => f.name);
    expect(names).toEqual(["full_name", "email", "agree", "plan", "full_name_2", "email_2", "agree_2", "plan_2"]);
  });

  it("extracting a form page keeps it a form", async () => {
    const merged = await applyPageOp(engine, pdf, fixture("mixed-sizes"), { op: "insertPdf", at: 0, bytes: fixture("acroform") });
    const doc = await open(await extractPages(engine, merged, [0]));
    expect((await documentFields(engine, pdf, doc)).map((f) => f.name)).toEqual(["full_name", "email", "agree", "plan"]);
  });
});

/** The P2c samples, read by qpdf and pdf.js (checkSample; with SELIS_SAMPLES=<dir> also written there). */
describe("samples for other readers", () => {
  it("a merged form document, an extracted form page and a reordered, rotated document", async () => {
    const merged = await applyPageOp(engine, pdf, fixture("mixed-sizes"), { op: "insertPdf", at: 1, bytes: fixture("acroform") });
    await checkSample("merged-form.pdf", new Uint8Array(merged));
    await checkSample("extracted-form.pdf", new Uint8Array(await extractPages(engine, merged, [1])));
    const moved = await applyPageOp(engine, pdf, fixture("mixed-sizes"), { op: "move", indices: [6], to: 0 });
    const rotated = await applyPageOp(engine, pdf, moved, { op: "rotate", indices: [0, 1], turns: 1 });
    await checkSample("reordered-rotated.pdf", new Uint8Array(rotated));
  });
});
