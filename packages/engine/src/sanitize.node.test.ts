/**
 * Redaction beyond the page content (ADR 0009): the redacted words are taken
 * out of metadata, outline, names, JavaScript, attachments, form and
 * annotation strings and the structure tree, and the file is written anew.
 * Checked with pdf.js and qpdf (independent of PDFium and of the code under
 * test), and by searching every raw and inflated byte.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import { type PdfDocumentObject } from "@embedpdf/models";
import { init } from "@embedpdf/pdfium";
import { FIXTURES, LEAKY_SECRET_LINE, leakyDocument, ownerPasswordDocument } from "@selis/fixtures";
import { findInFile, pdfjsDocumentParts, pdfjsPageCount, pdfjsText, qpdfCheck, qpdfRewrite } from "@selis/fixtures/oracle";
import { beforeAll, describe, expect, it } from "vitest";
import { EmbeddedText, toPdfAnnotation } from "./annotations";
import { importLosses } from "./import-losses";
import { PdfDocumentObjects } from "./pdf-objects";
import { applyRedactions } from "./redact";
import { REDACTED_TEXT, sanitizeRedacted, termMatcher } from "./sanitize";

const require = createRequire(import.meta.url);
const FONT = new Uint8Array(readFileSync(new URL("../assets/SelisSans-LatinGreek.ttf", import.meta.url)));
let engine: PdfiumNative;
let text: EmbeddedText;
let nextId = 0;

beforeAll(async () => {
  const wasm = readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
  const pdf = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
  engine = new PdfiumNative(pdf, { fontFallback: null });
  text = new EmbeddedText(engine, pdf, () => Promise.resolve(FONT));
}, 60_000);

const count = (bytes: Uint8Array, needle: string) => Buffer.from(bytes).toString("latin1").split(needle).length - 1;
/** One revision: a single cross-reference section and trailer, which points at no older one. */
function expectOneRevision(bytes: Uint8Array): void {
  const text = Buffer.from(bytes).toString("latin1");
  expect(count(bytes, "startxref")).toBe(1);
  expect(count(bytes, "%%EOF")).toBe(1);
  expect(text.slice(text.lastIndexOf("trailer"))).not.toContain("/Prev");
}

async function open(bytes: Uint8Array): Promise<PdfDocumentObject> {
  return engine.openDocumentBuffer({ id: `sz-${nextId++}`, content: bytes.slice().buffer }).toPromise();
}

describe("term matching", () => {
  const match = termMatcher(["Χωρίς λογαριασμό, χωρίς σύννεφο", "Ada Lovelace"]);

  it("matches whole words, ignoring case, accents and final sigma", () => {
    expect(match("ΣΥΝΝΕΦΟ")).toBe(true);
    expect(match("Το σύννεφο")).toBe(true);
    expect(match("χωρις")).toBe(true);
    expect(match("lovelace's notes")).toBe(true);
    expect(match("Ada")).toBe(true);
  });

  it("ignores short and common words and parts of words", () => {
    expect(termMatcher(["the and για και"])("the and για και")).toBe(false);
    expect(match("συννεφάκι")).toBe(false);
    expect(match("Adams")).toBe(false);
    expect(termMatcher([""])("anything")).toBe(false);
  });
});

describe("reading and writing objects", () => {
  it("writes every fixture anew: one revision, valid for qpdf, the same pages for pdf.js", async () => {
    for (const f of FIXTURES.filter((x) => x.name !== "encrypted" && x.name !== "large-1000")) {
      const bytes = f.build();
      const { bytes: out } = await sanitizeRedacted(bytes, []);
      qpdfCheck(out);
      expectOneRevision(out);
      expect(await pdfjsPageCount(out)).toBe(f.pageCount);
      expect((await pdfjsText(out)).pages).toEqual((await pdfjsText(bytes)).pages);
    }
  });

  it("reads cross-reference streams and object streams (qpdf --object-streams=generate)", async () => {
    const packed = qpdfRewrite(leakyDocument(), ["--object-streams=generate"]);
    expect(count(packed, "/ObjStm")).toBeGreaterThan(0);
    const doc = await PdfDocumentObjects.parse(packed);
    const out = doc.write();
    qpdfCheck(out);
    expect((await pdfjsText(out)).pages.join("")).toContain(LEAKY_SECRET_LINE);
  });

  it("refuses an encrypted file", async () => {
    const encrypted = FIXTURES.find((x) => x.name === "encrypted")?.build();
    if (!encrypted) throw new Error("no encrypted fixture");
    await expect(PdfDocumentObjects.parse(encrypted)).rejects.toThrow("encrypted");
  });
});

describe("redacting a line named all over the document", () => {
  const SECRET = ["Lovelace", "Babbage"];
  let before: Uint8Array;
  let after: Uint8Array;
  let removed: string[];
  let annotations: string[];

  beforeAll(async () => {
    before = leakyDocument();
    // Control: every part names the secret words before redaction.
    const parts = await pdfjsDocumentParts(before);
    expect(parts.info.Title).toContain("Lovelace");
    expect(parts.outline).toContain("Lovelace notes");
    expect(parts.dests).toContain("lovelace-section");
    expect(parts.javascript.join(" ")).toContain("Babbage");
    expect(parts.attachments.map((a) => a.content)).toContain("Lovelace was here");
    expect(parts.labels?.[0]).toBe("Lovelace-1");
    expect(parts.widgets.find((w) => w.name === "notes_field")).toMatchObject({ value: "Babbage Engine", tooltip: "Ask Lovelace" });
    expect(parts.xmp).toContain("Lovelace");

    // The mark covers the secret line (baseline y = 690 of 792, Helvetica 14).
    const doc = await open(before);
    const page = doc.pages[0];
    if (!page) throw new Error("no page");
    const rect = { x: 66, y: 88, width: 240, height: 20 };
    await engine
      .createPageAnnotation(doc, page, toPdfAnnotation({ id: `m-${nextId++}`, page: 0, kind: "redact", rect, segments: [rect], fill: "black", text: "", color: "#000000", opacity: 1 }))
      .toPromise();
    const pending = (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
    const result = await applyRedactions(engine, text, pending);
    after = new Uint8Array(result.bytes);
    removed = result.sanitized;
    annotations = result.annotations;
    expect(result.ownerPassword).toBe(false);
  });

  it("leaves no trace of the secret words anywhere in the bytes", () => {
    expect(findInFile(before, SECRET)).toEqual(SECRET);
    expect(findInFile(after, SECRET)).toEqual([]);
    expect(findInFile(after, ["Engine"])).toEqual([]);
  });

  it("takes them out of every part pdf.js reads, and keeps the neighbours", async () => {
    const p = await pdfjsDocumentParts(after);
    expect(p.info.Title).toBeUndefined();
    expect(p.info.Author).toBeUndefined();
    expect(p.info.Keywords).toBeUndefined();
    expect(p.info.Subject).toBe("Quarterly");
    expect(p.xmp).toBeNull();
    expect(p.outline).toEqual(["Introduction", REDACTED_TEXT]);
    expect(p.dests).toEqual(["intro"]);
    expect(p.attachments).toEqual([{ name: "public.txt", content: "nothing here" }]);
    expect(p.javascript).toEqual(["var x = 1;"]);
    expect(p.labels).toEqual(["1"]);
    expect(p.widgets.find((w) => w.name === "notes_field")).toMatchObject({ value: "", tooltip: "" });
    expect(p.widgets.find((w) => w.name === "public_field")).toMatchObject({ value: "ok", tooltip: "Public" });
    expect(p.notes).toEqual(["Unrelated"]);
  });

  it("names the notes it removes for sharing a redacted word (the confirm dialog lists them)", () => {
    expect(annotations).toEqual(["Call Lovelace", "FreeText"]);
  });

  it("reports what it took out", () => {
    for (const what of ["Info /Title", "XMP metadata", "outline title", "named destination", "JavaScript", "embedded file", "page label", "field /V", "field /TU", "annotation", "structure /Alt"]) {
      expect(removed).toContain(what);
    }
  });

  it("writes one fresh revision that qpdf and pdf.js accept, with the page text redacted", async () => {
    qpdfCheck(after);
    expectOneRevision(after);
    const pageText = (await pdfjsText(after)).pages.join("\n");
    expect(pageText).toContain("Public line stays.");
    expect(pageText).toContain("Another public line.");
    expect(pageText).not.toContain("Secret");
  });
});

describe("what inserting a PDF drops (ADR 0008)", () => {
  it("counts signature fields, push buttons, tooltips and scripts", async () => {
    expect(await importLosses(engine, text, leakyDocument().slice().buffer)).toEqual({ signatures: 1, buttons: 1, tooltips: 2, scripts: 4 });
    const form = FIXTURES.find((x) => x.name === "acroform")?.build();
    if (!form) throw new Error("no acroform fixture");
    expect(await importLosses(engine, text, form.slice().buffer)).toEqual({ signatures: 0, buttons: 0, tooltips: 4, scripts: 0 });
    const greek = FIXTURES.find((x) => x.name === "greek")?.build();
    if (!greek) throw new Error("no greek fixture");
    expect(await importLosses(engine, text, greek.slice().buffer)).toEqual({ signatures: 0, buttons: 0, tooltips: 0, scripts: 0 });
  });
});

describe("a document with an owner password only", () => {
  it("is redacted without its security handler, and says so", async () => {
    const before = ownerPasswordDocument();
    expect(Buffer.from(before).toString("latin1")).toContain("/Encrypt");
    const doc = await open(before);
    const page = doc.pages[0];
    if (!page) throw new Error("no page");
    // "Owner secret line." at baseline 720 of 841.89 (top-left y ≈ 122).
    const rect = { x: 50, y: 108, width: 200, height: 18 };
    await engine
      .createPageAnnotation(doc, page, toPdfAnnotation({ id: `m-${nextId++}`, page: 0, kind: "redact", rect, segments: [rect], fill: "black", text: "", color: "#000000", opacity: 1 }))
      .toPromise();
    const pending = (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
    const result = await applyRedactions(engine, text, pending);
    expect(result.ownerPassword).toBe(true);
    const out = new Uint8Array(result.bytes);
    expect(Buffer.from(out).toString("latin1")).not.toContain("/Encrypt");
    const pageText = (await pdfjsText(out)).pages.join("\n");
    expect(pageText).toContain("Public line.");
    expect(pageText).not.toContain("Owner secret");
    qpdfCheck(out);
  });
});
