/**
 * Text runs of the selection / copy / accessibility layer (worker `text` request): EmbedPDF's
 * getPageTextRects gives the boxes, `EmbeddedText.boundedTexts` the exact text of each. EmbedPDF's
 * own `content` can end in stray characters it decodes past PDFium's output (found by the P5a
 * store screenshots: "Landlord" followed by CJK characters, "Plan" followed by U+0010).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { PdfDocumentObject, PdfTextRectObject } from "@embedpdf/models";
import { init } from "@embedpdf/pdfium";
import { FIXTURES, type FixtureName } from "@selis/fixtures";
import { beforeAll, describe, expect, it } from "vitest";
import { EmbeddedText } from "./annotations";

const require = createRequire(import.meta.url);
let engine: PdfiumNative;
let text: EmbeddedText;

beforeAll(async () => {
  const wasm = readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
  const pdf = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
  engine = new PdfiumNative(pdf, { fontFallback: null });
  text = new EmbeddedText(engine, pdf, () => Promise.reject(new Error("no font needed")));
}, 60_000);

let nextId = 0;
async function open(name: FixtureName): Promise<PdfDocumentObject> {
  const f = FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(name);
  return engine.openDocumentBuffer({ id: `runs-${String(nextId++)}`, content: f.build().slice().buffer }).toPromise();
}

// Control characters and the arrow / Tifinagh / CJK / Hangul ranges the stray tails came from
// never occur in the Latin + Greek corpus.
// eslint-disable-next-line no-control-regex -- the stray tails include control characters
const STRAY = /[\u0000-\u0008\u000b-\u001f⬀-⯿ⴀ-ⷿ㐀-퟿]/u;

async function runs(name: FixtureName): Promise<{ reported: string[]; exact: string[] }> {
  const doc = await open(name);
  const reported: string[] = [];
  const exact: string[] = [];
  for (const page of doc.pages) {
    const rects = (await engine.getPageTextRects(doc, page).toPromise()) as PdfTextRectObject[];
    const boxes = rects.map((r) => ({ x: r.rect.origin.x, y: r.rect.origin.y, width: r.rect.size.width, height: r.rect.size.height }));
    reported.push(...rects.map((r) => r.content));
    exact.push(...text.boundedTexts(doc, page, boxes));
  }
  return { reported, exact };
}

describe("text runs", () => {
  for (const name of ["greek", "acroform"] as FixtureName[]) {
    it(`${name}: every run is the page's text, without stray characters`, async () => {
      const { reported, exact } = await runs(name);
      expect(exact).toHaveLength(reported.length);
      for (const t of exact) expect(t, JSON.stringify(t)).not.toMatch(STRAY);
      // The upstream bug this works around (if EmbedPDF fixes it, this fails: drop the workaround).
      expect(reported.some((t) => STRAY.test(t))).toBe(true);
    });
  }

  it("acroform: the field labels read as they print", async () => {
    const { exact } = await runs("acroform");
    expect(exact.map((t) => t.trim())).toEqual(expect.arrayContaining(["Membership form", "Full name", "Email", "Plan"]));
  });
});
