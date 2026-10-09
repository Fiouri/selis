/**
 * Runs the real EmbedPDF PDFium WASM (same build the worker uses) in Node
 * against the generated fixture corpus. Validates both the engine wiring and
 * the fixtures themselves.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import { type PdfDocumentObject, PdfErrorCode } from "@embedpdf/models";
import { init } from "@embedpdf/pdfium";
import { ENCRYPTED_PASSWORD, FIXTURES, type FixtureName } from "@selis/fixtures";
import { beforeAll, describe, expect, it } from "vitest";
import { clampScale } from "./protocol";

const require = createRequire(import.meta.url);
let engine: PdfiumNative;
const built = new Map<FixtureName, Uint8Array>();

function bytes(name: FixtureName): ArrayBuffer {
  let b = built.get(name);
  if (!b) {
    const fixture = FIXTURES.find((f) => f.name === name);
    if (!fixture) throw new Error(`unknown fixture ${name}`);
    b = fixture.build();
    built.set(name, b);
  }
  return b.slice().buffer;
}

async function open(name: FixtureName, password?: string): Promise<PdfDocumentObject> {
  return engine
    .openDocumentBuffer({ id: `${name}-${Math.random()}`, content: bytes(name) }, password ? { password } : {})
    .toPromise();
}

/** Fraction of pixels that are not near-white. */
function inkRatio(data: Uint8ClampedArray): number {
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i] as number) < 200 || (data[i + 1] as number) < 200 || (data[i + 2] as number) < 200) ink++;
  }
  return ink / (data.length / 4);
}

beforeAll(async () => {
  const wasmBinary = readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
  const module = await init({ wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) });
  engine = new PdfiumNative(module, { fontFallback: null });
}, 60_000);

describe("PDFium WASM against the fixture corpus", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name}: opens with ${fixture.pageCount} pages and renders page 1`, async () => {
      const doc = await open(fixture.name, fixture.password);
      expect(doc.pageCount).toBe(fixture.pageCount);
      const page = doc.pages[0];
      if (!page) throw new Error("no first page");
      const raw = await engine.renderPageRaw(doc, page, { scaleFactor: 0.5, dpr: 1 }).toPromise();
      expect(raw.width).toBe(Math.round(page.size.width * 0.5));
      expect(inkRatio(raw.data)).toBeGreaterThan(0.002);
      await engine.closeDocument(doc).toPromise();
    });
  }

  it("large-1000: renders the last page", async () => {
    const doc = await open("large-1000");
    const last = doc.pages[999];
    if (!last) throw new Error("no page 1000");
    const raw = await engine.renderPageRaw(doc, last, { scaleFactor: 0.25, dpr: 1 }).toPromise();
    expect(inkRatio(raw.data)).toBeGreaterThan(0.002);
    await engine.closeDocument(doc).toPromise();
  });

  it("encrypted: requires the password", async () => {
    await expect(open("encrypted")).rejects.toMatchObject({ reason: { code: PdfErrorCode.Password } });
    const doc = await open("encrypted", ENCRYPTED_PASSWORD);
    expect(doc.isEncrypted).toBe(true);
    const text = String(await engine.extractText(doc, [0]).toPromise());
    expect(text).toContain("Encrypted page 1");
    await engine.closeDocument(doc).toPromise();
  });

  it("greek: text extracts as Unicode Greek", async () => {
    const doc = await open("greek");
    const text = String(await engine.extractText(doc, [0]).toPromise());
    expect(text).toContain("Ελληνικό κείμενο");
    expect(text).toContain("ά έ ή ί ό ύ ώ");
    const meta = await engine.getMetadata(doc).toPromise();
    expect(meta.title).toBe("Ελληνικό δοκιμαστικό");
    await engine.closeDocument(doc).toPromise();
  });

  it("acroform: exposes the form widgets", async () => {
    const doc = await open("acroform");
    const page = doc.pages[0];
    if (!page) throw new Error("no page");
    const annots = (await engine.getPageAnnotations(doc, page).toPromise()) as unknown[];
    expect(annots).toHaveLength(4);
    await engine.closeDocument(doc).toPromise();
  });

  it("mixed-sizes: keeps every page size", async () => {
    const doc = await open("mixed-sizes");
    const sizes = doc.pages.map((p) => [Math.round(p.size.width), Math.round(p.size.height)]);
    expect(sizes).toContainEqual([595, 420]); // A5 landscape
    expect(sizes).toContainEqual([227, 850]); // receipt
    await engine.closeDocument(doc).toPromise();
  });

  it("clampScale keeps a huge render within the pixel budget", () => {
    const a4 = { width: 595, height: 842 };
    const scale = clampScale(a4, 20);
    expect(a4.width * scale * a4.height * scale).toBeLessThanOrEqual(16_777_216 + 1);
  });
});
