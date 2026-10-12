/**
 * True redaction through the real PDFium WASM: the content under a mark is gone
 * from the saved file (text no longer extracts, image pixels blank), and so are
 * annotations and form values over it. Whiteouts get their Greek text.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import { type PdfAnnotationObject, PdfAnnotationSubtype, type PdfDocumentObject } from "@embedpdf/models";
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import { FIXTURES, type FixtureName, GREEK_TEXT, greekGlyphHex } from "@selis/fixtures";
import {
  type Box,
  boxDistance,
  checkSample,
  countPixels,
  findInFile,
  intersects,
  isDark,
  pdfjsAnnotations,
  pdfjsRender,
  pdfjsText,
  type Raster,
  solidBox,
  type TextItem,
} from "@selis/fixtures/oracle";
import { beforeAll, describe, expect, it } from "vitest";
import { EmbeddedText, fromPdfAnnotation, TEXT_STAMP_PREFIX, toPdfAnnotation } from "./annotations";
import { documentFields } from "./forms";
import type { PageRect } from "./geometry";
import { applyRedactions } from "./redact";
import type { Annotation } from "./types";

const require = createRequire(import.meta.url);
const FONT = new Uint8Array(readFileSync(new URL("../assets/SelisSans-LatinGreek.ttf", import.meta.url)));
let pdf: WrappedPdfiumModule;
let engine: PdfiumNative;
let text: EmbeddedText;
let nextId = 0;

beforeAll(async () => {
  const wasm = readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
  pdf = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
  engine = new PdfiumNative(pdf, { fontFallback: null });
  text = new EmbeddedText(engine, pdf, () => Promise.resolve(FONT));
}, 60_000);

function fixture(name: FixtureName): ArrayBuffer {
  const f = FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(name);
  return f.build().slice().buffer;
}

async function open(bytes: ArrayBuffer): Promise<PdfDocumentObject> {
  return engine.openDocumentBuffer({ id: `rd-${nextId++}`, content: bytes.slice(0) }).toPromise();
}

function mark(page: number, rect: PageRect, fill: "black" | "white" = "black", replacement = ""): Extract<Annotation, { kind: "redact" }> {
  return { id: `selis-redact-${nextId++}`, page, kind: "redact", rect, segments: [rect], fill, text: replacement, color: "#000000", opacity: 1 };
}

/** Opens `bytes`, adds the marks, returns the saved document with them pending. */
async function withMarks(bytes: ArrayBuffer, marks: Annotation[], extra: PdfAnnotationObject[] = []): Promise<ArrayBuffer> {
  const doc = await open(bytes);
  for (const m of marks) {
    if (m.kind !== "redact") throw new Error("not a mark");
    const page = doc.pages[m.page];
    if (!page) throw new Error("no page");
    await engine.createPageAnnotation(doc, page, toPdfAnnotation(m)).toPromise();
  }
  for (const a of extra) {
    const page = doc.pages[a.pageIndex];
    if (!page) throw new Error("no page");
    await engine.createPageAnnotation(doc, page, a).toPromise();
  }
  const out = (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
  await engine.closeDocument(doc).toPromise();
  return out;
}

/** The file as latin1 text, with every Flate stream inflated (object streams included). */
async function inflatedText(bytes: ArrayBuffer): Promise<string> {
  const { inflateSync } = await import("node:zlib");
  const raw = Buffer.from(bytes);
  const parts = [raw.toString("latin1")];
  let at = 0;
  for (;;) {
    const start = raw.indexOf("stream", at, "latin1");
    if (start < 0) break;
    let body = start + 6;
    if (raw[body] === 0x0d) body++;
    if (raw[body] === 0x0a) body++;
    const end = raw.indexOf("endstream", body, "latin1");
    if (end < 0) break;
    try {
      parts.push(inflateSync(raw.subarray(body, end)).toString("latin1"));
    } catch {
      // Not Flate (or not a stream keyword): ignore.
    }
    at = end + 9;
  }
  return parts.join(" ");
}

/** Page text extracted by PDFium (EmbedPDF types it loosely). */
async function extract(doc: PdfDocumentObject, pages: number[]): Promise<string> {
  const text: unknown = await engine.extractText(doc, pages).toPromise();
  if (typeof text !== "string") throw new Error("no text");
  return text;
}

async function pixel(doc: PdfDocumentObject, index: number, x: number, y: number): Promise<number[]> {
  const page = doc.pages[index];
  if (!page) throw new Error("no page");
  const img = await engine.renderPageRaw(doc, page, { scaleFactor: 1 }).toPromise();
  const o = (Math.round(y) * img.width + Math.round(x)) * 4;
  return Array.from(img.data.slice(o, o + 3));
}

describe("redaction marks", () => {
  it("round-trip as /Redact annotations with their fill and replacement text", async () => {
    const bytes = await withMarks(fixture("greek"), [mark(0, { x: 50, y: 120, width: 200, height: 20 }, "white", "Νέο κείμενο")]);
    const doc = await open(bytes);
    const page = doc.pages[0];
    if (!page) throw new Error("no page");
    const read = ((await engine.getPageAnnotations(doc, page).toPromise()) as PdfAnnotationObject[]).map((a) => fromPdfAnnotation(a));
    const redact = read.find((a) => a.kind === "redact");
    expect(redact).toMatchObject({ kind: "redact", fill: "white", text: "Νέο κείμενο" });
  });
});

describe("applying redactions", () => {
  it("removes the text and the image pixels under the marks, and nothing else", async () => {
    // Page 2: the search line, and the left half of the colour image (x 56–296, y 212–362).
    const pending = await withMarks(fixture("greek"), [
      mark(1, { x: 50, y: 104, width: 420, height: 24 }),
      mark(1, { x: 56, y: 212, width: 120, height: 150 }),
    ]);
    const copy = pending.slice(0);
    const before = await open(pending);
    expect(await extract(before, [1])).toContain("Αναζήτηση");
    const kept = await pixel(before, 1, 250, 280);

    const { bytes, applied } = await applyRedactions(engine, text, pending);
    expect(applied).toBe(2);
    expect(new Uint8Array(pending)).toEqual(new Uint8Array(copy));
    const after = await open(bytes);
    const extracted = await extract(after, [0, 1]);
    expect(extracted).not.toContain("Αναζήτηση");
    expect(extracted).not.toContain("έγγραφο»");
    expect(extracted).toContain("Δεύτερη σελίδα");
    expect(extracted).toContain("Ελληνικό κείμενο");
    // Under the image mark: painted black (the mark's fill), no longer the image.
    expect(await pixel(after, 1, 100, 280)).toEqual([0, 0, 0]);
    expect(await pixel(after, 1, 250, 280)).toEqual(kept);
    // The marks themselves are gone once applied.
    const page = after.pages[1];
    if (!page) throw new Error("no page");
    const left = (await engine.getPageAnnotations(after, page).toPromise()) as PdfAnnotationObject[];
    expect(left.filter((a) => a.type === PdfAnnotationSubtype.REDACT)).toHaveLength(0);
  });

  it("removes annotations over the area and empties form fields there", async () => {
    const r = (x: number, y: number, w: number, h: number) => ({ origin: { x, y }, size: { width: w, height: h } });
    const note = { type: PdfAnnotationSubtype.TEXT, id: "note-secret", pageIndex: 0, rect: r(470, 90, 20, 20), contents: "secret note" };
    const elsewhere = { type: PdfAnnotationSubtype.TEXT, id: "note-kept", pageIndex: 0, rect: r(470, 400, 20, 20), contents: "unrelated comment" };
    // Covers the "Full name" row: its label, the field (value "Ada Lovelace") and the note.
    const pending = await withMarks(
      fixture("acroform"),
      [mark(0, { x: 40, y: 80, width: 460, height: 40 })],
      [note as PdfAnnotationObject, elsewhere as PdfAnnotationObject],
    );
    // Control: the search below does find the content while it is still there.
    expect(await inflatedText(pending)).toContain("Ada Lovelace");
    expect(await inflatedText(pending)).toContain("secret note");
    const { bytes } = await applyRedactions(engine, text, pending);
    const doc = await open(bytes);
    const page = doc.pages[0];
    if (!page) throw new Error("no page");
    const left = (await engine.getPageAnnotations(doc, page).toPromise()) as PdfAnnotationObject[];
    expect(left.map((a) => a.id)).not.toContain("note-secret");
    expect(left.map((a) => a.id), JSON.stringify(left.map((a) => [a.id, a.type, a.contents]))).toContain("note-kept");
    const fields = await documentFields(engine, pdf, doc);
    // The field lost its widget (and its value); the others are as they were.
    expect(fields.find((f) => f.name === "full_name")).toBeUndefined();
    expect(fields.find((f) => f.name === "plan")?.value).toBe("Editor");
    expect(await extract(doc, [0])).not.toContain("Full name");
    // Nowhere in the file, compressed streams included (the field dict outlives its widget).
    const everything = await inflatedText(bytes);
    expect(everything).not.toContain("secret note");
    expect(everything).not.toContain("Ada Lovelace");
    expect(everything).toContain("Editor");
  });

  it("whiteout: white area with the replacement text written in the embedded font", async () => {
    // Page 1, body line 1 ("Η Σελίς κρατά …", baseline y ≈ 132 from the top).
    const pending = await withMarks(fixture("greek"), [mark(0, { x: 50, y: 118, width: 480, height: 20 }, "white", "Διορθωμένο κείμενο")]);
    const before = await open(pending);
    // The line under the box is named here, not read back from the result.
    const removed = GREEK_TEXT[0] as string;
    expect(await extract(before, [0])).toContain(removed);

    const { bytes } = await applyRedactions(engine, text, pending);
    const doc = await open(bytes);
    expect(await extract(doc, [0])).not.toContain(removed);
    const page = doc.pages[0];
    if (!page) throw new Error("no page");
    const annots = (await engine.getPageAnnotations(doc, page).toPromise()) as PdfAnnotationObject[];
    const stamp = annots.find((a) => a.id.startsWith(TEXT_STAMP_PREFIX));
    expect(stamp?.contents).toBe("Διορθωμένο κείμενο");
    // White under the new text's padding; the glyphs of the replacement are drawn (dark pixels in the box).
    expect(await pixel(doc, 0, 528, 120)).toEqual([255, 255, 255]);
    const img = await engine.renderPageRaw(doc, page, { scaleFactor: 1, withAnnotations: true }).toPromise();
    let dark = 0;
    for (let y = 118; y < 138; y++) {
      for (let x = 50; x < 250; x++) {
        const o = (y * img.width + x) * 4;
        if ((img.data[o] ?? 255) < 100) dark++;
      }
    }
    expect(dark).toBeGreaterThan(80);
  });

  it("refuses a document without marks", async () => {
    await expect(applyRedactions(engine, text, fixture("greek"))).rejects.toThrow("no redaction marks");
  });
});

/** The glyph box of the whole line holding `text`: the pdf.js items on its baseline. */
function lineBox(items: readonly TextItem[], page: number, text: string): Box {
  const first = items.find((i) => i.page === page && i.str.trim() !== "" && text.startsWith(i.str.trim()));
  if (!first) throw new Error(`line not found: ${text}`);
  const row = items.filter((i) => i.page === page && Math.abs(i.y - first.y) < 1);
  const x0 = Math.min(...row.map((i) => i.x));
  const x1 = Math.max(...row.map((i) => i.x + i.width));
  const y0 = Math.min(...row.map((i) => i.y));
  const y1 = Math.max(...row.map((i) => i.y + i.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const grow = (b: Box, by: number): PageRect => ({ x: b.x - by, y: b.y - by, width: b.width + 2 * by, height: b.height + 2 * by });

/**
 * The produced file itself, read by pdf.js (not PDFium, which wrote it). The
 * marks are placed from the fixture's line geometry as pdf.js reports it, on
 * the lines the e2e and Maestro flows redact; the P2d sample hard-coded a box
 * that sat on another line than the one it was described as removing.
 */
describe("the redacted file, read by pdf.js", () => {
  // Page 1: body line 2 black, body line 3 whiteout. Page 2: the search line and half of the image.
  const GONE = ["λογαριασμό", "σύννεφο", "παρακολούθηση", "Ξεσκεπάζω", "ψυχοφθόρα", "βδελυγμία", "Αναζήτηση"];
  const KEPT = ["Η Σελίς κρατά", "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ", "Αριθμοί", "Δεύτερη σελίδα"];
  const REPLACEMENT = "Διορθωμένο κείμενο";
  /** Margin around a line's glyph box: covers accents and descenders, clear of the next line (26 pt pitch). */
  const PAD = 3;
  let original: Uint8Array;
  let lines: Record<"above" | "black" | "white" | "below", Box>;
  let marks: Record<"black" | "white" | "search" | "image", PageRect>;
  let pending: Uint8Array;
  let redacted: Uint8Array;

  beforeAll(async () => {
    original = new Uint8Array(fixture("greek"));
    const { items } = await pdfjsText(original);
    const body = (i: number) => lineBox(items, 0, GREEK_TEXT[i] as string);
    lines = { above: body(0), black: body(1), white: body(2), below: body(3) };
    marks = {
      black: grow(lines.black, PAD),
      white: grow(lines.white, PAD),
      search: grow(lineBox(items, 1, "Αναζήτηση: «σελίδα», «έγγραφο»."), PAD),
      // The left half of the colour image (x 56–296, y 212–362 from the top).
      image: { x: 56, y: 212, width: 120, height: 150 },
    };
    // Each mark covers its own line whole and no neighbour.
    for (const key of ["black", "white"] as const) {
      expect(marks[key].y).toBeLessThan(lines[key].y);
      expect(marks[key].y + marks[key].height).toBeGreaterThan(lines[key].y + lines[key].height);
    }
    expect(intersects(marks.black, lines.above)).toBe(false);
    expect(intersects(marks.black, marks.white)).toBe(false);
    expect(intersects(marks.white, lines.below)).toBe(false);

    pending = new Uint8Array(
      await withMarks(original.slice().buffer, [
        mark(0, marks.black),
        mark(0, marks.white, "white", REPLACEMENT),
        mark(1, marks.search),
        mark(1, marks.image),
      ]),
    );
    redacted = new Uint8Array((await applyRedactions(engine, text, pending.slice().buffer)).bytes);
    // qpdf and pdf.js read it; with SELIS_SAMPLES=<dir> it is written there for other readers.
    await checkSample("redacted-greek.pdf", redacted);
  });

  it("no longer extracts the redacted lines, and still extracts the rest", async () => {
    const before = (await pdfjsText(pending)).pages.join("\n");
    for (const w of GONE) expect(before).toContain(w);
    const after = (await pdfjsText(redacted)).pages.join("\n");
    for (const w of GONE) expect(after).not.toContain(w);
    for (const w of KEPT) expect(after).toContain(w);
  });

  it("leaves no redacted string in the bytes: raw, inflated, as text or as glyph codes", () => {
    const glyphs = GONE.flatMap((w) => greekGlyphHex(w));
    // Control: the same search finds every glyph run while the content is still there.
    expect(findInFile(pending, [], glyphs)).toEqual(glyphs.map((g) => `glyphs <${g}>`));
    expect(findInFile(redacted, GONE, glyphs)).toEqual([]);
    expect(findInFile(redacted, [], greekGlyphHex("Αριθμοί"))).toHaveLength(1);
  });

  it("leaves no /Redact mark: only the whiteout's text stamp, where the mark was (±2 pt)", async () => {
    const annots = await pdfjsAnnotations(redacted);
    expect(annots.map((a) => a.subtype)).toEqual(["Stamp"]);
    const stamp = annots[0];
    if (!stamp) throw new Error("no stamp");
    expect(stamp.page).toBe(0);
    expect(stamp.contents).toBe(REPLACEMENT);
    expect(boxDistance(stamp.rect, marks.white)).toBeLessThanOrEqual(2);
  });

  it("paints each black box where its mark was (±2 pt), on its page", async () => {
    const at = async (page: number, m: PageRect) => solidBox(await pdfjsRender(redacted, page, 2, false), grow(m, 10), isDark);
    for (const [page, m] of [
      [0, marks.black],
      [1, marks.search],
      [1, marks.image],
    ] as const) {
      const painted = await at(page, m);
      expect(painted, `black box on page ${page + 1}`).not.toBeNull();
      if (painted) expect(boxDistance(painted, m), JSON.stringify({ page, painted, m })).toBeLessThanOrEqual(2);
    }
  });

  it("whiteout: its line is blank, the lines around it are untouched, the new text is inside the box", async () => {
    const before = await pdfjsRender(original, 0, 2, false);
    const content = await pdfjsRender(redacted, 0, 2, false);
    expect(countPixels(before, lines.white, isDark)).toBeGreaterThan(200);
    expect(countPixels(content, marks.white, isDark)).toBe(0);
    for (const line of [lines.above, lines.below]) expect(countPixels(content, line, isDark)).toBe(countPixels(before, line, isDark));
    const shown = await pdfjsRender(redacted, 0, 2, true);
    expect(countPixels(shown, marks.white, isDark)).toBeGreaterThan(150);
    // Nothing of the stamp is drawn outside its box.
    const ring = grow(marks.white, 6);
    const outside = (img: Raster) => countPixels(img, ring, isDark) - countPixels(img, marks.white, isDark);
    expect(outside(shown)).toBe(outside(content));
  });

  it("form: no trace of the redacted value or label, no mark left, the other fields kept", async () => {
    const formPending = new Uint8Array(await withMarks(fixture("acroform"), [mark(0, { x: 40, y: 80, width: 460, height: 40 })]));
    const out = new Uint8Array((await applyRedactions(engine, text, formPending.slice().buffer)).bytes);
    expect(findInFile(formPending, ["Ada Lovelace"])).toEqual(["Ada Lovelace"]);
    expect(findInFile(out, ["Ada Lovelace"])).toEqual([]);
    expect((await pdfjsText(out)).pages.join("\n")).not.toContain("Full name");
    const annots = await pdfjsAnnotations(out);
    expect(annots.some((a) => a.subtype === "Redact")).toBe(false);
    expect(annots.filter((a) => a.subtype === "Widget").length).toBeGreaterThan(0);
    await checkSample("redacted-form.pdf", out);
  });
});
