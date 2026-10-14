/**
 * OCR text layer (P4d, ADR 0018) end to end in Node: the scanned fixtures rendered by PDFium at
 * 300 dpi, read by Tesseract (tesseract.js, tessdata_fast el + en, the app's models), laid out
 * by @selis/ocr and written by `EmbeddedText.setTextLayer`; the saved PDF is read back by
 * pdf.js. AC: pdf.js extracts ≥ 95 % of the words the page shows, Greek accents included; the
 * page looks the same; a second run replaces the layer and returns it (undo).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { PdfDocumentObject, PdfPageObject } from "@embedpdf/models";
import { init } from "@embedpdf/pdfium";
import { createCanvas } from "@napi-rs/canvas";
import { FIXTURES, type FixtureName, scannedWords } from "@selis/fixtures";
import { pdfjsRender, pdfjsText } from "@selis/fixtures/oracle";
import { createOcr, layoutWords, type Ocr, wordKey } from "@selis/ocr";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EmbeddedText } from "./annotations";

const require = createRequire(import.meta.url);
const FONT = new Uint8Array(readFileSync(new URL("../assets/SelisSans-LatinGreek.ttf", import.meta.url)));
const TESSDATA = join(import.meta.dirname, "..", "..", "ocr", "tessdata");
let engine: PdfiumNative;
let text: EmbeddedText;
let ocr: Ocr;

beforeAll(async () => {
  const wasm = readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
  const pdf = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
  engine = new PdfiumNative(pdf, { fontFallback: null });
  text = new EmbeddedText(engine, pdf, () => Promise.resolve(FONT));
  ocr = await createOcr("ell+eng", { langPath: TESSDATA });
}, 120_000);

afterAll(async () => {
  await ocr.terminate();
});

let nextId = 0;
async function open(content: ArrayBuffer): Promise<PdfDocumentObject> {
  return engine.openDocumentBuffer({ id: `ocr-${String(nextId++)}`, content }).toPromise();
}

function fixture(name: FixtureName): ArrayBuffer {
  const f = FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(name);
  return f.build().slice().buffer;
}

function page(doc: PdfDocumentObject, index: number): PdfPageObject {
  const p = doc.pages[index];
  if (!p) throw new Error(`no page ${String(index)}`);
  return p;
}

/** Page `index` as a PNG at 300 dpi, as the app hands it to Tesseract. */
async function pagePng(doc: PdfDocumentObject, index: number): Promise<Uint8Array> {
  const raw = await engine.renderPageRaw(doc, page(doc, index), { scaleFactor: 300 / 72, dpr: 1 }).toPromise();
  const canvas = createCanvas(raw.width, raw.height);
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(raw.width, raw.height);
  image.data.set(raw.data);
  ctx.putImageData(image, 0, 0);
  return new Uint8Array(canvas.encodeSync("png"));
}

async function ocrPage(doc: PdfDocumentObject, index: number): Promise<number> {
  const p = page(doc, index);
  const read = await ocr.recognize(await pagePng(doc, index), 300);
  const words = layoutWords(read, p.size.width, p.size.height);
  await text.setTextLayer(doc, p, words);
  return words.length;
}

/** Share of `expected` words (with repeats) that `found` contains. */
function recall(expected: readonly string[], found: readonly string[]): { share: number; missing: string[] } {
  const pool = new Map<string, number>();
  for (const w of found.map(wordKey)) pool.set(w, (pool.get(w) ?? 0) + 1);
  const missing: string[] = [];
  for (const w of expected.map(wordKey)) {
    const left = pool.get(w) ?? 0;
    if (left > 0) pool.set(w, left - 1);
    else missing.push(w);
  }
  return { share: (expected.length - missing.length) / expected.length, missing };
}

describe.each([
  ["scanned-greek", "greek"],
  ["scanned-english", "english"],
] as const)("%s", (name, language) => {
  it("gets a text layer pdf.js reads: ≥ 95 % of the words, the page unchanged", async () => {
    const doc = await open(fixture(name));
    const before = await pdfjsText(new Uint8Array((await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer));
    expect(before.pages.join("").trim()).toBe("");
    for (let i = 0; i < doc.pages.length; i++) {
      const started = performance.now();
      const count = await ocrPage(doc, i);
      console.info(`${name} page ${String(i + 1)}: ${String(count)} words in ${String(Math.round(performance.now() - started))} ms`);
      expect(text.pageTextInfo(doc, page(doc, i))).toEqual({ chars: 0, ocr: true });
    }
    const saved = new Uint8Array((await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer);
    const extracted = await pdfjsText(saved);
    for (let i = 0; i < doc.pages.length; i++) {
      const found = (extracted.pages[i] ?? "").split(/\s+/).filter((w) => w !== "");
      const { share, missing } = recall(scannedWords(language, i), found);
      console.info(`${name} page ${String(i + 1)}: ${(share * 100).toFixed(1)} % of the words; missing ${missing.join(" ")}`);
      expect(share).toBeGreaterThanOrEqual(0.95);
    }
    // Invisible: the page renders as it did.
    const original = await pdfjsRender(new Uint8Array(fixture(name)), 0, 0.5);
    const after = await pdfjsRender(saved, 0, 0.5);
    let diff = 0;
    for (let i = 0; i < original.data.length; i++) diff = Math.max(diff, Math.abs((original.data[i] ?? 0) - (after.data[i] ?? 0)));
    expect(diff).toBe(0);
  });
});

it("finds Greek words with accents where they are on the page", async () => {
  const doc = await open(fixture("scanned-greek"));
  await ocrPage(doc, 1);
  const saved = new Uint8Array((await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer);
  const { items } = await pdfjsText(saved);
  const hit = items.find((item) => item.page === 1 && wordKey(item.str) === "Ευρωπαϊκή");
  expect(hit).toBeDefined();
  // Third line of page 2, about 2.9 in from the top (300 + 2 × 76 px, 110 for the heading).
  expect(hit?.y).toBeGreaterThan(120);
  expect(hit?.y).toBeLessThan(175);
});

it("replaces its own layer and hands back the words it replaced (undo)", async () => {
  const doc = await open(fixture("scanned-english"));
  const p = page(doc, 1);
  const first = [{ text: "first", x: 50, y: 100, width: 40, fontSize: 12 }];
  // A search before the layer loads (and caches) the page's text: it must not stay stale.
  expect(await engine.searchInPage(doc, p, "first", 0).toPromise()).toHaveLength(0);
  expect(await text.setTextLayer(doc, p, first)).toEqual([]);
  expect(await engine.searchInPage(doc, p, "first", 0).toPromise()).toHaveLength(1);
  const replaced = await text.setTextLayer(doc, p, [{ text: "second", x: 60, y: 120, width: 50, fontSize: 11 }]);
  expect(replaced).toEqual(first);
  // Undo: the first layer back; the second is what it replaced.
  expect(await text.setTextLayer(doc, p, replaced)).toEqual([{ text: "second", x: 60, y: 120, width: 50, fontSize: 11 }]);
  const saved = new Uint8Array((await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer);
  expect((await pdfjsText(saved)).pages[1]?.trim()).toBe("first");
  // Removing the layer leaves the page without text again.
  await text.setTextLayer(doc, p, []);
  expect(text.pageTextInfo(doc, p)).toEqual({ chars: 0, ocr: false });
});

it("counts a page's own text apart from the OCR layer", async () => {
  const doc = await open(fixture("greek"));
  const info = text.pageTextInfo(doc, page(doc, 0));
  expect(info.ocr).toBe(false);
  expect(info.chars).toBeGreaterThan(100);
});
