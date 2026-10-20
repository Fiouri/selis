/**
 * Content erase (ADR 0033) through the real PDFium WASM, checked with an
 * independent reader (pdf.js, @selis/fixtures/oracle) and the bytes:
 * - the erased words are gone (PDFium and pdf.js extraction, raw and inflated bytes);
 * - the image pixels under the area are replaced in the image stream itself;
 * - vector paths are cut: nothing of them is drawn inside the area any more;
 * - outside the area the page renders as before (2 px margin), inside it is the fill.
 *   Straight edges and text are pixel-exact; a curve cut at the edge is split exactly
 *   (de Casteljau), but the rasteriser flattens the two halves a little differently
 *   from the whole, so its anti-aliased pixels may move by a few levels: a handful of
 *   pixels, never by more than MAX_AA_DIFF;
 * - objects shared with another page (image, form) stay whole there;
 * - a rotated, cropped page maps the area like the viewer draws it;
 * - "Delete object" removes exactly one object.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { PdfDocumentObject, PdfTextRectObject } from "@embedpdf/models";
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import { ERASE_IMAGE_SIZE, ERASE_TEXT, FIXTURES } from "@selis/fixtures";
import { findInFile, pdfjsRender, pdfjsText, qpdfCheck, type Raster } from "@selis/fixtures/oracle";
import { beforeAll, describe, expect, it } from "vitest";
import { EmbeddedText } from "./annotations";
import { apply, IDENTITY, type Matrix, multiply, operations, walk } from "./content-stream";
import { deletePageObject, EraseError, eraseArea, ringColor } from "./erase";
import type { PageRect } from "./geometry";
import { type Box, type Subpath } from "./path-clip";
import { bytesToLatin1, decodeStream, nameOf, type PdfDict, PdfDocumentObjects, type PdfObj } from "./pdf-objects";
import { documentPointer, fromUserSpace, pageObjects, toUserSpace } from "./pdfium-objects";

const require = createRequire(import.meta.url);
const FONT = new Uint8Array(readFileSync(new URL("../assets/SelisSans-LatinGreek.ttf", import.meta.url)));
const A4_HEIGHT = 841.89;
/** pdf.js renders at 2 px per point: the 2 px margin of the acceptance is 1 pt. */
const SCALE = 2;
const MARGIN_PT = 1;
/** Largest change allowed on an anti-aliased pixel of a split curve (of 255; measured: 65). */
const MAX_AA_DIFF = 80;
/** Share of the page's pixels that may show such a change. */
const AA_SHARE = 0.0002;

let pdf: WrappedPdfiumModule;
let engine: PdfiumNative;
let text: EmbeddedText;
let nextId = 0;
let fixture: ArrayBuffer;

beforeAll(async () => {
  const wasm = readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
  pdf = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
  engine = new PdfiumNative(pdf, { fontFallback: null });
  text = new EmbeddedText(engine, pdf, () => Promise.resolve(FONT));
  const f = FIXTURES.find((x) => x.name === "erase");
  if (!f) throw new Error("no erase fixture");
  fixture = f.build().slice().buffer;
}, 60_000);

async function withDoc<T>(bytes: ArrayBuffer, use: (doc: PdfDocumentObject) => T | Promise<T>): Promise<T> {
  const doc = await engine.openDocumentBuffer({ id: `er-${nextId++}`, content: bytes.slice(0) }).toPromise();
  try {
    return await use(doc);
  } finally {
    await engine.closeDocument(doc).toPromise();
  }
}

/** The rect (viewer coordinates) of the text runs that contain `needle`, as PDFium lays them out. */
async function textRect(bytes: ArrayBuffer, page: number, needle: string): Promise<PageRect> {
  return withDoc(bytes, async (doc) => {
    const p = doc.pages[page];
    if (!p) throw new Error("no page");
    const runs = (await engine.getPageTextRects(doc, p).toPromise()) as PdfTextRectObject[];
    // EmbedPDF's `content` can carry stray characters: read each run's text as the worker does.
    const boxes = runs.map((r) => ({ x: r.rect.origin.x, y: r.rect.origin.y, width: r.rect.size.width, height: r.rect.size.height }));
    const texts = text.boundedTexts(doc, p, boxes).map((t) => t.trim());
    const hits = runs.filter((_, i) => texts[i] !== "" && needle.includes(texts[i] ?? "\u0000"));
    if (hits.length === 0) throw new Error(`no run of ${needle}`);
    const x0 = Math.min(...hits.map((r) => r.rect.origin.x));
    const y0 = Math.min(...hits.map((r) => r.rect.origin.y));
    const x1 = Math.max(...hits.map((r) => r.rect.origin.x + r.rect.size.width));
    const y1 = Math.max(...hits.map((r) => r.rect.origin.y + r.rect.size.height));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  });
}

async function pdfiumText(bytes: ArrayBuffer, page: number): Promise<string> {
  return withDoc(bytes, async (doc) => {
    const p = doc.pages[page];
    if (!p) throw new Error("no page");
    const runs = (await engine.getPageTextRects(doc, p).toPromise()) as PdfTextRectObject[];
    return runs.map((r) => r.content).join(" ");
  });
}

const grow = (r: PageRect, by: number): PageRect => ({ x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by });
/** A rect from PDF user space (bottom-left origin) on an unrotated A4 page. */
const fromPdf = (x0: number, y0: number, x1: number, y1: number): PageRect => ({ x: x0, y: A4_HEIGHT - y1, width: x1 - x0, height: y1 - y0 });

/** Outside every rect (grown by the margin): pixels that differ by more than 8 levels, and the largest difference. */
function diffOutside(a: Raster, b: Raster, rects: readonly PageRect[]): { changed: number; max: number; share: number } {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  const near = rects.map((r) => grow(r, MARGIN_PT));
  let changed = 0;
  let max = 0;
  for (let py = 0; py < a.height; py++) {
    for (let px = 0; px < a.width; px++) {
      const x = (px + 0.5) / a.scale;
      const y = (py + 0.5) / a.scale;
      if (near.some((r) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height)) continue;
      const o = (py * a.width + px) * 4;
      const d = Math.max(...[0, 1, 2].map((c) => Math.abs((a.data[o + c] as number) - (b.data[o + c] as number))));
      max = Math.max(max, d);
      if (d > 8) changed++;
    }
  }
  return { changed, max, share: changed / (a.width * a.height) };
}

/** Renders the same outside the area: exact, or within the curve anti-aliasing budget. */
function sameOutside(a: Raster, b: Raster, rects: readonly PageRect[], curvesCut: boolean): void {
  const d = diffOutside(a, b, rects);
  if (!curvesCut) {
    expect(d.changed).toBe(0);
    return;
  }
  expect(d.max).toBeLessThanOrEqual(MAX_AA_DIFF);
  expect(d.share).toBeLessThanOrEqual(AA_SHARE);
}

/** Pixels strictly inside the rects (shrunk by the margin) that are not `rgb`. */
function offFill(img: Raster, rects: readonly PageRect[], rgb: readonly [number, number, number]): number {
  let n = 0;
  for (const r of rects.map((x) => grow(x, -MARGIN_PT))) {
    for (let py = Math.ceil(r.y * img.scale); py < Math.floor((r.y + r.height) * img.scale); py++) {
      for (let px = Math.ceil(r.x * img.scale); px < Math.floor((r.x + r.width) * img.scale); px++) {
        const o = (py * img.width + px) * 4;
        if (rgb.some((v, c) => Math.abs((img.data[o + c] as number) - v) > 2)) n++;
      }
    }
  }
  return n;
}

/** The page's painted paths (page space) with their line widths, forms included. */
async function paintedPaths(bytes: ArrayBuffer, pageIndex: number): Promise<{ subpaths: Subpath[]; stroke: boolean; fill: boolean; lineWidth: number; ctm: Matrix }[]> {
  const doc = await PdfDocumentObjects.parse(new Uint8Array(bytes));
  const page = doc.pages()[pageIndex];
  if (!page) throw new Error("no page");
  const out: { subpaths: Subpath[]; stroke: boolean; fill: boolean; lineWidth: number; ctm: Matrix }[] = [];
  const visit = async (content: string, resources: PdfDict | null, base: Matrix) => {
    const forms: { stream: Extract<PdfObj, { t: "stream" }>; ctm: Matrix }[] = [];
    walk(operations(content), base, {
      onPaint: (e) => {
        out.push({ subpaths: [...e.subpaths], stroke: /^[SsBb]/.test(e.op), fill: /^[fFBb]/.test(e.op), lineWidth: e.lineWidth, ctm: e.ctm });
      },
      onDo: (e) => {
        const x = doc.get(doc.dict(resources?.get("XObject"))?.get(e.name));
        if (x.t === "stream" && nameOf(x.dict.get("Subtype")) === "Form") {
          const m = doc.array(x.dict.get("Matrix"))?.map((v) => Number((doc.get(v) as { v: string }).v));
          forms.push({ stream: x, ctm: multiply((m && m.length === 6 ? m : IDENTITY) as unknown as Matrix, e.ctm) });
        }
      },
    });
    for (const f of forms) {
      const data = await decodeStream(f.stream);
      if (data) await visit(bytesToLatin1(data), doc.dict(f.stream.dict.get("Resources")) ?? resources, f.ctm);
    }
  };
  const contents = doc.get(page.dict.get("Contents"));
  const parts = contents.t === "arr" ? contents.v.map((x) => doc.get(x)) : [contents];
  let content = "";
  for (const part of parts) if (part.t === "stream") content += bytesToLatin1((await decodeStream(part)) ?? new Uint8Array()) + "\n";
  await visit(content, page.resources, IDENTITY);
  return out;
}

/** Every point a path is drawn through (end points, control points), in page space. */
function pointsOf(path: { subpaths: Subpath[]; ctm: Matrix }) {
  return path.subpaths.flatMap((sp) => [sp.start, ...sp.segs.flatMap((s) => (s.kind === "line" ? [s.to] : [s.c1, s.c2, s.to]))]).map((p) => apply(path.ctm, p));
}

/** The image XObject drawn on `pageIndex` and its decoded RGB samples. */
async function pageImage(bytes: ArrayBuffer, pageIndex: number): Promise<Uint8Array> {
  const doc = await PdfDocumentObjects.parse(new Uint8Array(bytes));
  const page = doc.pages()[pageIndex];
  const xobjects = doc.dict(page?.resources?.get("XObject"));
  for (const value of xobjects?.values() ?? []) {
    const x = doc.get(value);
    if (x.t !== "stream" || nameOf(x.dict.get("Subtype")) !== "Image") continue;
    const data = await decodeStream(x);
    if (!data) throw new Error(`image filter ${JSON.stringify(x.dict.get("Filter"))}`);
    return data;
  }
  throw new Error("no image on the page");
}

const pixel = (data: Uint8Array, col: number, row: number) => {
  const o = (row * ERASE_IMAGE_SIZE + col) * 3;
  return [data[o], data[o + 1], data[o + 2]];
};

describe("eraseArea", () => {
  let secret: PageRect;
  let rects: PageRect[];
  let erased: ArrayBuffer;
  const before = new Map<number, Raster>();

  beforeAll(async () => {
    secret = grow(await textRect(fixture, 0, ERASE_TEXT.secret), 3);
    rects = [
      secret,
      // The right of the blue rect and of the image, the start of the diagonal, the circle's left.
      fromPdf(200, 300, 420, 580),
      // The form's whole line (PDFium removes whole glyphs), and most of its green rect.
      fromPdf(300, 672, 450, 700),
      fromPdf(300, 625, 400, 668),
    ];
    for (const p of [0, 1]) before.set(p, await pdfjsRender(new Uint8Array(fixture), p, SCALE, false));
    const copy = fixture.slice(0);
    erased = (await eraseArea(engine, text, fixture, { page: 0, rects, fill: "#ffffff" })).bytes;
    expect(new Uint8Array(fixture)).toEqual(new Uint8Array(copy));
  });

  it("removes the erased words for PDFium and pdf.js, and from the bytes", async () => {
    const pdfium = await pdfiumText(erased, 0);
    const pdfjs = (await pdfjsText(new Uint8Array(erased))).pages[0] ?? "";
    for (const word of ["Wolfram", "Quartz", "Zebra", "Nimbus"]) {
      expect(pdfium).not.toContain(word);
      expect(pdfjs).not.toContain(word);
    }
    for (const kept of [ERASE_TEXT.title, ERASE_TEXT.above, ERASE_TEXT.below]) expect(pdfjs).toContain(kept);
    // Positive control first: the fixture has them, as hex glyph codes in the content.
    expect(findInFile(new Uint8Array(fixture), ["Wolfram", "Quartz"])).toEqual(["Wolfram", "Quartz"]);
    expect(findInFile(new Uint8Array(erased), ["Wolfram", "Quartz"])).toEqual([]);
    qpdfCheck(new Uint8Array(erased));
  });

  it("replaces the image pixels under the area in the image stream itself", async () => {
    const original = await pageImage(fixture, 0);
    const now = await pageImage(erased, 0);
    // The area spans x 200–420, y 300–580 in PDF space; the image is 56–256 × 240–440 at 2 px per point.
    const col = (x: number) => Math.round((x - 56) * 2);
    const row = (y: number) => Math.round((440 - y) * 2);
    for (const [c, r] of [
      [col(210), row(400)],
      [col(250), row(310)],
      [col(230), row(436)],
    ] as const) {
      expect(pixel(now, c, r), `${c},${r}`).toEqual([255, 255, 255]);
      expect(pixel(original, c, r)).not.toEqual([255, 255, 255]);
    }
    for (const [c, r] of [
      [col(60), row(400)],
      [col(190), row(310)],
      [col(230), row(250)],
    ] as const) {
      expect(pixel(now, c, r), `${c},${r}`).toEqual(pixel(original, c, r));
    }
  });

  it("cuts the vector paths: nothing of them is drawn inside the area", async () => {
    const boxes: Box[] = rects.map((r) => ({ x0: r.x, y0: A4_HEIGHT - r.y - r.height, x1: r.x + r.width, y1: A4_HEIGHT - r.y }));
    const paths = await paintedPaths(erased, 0);
    // The last path is the erase fill itself.
    const fill = paths.pop();
    expect(fill?.fill).toBe(true);
    let checked = 0;
    for (const path of paths) {
      const margin = path.stroke ? (path.lineWidth * Math.hypot(path.ctm[0], path.ctm[1])) / 2 + 1e-3 : 1e-3;
      for (const p of pointsOf(path)) {
        const inside = boxes.some((b) => p.x > b.x0 + margin && p.x < b.x1 - margin && p.y > b.y0 + margin && p.y < b.y1 - margin);
        expect(inside, `${p.x},${p.y}`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
    // The fixture did draw there before: the blue rect, the diagonal and the circle met the area.
    const original = await paintedPaths(fixture, 0);
    expect(original.some((path) => pointsOf(path).some((p) => boxes.some((b) => p.x > b.x0 + 2 && p.x < b.x1 - 2 && p.y > b.y0 + 2 && p.y < b.y1 - 2)))).toBe(true);
  });

  it("renders the same outside the area and the fill inside it", async () => {
    const after = await pdfjsRender(new Uint8Array(erased), 0, SCALE, false);
    sameOutside(before.get(0) as Raster, after, rects, true);
    expect(offFill(after, rects, [255, 255, 255])).toBe(0);
  });

  it("leaves the image and form shared with page 2 whole there", async () => {
    const after = await pdfjsRender(new Uint8Array(erased), 1, SCALE, false);
    sameOutside(before.get(1) as Raster, after, [], false);
    expect((await pdfjsText(new Uint8Array(erased))).pages[1]).toContain(ERASE_TEXT.form);
    expect(await pageImage(erased, 1)).toEqual(await pageImage(fixture, 1));
  });

  it("a second erase does not reuse a name an earlier one gave a copy", async () => {
    // First a corner of the image (its copy gets the first free name), then the form's green
    // rect: the form's copy must get another name, or the image draw would show the form.
    const corner = [fromPdf(56, 240, 90, 270)];
    const green = [fromPdf(400, 625, 440, 640)];
    const once = (await eraseArea(engine, text, fixture, { page: 0, rects: corner, fill: "#ffffff" })).bytes;
    const twice = (await eraseArea(engine, text, once, { page: 0, rects: green, fill: "#ffffff" })).bytes;
    const a = await pdfjsRender(new Uint8Array(once), 0, SCALE, false);
    const b = await pdfjsRender(new Uint8Array(twice), 0, SCALE, false);
    sameOutside(a, b, green, false);
    expect((await pdfjsText(new Uint8Array(twice))).pages[0]).toContain(ERASE_TEXT.form);
  });

  it("paints a chosen fill colour", async () => {
    const box = [fromPdf(60, 520, 120, 560)];
    const { bytes } = await eraseArea(engine, text, fixture, { page: 0, rects: box, fill: "#336699" });
    const img = await pdfjsRender(new Uint8Array(bytes), 0, SCALE, false);
    expect(offFill(img, box, [0x33, 0x66, 0x99])).toBe(0);
    sameOutside(before.get(0) as Raster, img, box, false);
  });

  it("maps the area on a rotated, cropped page as the viewer draws it", async () => {
    // EmbedPDF's text rects are not turned on a /Rotate page: place the area from the
    // line's PDF-space box (baseline 700, x 80, 12 pt Helvetica) like a finger would.
    const line = await withDoc(fixture, (doc) => {
      const page = doc.pages[2];
      if (!page) throw new Error("no page");
      const a = fromUserSpace(engine, doc, page, { x: 76, y: 695 });
      const b = fromUserSpace(engine, doc, page, { x: 215, y: 713 });
      return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
    });
    // Turned 90° clockwise: the line runs down the right of the page.
    expect(line.width).toBeLessThan(line.height);
    const area = [line];
    const { bytes } = await eraseArea(engine, text, fixture, { page: 2, rects: area, fill: "#ffffff" });
    const words = (await pdfjsText(new Uint8Array(bytes))).pages[2] ?? "";
    expect(words).not.toContain("Kestrel");
    expect(words).toContain(ERASE_TEXT.rotatedKeep);
    expect(await pdfiumText(bytes, 2)).not.toContain("Kestrel");
    // pdf.js draws the page turned and cropped like the viewer: compare in those coordinates.
    const was = await pdfjsRender(new Uint8Array(fixture), 2, SCALE, false);
    const now = await pdfjsRender(new Uint8Array(bytes), 2, SCALE, false);
    sameOutside(was, now, area, false);
    expect(offFill(now, area, [255, 255, 255])).toBe(0);
  });

  it("agrees with EmbedPDF on where a viewer point lands in PDF space", async () => {
    await withDoc(fixture, (doc) => {
      const page = doc.pages[0];
      if (!page) throw new Error("no page");
      const p = toUserSpace(engine, doc, page, { x: 56, y: A4_HEIGHT - 700 });
      expect(p.x).toBeCloseTo(56, 3);
      expect(p.y).toBeCloseTo(700, 3);
    });
  });

  it("refuses an empty area", async () => {
    await expect(eraseArea(engine, text, fixture, { page: 0, rects: [{ x: 10, y: 10, width: 0, height: 5 }], fill: "#ffffff" })).rejects.toBeInstanceOf(EraseError);
  });
});

describe("deletePageObject", () => {
  async function objectsOf(bytes: ArrayBuffer, page: number) {
    return withDoc(bytes, (doc) => {
      const p = doc.pages[page];
      const ptr = documentPointer(engine, doc.id);
      if (!p || ptr === null) throw new Error("no page");
      return pageObjects(engine, pdf, ptr, doc, p);
    });
  }

  it("removes exactly the picked object and keeps the rest", async () => {
    const objects = await objectsOf(fixture, 0);
    const kinds = new Set(objects.map((o) => o.kind));
    expect([...kinds].sort()).toEqual(["form", "image", "path", "text"]);
    // The red diagonal: a path from x 300 to 540.
    const diagonal = objects.find((o) => o.kind === "path" && o.rect.x > 290 && o.rect.x < 302 && o.rect.width > 230);
    if (!diagonal) throw new Error("no diagonal");
    const bytes = await deletePageObject(engine, pdf, text, fixture, 0, diagonal);
    const after = await objectsOf(bytes, 0);
    expect(after).toHaveLength(objects.length - 1);
    const rest = objects.filter((o) => o !== diagonal);
    after.forEach((o, i) => {
      const was = rest[i];
      expect(o.kind).toBe(was?.kind);
      for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(o.rect[k] - (was?.rect[k] ?? 0))).toBeLessThan(0.5);
    });
    const was = await pdfjsRender(new Uint8Array(fixture), 0, SCALE, false);
    const now = await pdfjsRender(new Uint8Array(bytes), 0, SCALE, false);
    sameOutside(was, now, [grow(diagonal.rect, 2)], false);
    qpdfCheck(new Uint8Array(bytes));
  });

  it("removes a text run from the file", async () => {
    const objects = await objectsOf(fixture, 0);
    const line = await textRect(fixture, 0, ERASE_TEXT.secret);
    const run = objects.find((o) => o.kind === "text" && Math.abs(o.rect.y - line.y) < 3);
    if (!run) throw new Error("no text object");
    const bytes = await deletePageObject(engine, pdf, text, fixture, 0, run);
    expect((await pdfjsText(new Uint8Array(bytes))).pages[0]).not.toContain("Wolfram");
    expect(findInFile(new Uint8Array(bytes), ["Wolfram"])).toEqual([]);
    expect(await objectsOf(bytes, 0)).toHaveLength(objects.length - 1);
  });

  it("refuses an object that is no longer where it was picked", async () => {
    const [first] = await objectsOf(fixture, 0);
    if (!first) throw new Error("no objects");
    await expect(deletePageObject(engine, pdf, text, fixture, 0, { ...first, rect: { ...first.rect, x: first.rect.x + 40 } })).rejects.toBeInstanceOf(EraseError);
  });
});

describe("ringColor", () => {
  it("takes the median around the rects, not inside them", () => {
    const width = 40;
    const height = 40;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        const inside = x >= 10 && x < 30 && y >= 10 && y < 30;
        const speck = x === 8 && y === 8;
        data.set(inside ? [0, 0, 0, 255] : speck ? [255, 0, 0, 255] : [240, 230, 200, 255], o);
      }
    }
    expect(ringColor(data, width, height, 1, [{ x: 10, y: 10, width: 20, height: 20 }], 4)).toBe("#f0e6c8");
    // A zero-size rect samples the spot itself (the eyedropper).
    expect(ringColor(data, width, height, 1, [{ x: 20, y: 20, width: 0, height: 0 }], 1.5)).toBe("#000000");
  });
});
