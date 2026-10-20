/**
 * Text geometry on rotated pages (ADR 0034): where the engine says a word is must be where
 * PDFium draws it, on /Rotate 0, 90, 180 and 270 pages with a crop box, for upright words and a
 * word turned by its text matrix. The drawn glyphs are found in a render, inside a window
 * computed here independently from the fixture's coordinates. Then redaction and erase on those
 * rects remove exactly the chosen word, and an OCR word lands where it was placed.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { PdfDocumentObject, PdfPageObject, PdfTextRectObject } from "@embedpdf/models";
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import { FIXTURES, ROTATED_PAGES, ROTATED_WORDS } from "@selis/fixtures";
import { pdfjsText } from "@selis/fixtures/oracle";
import { beforeAll, describe, expect, it } from "vitest";
import { EmbeddedText, toPdfAnnotation } from "./annotations";
import { eraseArea } from "./erase";
import type { PageRect } from "./geometry";
import { applyRedactions } from "./redact";
import { pageGlyphs, pageTextBoxes } from "./text-geometry";

const require = createRequire(import.meta.url);
const FONT = new Uint8Array(readFileSync(new URL("../assets/SelisSans-LatinGreek.ttf", import.meta.url)));
const SCALE = 2;
/** The fixture's crop box. */
const CROP = { x0: 30, y0: 40, x1: 595.28 - 10, y1: 841.89 - 20 };
const WORDS = [...ROTATED_WORDS.upright.map(([w]) => w), ROTATED_WORDS.turned[0]] as string[];

let pdf: WrappedPdfiumModule;
let engine: PdfiumNative;
let text: EmbeddedText;
let fixture: ArrayBuffer;
let nextId = 0;

beforeAll(async () => {
  const wasm = readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
  pdf = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
  engine = new PdfiumNative(pdf, { fontFallback: null });
  text = new EmbeddedText(engine, pdf, () => Promise.resolve(FONT));
  const f = FIXTURES.find((x) => x.name === "rotated-text");
  if (!f) throw new Error("fixture");
  fixture = f.build().slice().buffer;
}, 60_000);

async function withDoc<T>(bytes: ArrayBuffer, use: (doc: PdfDocumentObject) => T | Promise<T>): Promise<T> {
  const doc = await engine.openDocumentBuffer({ id: `rot-${nextId++}`, content: bytes.slice(0) }).toPromise();
  try {
    return await use(doc);
  } finally {
    await engine.closeDocument(doc).toPromise();
  }
}

/** A user-space point on the page as shown (points, top-left origin), worked out here. */
function shown(rotate: number, x: number, y: number): { x: number; y: number } {
  const w = CROP.x1 - CROP.x0;
  const h = CROP.y1 - CROP.y0;
  const u = x - CROP.x0;
  const v = y - CROP.y0;
  if (rotate === 0) return { x: u, y: h - v };
  if (rotate === 90) return { x: v, y: u };
  if (rotate === 180) return { x: w - u, y: v };
  return { x: h - v, y: w - u };
}

function shownBox(rotate: number, x0: number, y0: number, x1: number, y1: number): PageRect {
  const a = shown(rotate, x0, y0);
  const b = shown(rotate, x1, y1);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** Where each word may be drawn on a page (generous: 15–30 pt around it, nothing else inside). */
function window(rotate: number, word: string): PageRect {
  const upright = ROTATED_WORDS.upright.find(([w]) => w === word);
  if (upright) return shownBox(rotate, upright[1] - 15, upright[2] - 15, upright[1] + 100, upright[2] + 30);
  const [, x, y] = ROTATED_WORDS.turned;
  return shownBox(rotate, x - 30, y - 15, x + 15, y + 100);
}

type Raster = { width: number; height: number; data: Uint8Array | Uint8ClampedArray };

/** The bounding box of the dark pixels inside `area`, or null. */
function ink(img: Raster, area: PageRect): PageRect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let py = Math.max(0, Math.floor(area.y * SCALE)); py < Math.min(img.height, Math.ceil((area.y + area.height) * SCALE)); py++) {
    for (let px = Math.max(0, Math.floor(area.x * SCALE)); px < Math.min(img.width, Math.ceil((area.x + area.width) * SCALE)); px++) {
      if ((img.data[(py * img.width + px) * 4] ?? 255) >= 128) continue;
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px + 1);
      y1 = Math.max(y1, py + 1);
    }
  }
  return x0 === Infinity ? null : { x: x0 / SCALE, y: y0 / SCALE, width: (x1 - x0) / SCALE, height: (y1 - y0) / SCALE };
}

function iou(a: PageRect, b: PageRect): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const i = w * h;
  return i / (a.width * a.height + b.width * b.height - i);
}

const contains = (outer: PageRect, inner: PageRect, slack = 0.5): boolean =>
  inner.x >= outer.x - slack &&
  inner.y >= outer.y - slack &&
  inner.x + inner.width <= outer.x + outer.width + slack &&
  inner.y + inner.height <= outer.y + outer.height + slack;

const union = (rects: readonly PageRect[]): PageRect => {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, width: Math.max(...rects.map((r) => r.x + r.width)) - x, height: Math.max(...rects.map((r) => r.y + r.height)) - y };
};

/** The text layer's run holding `word` (box and exact text, as the worker builds them). */
function textRun(doc: PdfDocumentObject, page: PdfPageObject, word: string): PageRect {
  const boxes = pageTextBoxes(engine, pdf, doc, page);
  const texts = text.boundedTexts(doc, page, boxes);
  const i = texts.findIndex((t) => t.trim() === word);
  const box = boxes[i];
  if (!box) throw new Error(`no run "${word}" on page ${page.index + 1}: ${JSON.stringify(texts)}`);
  return box;
}

const grow = (r: PageRect, by: number): PageRect => ({ x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by });

describe("text geometry on rotated pages", () => {
  for (const [i, rotate] of ROTATED_PAGES.entries()) {
    it(`/Rotate ${rotate}: the text layer, search and glyph boxes sit on the drawn words`, async () => {
      await withDoc(fixture, async (doc) => {
        const page = doc.pages[i] as PdfPageObject;
        const img = await engine.renderPageRaw(doc, page, { scaleFactor: SCALE }).toPromise();
        const glyphs = pageGlyphs(engine, pdf, doc, page);
        for (const word of WORDS) {
          const drawn = ink(img, window(rotate, word));
          if (!drawn) throw new Error(`"${word}" not drawn on page ${i + 1}`);
          // The text layer (selection, copy): its run is the word, on the glyphs.
          const run = textRun(doc, page, word);
          expect(iou(run, drawn), `run ${word} @${rotate}: ${JSON.stringify({ run, drawn })}`).toBeGreaterThanOrEqual(0.9);
          // Search highlights.
          const hit = (await engine.searchInPage(doc, page, word, 0).toPromise())[0]?.rects[0];
          if (!hit) throw new Error(`search found no "${word}"`);
          const hitRect = { x: hit.origin.x, y: hit.origin.y, width: hit.size.width, height: hit.size.height };
          expect(iou(hitRect, drawn), `search ${word} @${rotate}`).toBeGreaterThanOrEqual(0.9);
          // Glyph boxes (text selection for markup and redaction): the word's loose boxes hold
          // all of its ink and run along the same axis (their extra is the font's ascent/descent).
          const own = glyphs.filter((g) => g.width > 0 && iou(g, drawn) > 0 && contains(drawn, { x: g.x + g.width / 2, y: g.y + g.height / 2, width: 0, height: 0 }));
          expect(own, `glyphs of ${word} @${rotate}`).toHaveLength(word.length);
          const box = union(own);
          expect(contains(box, drawn, 1), `glyph union ${word} @${rotate}: ${JSON.stringify({ box, drawn })}`).toBe(true);
          expect(iou(box, drawn)).toBeGreaterThan(0.5);
          expect(box.width > box.height).toBe(drawn.width > drawn.height);
        }
      });
    });
  }

  it("EmbedPDF's getPageTextRects is still off on a rotated page (drop the workaround when it is not)", async () => {
    await withDoc(fixture, async (doc) => {
      const page = doc.pages[1] as PdfPageObject;
      const img = await engine.renderPageRaw(doc, page, { scaleFactor: SCALE }).toPromise();
      const drawn = ink(img, window(90, "Saffron"));
      const rects = (await engine.getPageTextRects(doc, page).toPromise()) as PdfTextRectObject[];
      const theirs = rects.find((r) => r.content.startsWith("Saffron"));
      if (!drawn || !theirs) throw new Error("not found");
      const r = theirs.rect;
      expect(iou({ x: r.origin.x, y: r.origin.y, width: r.size.width, height: r.size.height }, drawn)).toBeLessThan(0.5);
    });
  });

  it("an OCR word lands where it was placed on a rotated page", async () => {
    const placed = { text: "Plover", x: 300, y: 400, width: 70, fontSize: 16 };
    await withDoc(fixture, async (doc) => {
      const page = doc.pages[1] as PdfPageObject;
      await text.setTextLayer(doc, page, [placed]);
      const run = textRun(doc, page, "Plover");
      // The word spans its width from x (glyph side bearings aside), its baseline at y.
      expect(Math.abs(run.x - placed.x), JSON.stringify(run)).toBeLessThan(3);
      expect(Math.abs(run.width - placed.width)).toBeLessThan(placed.width * 0.1);
      expect(run.y).toBeLessThan(placed.y);
      expect(run.y + run.height).toBeGreaterThan(placed.y);
      expect(run.height).toBeLessThan(placed.fontSize * 1.5);
    });
  });
});

/** Text of each page, by pdf.js. */
async function pagesText(bytes: ArrayBuffer): Promise<string[]> {
  return (await pdfjsText(new Uint8Array(bytes))).pages;
}

describe("redact and erase on rotated pages remove exactly the chosen word", () => {
  for (const [i, rotate] of ROTATED_PAGES.entries()) {
    for (const word of ["Saffron", ROTATED_WORDS.turned[0]]) {
      it(`/Rotate ${rotate}: ${word}`, async () => {
        const rect = await withDoc(fixture, (doc) => grow(textRun(doc, doc.pages[i] as PdfPageObject, word), 1));
        const others = WORDS.filter((w) => w !== word);

        const marked = await withDoc(fixture, async (doc) => {
          const page = doc.pages[i] as PdfPageObject;
          const mark = { id: `selis-redact-${nextId++}`, page: i, kind: "redact", rect, segments: [rect], fill: "black", text: "", color: "#000000", opacity: 1 } as const;
          await engine.createPageAnnotation(doc, page, toPdfAnnotation(mark)).toPromise();
          return (await engine.saveAsCopy(doc).toPromise()) as ArrayBuffer;
        });
        const redacted = await pagesText((await applyRedactions(engine, text, marked)).bytes);
        const erased = await pagesText((await eraseArea(engine, text, fixture, { page: i, rects: [rect], fill: "#ffffff" })).bytes);
        for (const [what, pages] of [
          ["redact", redacted],
          ["erase", erased],
        ] as const) {
          const page = pages[i] ?? "";
          expect(page, `${what} @${rotate}`).not.toContain(word);
          for (const kept of others) expect(page, `${what} @${rotate} keeps ${kept}`).toContain(kept);
          // The other pages are untouched.
          pages.forEach((p, k) => {
            if (k !== i) for (const w of WORDS) expect(p).toContain(w);
          });
        }
      });
    }
  }
});
