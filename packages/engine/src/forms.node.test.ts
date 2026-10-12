/**
 * Forms and visual signatures through the real PDFium WASM: fields are filled
 * (Greek included), saved, reopened by a fresh engine (like another reader
 * would) and read back; flattening and its undo (reload) round-trip.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { PdfAnnotationObject, PdfDocumentObject, PdfPageObject } from "@embedpdf/models";
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import { FIXTURES, type FixtureName } from "@selis/fixtures";
import { checkSample } from "@selis/fixtures/oracle";
import { beforeAll, describe, expect, it } from "vitest";
import { EmbeddedText, fromPdfAnnotation, SIGNATURE_CONTENTS, SIGNATURE_PREFIX, toSignatureStamp } from "./annotations";
import { documentFields, flattenAll, pageWidgets, setField, toFormField } from "./forms";
import type { PageRect } from "./geometry";
import type { FormField } from "./types";

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

async function open(content: ArrayBuffer, reader = engine): Promise<PdfDocumentObject> {
  return reader.openDocumentBuffer({ id: `f-${nextId++}`, content }).toPromise();
}

function page0(doc: PdfDocumentObject): PdfPageObject {
  const p = doc.pages[0];
  if (!p) throw new Error("no page");
  return p;
}

/** Saves and reopens in a separate engine instance (no shared state with the writer). */
async function reopen(doc: PdfDocumentObject): Promise<{ reader: PdfiumNative; doc: PdfDocumentObject }> {
  const bytes = (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
  const reader = new PdfiumNative(pdf, { fontFallback: null });
  return { reader, doc: await open(bytes, reader) };
}

async function fields(doc: PdfDocumentObject, reader = engine): Promise<FormField[]> {
  return (await pageWidgets(reader, doc, page0(doc))).map(toFormField);
}

function byName(list: readonly FormField[], name: string): FormField {
  const f = list.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name}`);
  return f;
}

async function inkIn(reader: PdfiumNative, doc: PdfDocumentObject, r: PageRect): Promise<number> {
  const raw = await reader
    .renderPageRect(doc, page0(doc), { origin: { x: r.x, y: r.y }, size: { width: r.width, height: r.height } }, {
      scaleFactor: 2,
      dpr: 1,
      withAnnotations: true,
      withForms: true,
    })
    .toPromise();
  let n = 0;
  for (let i = 0; i < raw.data.length; i += 4) if ((raw.data[i] as number) < 128) n++;
  return n;
}

describe("form fields", () => {
  it("lists the fixture's text, checkbox and choice fields", async () => {
    const list = await fields(await open(fixture("acroform")));
    expect(list.map((f) => [f.name, f.kind])).toEqual([
      ["full_name", "text"],
      ["email", "text"],
      ["agree", "checkbox"],
      ["plan", "combobox"],
    ]);
    expect(byName(list, "plan").options.length).toBeGreaterThan(1);
  });

  it("finds every widget of a form document, and none (cheaply) elsewhere", async () => {
    const form = await open(fixture("acroform"));
    expect((await documentFields(engine, pdf, form)).map((f) => f.name)).toEqual(["full_name", "email", "agree", "plan"]);
    expect(await documentFields(engine, pdf, await open(fixture("large-1000")))).toEqual([]);
  });

  it("fills Greek text that another reader draws and reads back", async () => {
    const doc = await open(fixture("acroform"));
    const name = byName(await fields(doc), "full_name");
    const after = await setField(engine, text, doc, page0(doc), name.id, { kind: "text", text: "Γιάννης Παπαδόπουλος" });
    expect(byName(after, "full_name").value).toBe("Γιάννης Παπαδόπουλος");
    const other = await reopen(doc);
    const back = byName(await fields(other.doc, other.reader), "full_name");
    expect(back.value).toBe("Γιάννης Παπαδόπουλος");
    // PDFium's own appearance would draw nothing for Greek (no glyphs in Helvetica).
    expect(await inkIn(other.reader, other.doc, back.rect)).toBeGreaterThan(500);
    // And the right glyphs: flattened, the appearance is page text that extracts back.
    await flattenAll(other.reader, other.doc);
    const flat = await open((await other.reader.saveAsCopy(other.doc).toPromise()) as ArrayBuffer);
    const pageText = (await engine.extractText(flat, [0]).toPromise()) as string;
    expect(pageText).toContain("Editor");
    expect(pageText).toContain("Γιάννης Παπαδόπουλος");
  });

  it("going back from Greek to Latin drops the overlay and PDFium draws the field again", async () => {
    const doc = await open(fixture("acroform"));
    const name = byName(await fields(doc), "full_name");
    await setField(engine, text, doc, page0(doc), name.id, { kind: "text", text: "Σοφία" });
    await setField(engine, text, doc, page0(doc), name.id, { kind: "text", text: "Sofia" });
    const other = await reopen(doc);
    const raw = (await other.reader.getPageAnnotations(other.doc, page0(other.doc)).toPromise()) as PdfAnnotationObject[];
    expect(raw.some((a) => a.id.startsWith("selis-field-"))).toBe(false);
    expect(await inkIn(other.reader, other.doc, name.rect)).toBeGreaterThan(200);
    expect(byName(await fields(other.doc, other.reader), "full_name").value).toBe("Sofia");
  });

  it("fills Latin text with PDFium's own appearance", async () => {
    const doc = await open(fixture("acroform"));
    const email = byName(await fields(doc), "email");
    await setField(engine, text, doc, page0(doc), email.id, { kind: "text", text: "anna@example.org" });
    const other = await reopen(doc);
    const back = byName(await fields(other.doc, other.reader), "email");
    expect(back.value).toBe("anna@example.org");
    expect(await inkIn(other.reader, other.doc, back.rect)).toBeGreaterThan(300);
  });

  it("toggles a checkbox and selects a choice", async () => {
    const doc = await open(fixture("acroform"));
    const list = await fields(doc);
    // The fixture starts with "I agree" ticked and "Editor" chosen.
    const agree = byName(list, "agree");
    expect(agree.checked).toBe(true);
    const plan = byName(list, "plan");
    expect(plan.value).toBe("Editor");
    await setField(engine, text, doc, page0(doc), agree.id, { kind: "checked", checked: false });
    await setField(engine, text, doc, page0(doc), plan.id, { kind: "select", index: 2 });
    const other = await reopen(doc);
    const back = await fields(other.doc, other.reader);
    expect(byName(back, "agree").checked).toBe(false);
    expect(byName(back, "plan").value).toBe("Archivist");
    expect(byName(back, "plan").options.map((o) => o.selected)).toEqual([false, false, true]);
  });

  it("flattening keeps what the fields show but leaves no fields; reload undoes it", async () => {
    const doc = await open(fixture("acroform"));
    const name = byName(await fields(doc), "full_name");
    await setField(engine, text, doc, page0(doc), name.id, { kind: "text", text: "Σοφία" });
    const before = (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
    expect(await flattenAll(engine, doc)).toBeGreaterThan(0);
    const other = await reopen(doc);
    expect(await fields(other.doc, other.reader)).toHaveLength(0);
    expect(await inkIn(other.reader, other.doc, name.rect)).toBeGreaterThan(200);
    // Undo: the snapshot from before still has every field, filled.
    const restored = await open(before);
    expect(byName(await fields(restored), "full_name").value).toBe("Σοφία");
  });
});

/** A minimal RGBA PNG (no filtering), for signature images. */
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): ArrayBuffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(Buffer.from(type, "latin1"), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (1 + width * 4) + 1 + x * 4);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out.buffer;
}

describe("visual signatures", () => {
  // A dark diagonal stroke on a transparent background.
  const image = png(120, 40, (x, y) => (Math.abs(y - x / 3) < 2 ? [20, 30, 120, 255] : [255, 255, 255, 0]));
  const rect = { x: 56, y: 100, width: 180, height: 60 };

  it("is a print-flagged stamp labelled as a visual signature, transparent around the ink", async () => {
    const doc = await open(fixture("greek"));
    const sig = { id: `${SIGNATURE_PREFIX}1`, page: 0, kind: "signature" as const, rect, color: "#000000", opacity: 1, image: { mime: "image/png" as const, bytes: image } };
    await engine.createPageAnnotation(doc, page0(doc), toSignatureStamp(sig), { data: sig.image.bytes }).toPromise();
    const other = await reopen(doc);
    const raw = (await other.reader.getPageAnnotations(other.doc, page0(other.doc)).toPromise()) as PdfAnnotationObject[];
    const stamp = raw.find((a) => a.id === sig.id);
    if (!stamp) throw new Error("signature lost on save");
    expect(stamp.contents).toBe(SIGNATURE_CONTENTS);
    expect(fromPdfAnnotation(stamp)).toMatchObject({ kind: "signature", image: null });
    // The page text under the transparent part still shows (the first line is at y ≈ 120–135).
    const textUnder = await inkIn(other.reader, other.doc, { x: 140, y: 118, width: 90, height: 18 });
    expect(textUnder).toBeGreaterThan(100);
  });

  it("can be recreated from its exported appearance (undo of an erase)", async () => {
    const doc = await open(fixture("greek"));
    const page = page0(doc);
    const sig = { id: `${SIGNATURE_PREFIX}2`, page: 0, kind: "signature" as const, rect, color: "#000000", opacity: 1, image: { mime: "image/png" as const, bytes: image } };
    await engine.createPageAnnotation(doc, page, toSignatureStamp(sig), { data: image }).toPromise();
    const raw = (await engine.getPageAnnotations(doc, page).toPromise()) as PdfAnnotationObject[];
    const found = raw.find((a) => a.id === sig.id);
    if (!found) throw new Error("not created");
    const appearance = await engine.exportAnnotationAppearanceAsPdf(doc, page, found).toPromise();
    const inkBefore = await inkIn(engine, doc, rect);
    await engine.removePageAnnotation(doc, page, found).toPromise();
    expect(await inkIn(engine, doc, rect)).toBeLessThan(inkBefore);
    await engine.createPageAnnotation(doc, page, toSignatureStamp(sig), { data: appearance }).toPromise();
    expect(Math.abs((await inkIn(engine, doc, rect)) - inkBefore)).toBeLessThan(inkBefore * 0.2);
  });
});

/** The P2b samples, read by qpdf and pdf.js (checkSample; with SELIS_SAMPLES=<dir> also written there). */
describe("samples for other readers", () => {
  it("a filled Greek form (fillable and flattened) and a signed page", async () => {
    const doc = await open(fixture("acroform"));
    const list = await fields(doc);
    await setField(engine, text, doc, page0(doc), byName(list, "full_name").id, { kind: "text", text: "Γιάννης Παπαδόπουλος" });
    await setField(engine, text, doc, page0(doc), byName(list, "email").id, { kind: "text", text: "giannis@example.gr" });
    await setField(engine, text, doc, page0(doc), byName(list, "plan").id, { kind: "select", index: 2 });
    const sig = png(240, 70, (x, y) => (Math.abs(y - 35 - 22 * Math.sin(x / 18)) < 2.5 ? [20, 30, 120, 255] : [255, 255, 255, 0]));
    const stamp = { id: `${SIGNATURE_PREFIX}s`, page: 0, kind: "signature" as const, rect: { x: 320, y: 520, width: 180, height: 52 }, color: "#000000", opacity: 1, image: { mime: "image/png" as const, bytes: sig } };
    await engine.createPageAnnotation(doc, page0(doc), toSignatureStamp(stamp), { data: sig }).toPromise();
    await checkSample("form-filled-signed.pdf", new Uint8Array((await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer));
    await flattenAll(engine, doc);
    await checkSample("form-flattened.pdf", new Uint8Array((await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer));
  });
});
