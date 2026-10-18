/**
 * Images → PDF (P4b) with the real PDFium WASM, checked by pdf.js and qpdf (@selis/fixtures/oracle):
 * metadata never reaches the PDF, JPEG data goes in unchanged, every EXIF orientation shows the
 * right way up, page sizes, and 20 phone photos in one document.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";
import { makePhoto, PHOTO_QUADRANTS, PHOTO_SECRETS } from "@selis/fixtures";
import { checkSample, findInFile, pdfjsImagePlacements, pdfjsPageCount, pdfjsRender, type Raster } from "@selis/fixtures/oracle";
import { beforeAll, describe, expect, it } from "vitest";
import { A4_EXACT, idCardSheet, ImageFormatError, ImagePdfBuilder, imageMatrix, inspectJpeg, orientedSize, pageLayout } from "./images";

const require = createRequire(import.meta.url);
let pdf: WrappedPdfiumModule;
let engine: PdfiumNative;

beforeAll(async () => {
  const wasm = readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
  pdf = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
  engine = new PdfiumNative(pdf, { fontFallback: null });
}, 60_000);

const ab = (u: Uint8Array): ArrayBuffer => u.slice().buffer;

async function build(images: Uint8Array[], size: "fit" | "a4" | "letter" = "fit"): Promise<Uint8Array> {
  const builder = await ImagePdfBuilder.create(engine, pdf);
  for (const image of images) builder.add({ kind: "jpeg", bytes: ab(image) }, size);
  return new Uint8Array(await builder.finish());
}

/** Colour at a fraction of the rendered page. */
function at(img: Raster, fx: number, fy: number): [number, number, number] {
  const x = Math.min(img.width - 1, Math.floor(img.width * fx));
  const y = Math.min(img.height - 1, Math.floor(img.height * fy));
  const i = (y * img.width + x) * 4;
  return [img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0];
}

const near = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - (b[i] ?? 0)) < 40);

/** Where each stored quadrant shows for an EXIF orientation (display = what a phone shows). */
function expectedQuadrants(orientation: number): Record<"tl" | "tr" | "bl" | "br", readonly number[]> {
  const q = PHOTO_QUADRANTS;
  // Stored quadrant centres in a 1×1 image (x right, y down) and their colours.
  const stored: Array<[number, number, readonly number[]]> = [
    [0.25, 0.25, q.topLeft],
    [0.75, 0.25, q.topRight],
    [0.25, 0.75, q.bottomLeft],
    [0.75, 0.75, q.bottomRight],
  ];
  const out: Record<"tl" | "tr" | "bl" | "br", readonly number[]> = { tl: [], tr: [], bl: [], br: [] };
  for (const [x, y, colour] of stored) {
    // Same table as images.ts `display`, for a unit image.
    const [dx, dy] = (
      {
        1: [x, y],
        2: [1 - x, y],
        3: [1 - x, 1 - y],
        4: [x, 1 - y],
        5: [y, x],
        6: [1 - y, x],
        7: [1 - y, 1 - x],
        8: [y, 1 - x],
      } as Record<number, [number, number]>
    )[orientation] ?? [x, y];
    out[`${dy < 0.5 ? "t" : "b"}${dx < 0.5 ? "l" : "r"}`] = colour;
  }
  return out;
}

describe("JPEG metadata", () => {
  it("reads size and orientation and removes EXIF, GPS, XMP, IPTC and comments", async () => {
    const photo = await makePhoto({ width: 120, height: 80, orientation: 6, extras: true });
    for (const secret of PHOTO_SECRETS) expect(Buffer.from(photo).includes(secret)).toBe(true);
    const info = inspectJpeg(photo);
    expect(info).toMatchObject({ width: 120, height: 80, components: 3, orientation: 6 });
    const stripped = Buffer.from(info.stripped);
    for (const secret of PHOTO_SECRETS) expect(stripped.includes(secret)).toBe(false);
    expect(stripped.includes("Exif")).toBe(false);
    expect(stripped.includes("http://ns.adobe.com/xap")).toBe(false);
    // Still a complete JPEG.
    expect([...stripped.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...stripped.subarray(-2)]).toEqual([0xff, 0xd9]);
  });

  it("drops what follows the first EOI (multi-picture previews)", async () => {
    const photo = await makePhoto({ width: 40, height: 40, orientation: 1 });
    const appended = Buffer.concat([Buffer.from(photo), Buffer.from(`\xff\xd8 MPF preview ${PHOTO_SECRETS[0]} \xff\xd9`, "latin1")]);
    const info = inspectJpeg(new Uint8Array(appended));
    expect(Buffer.from(info.stripped).includes(PHOTO_SECRETS[0])).toBe(false);
    expect(info.stripped.length).toBeLessThan(photo.length);
  });

  it("refuses what is not a JPEG", () => {
    expect(() => inspectJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(ImageFormatError);
    expect(() => inspectJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toThrow(ImageFormatError);
  });
});

describe("layout", () => {
  it("swaps width and height for orientations 5–8", () => {
    expect(orientedSize(400, 300, 1)).toEqual({ width: 400, height: 300 });
    expect(orientedSize(400, 300, 6)).toEqual({ width: 300, height: 400 });
  });

  it("fits pages: long side 842 pt, or A4 / Letter by orientation with a margin", () => {
    expect(pageLayout(4000, 3000, "fit")).toMatchObject({ width: 842, height: 631.5 });
    const a4 = pageLayout(3000, 4000, "a4");
    expect([a4.width, a4.height]).toEqual([595, 842]);
    expect(a4.box.x).toBeGreaterThanOrEqual(24);
    const letter = pageLayout(4000, 3000, "letter");
    expect([letter.width, letter.height]).toEqual([792, 612]);
  });

  it("orientation 1 is a plain scale-and-move", () => {
    expect(imageMatrix(1, 4, 2, { x: 10, y: 20, width: 40, height: 20 })).toEqual([40, 0, 0, 20, 10, 20]);
  });
});

describe("images → PDF", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("orientation %i shows the right way up (pdf.js)", async (orientation) => {
    const photo = await makePhoto({ width: 160, height: 80, orientation });
    const bytes = await build([photo]);
    await checkSample(`orientation-${String(orientation)}.pdf`, bytes);
    const img = await pdfjsRender(bytes, 0, 1);
    // Display proportions: 2:1 for 1–4, 1:2 for 5–8.
    if (orientation >= 5) expect(img.height).toBeGreaterThan(img.width);
    else expect(img.width).toBeGreaterThan(img.height);
    const want = expectedQuadrants(orientation);
    expect(near(at(img, 0.25, 0.25), want.tl)).toBe(true);
    expect(near(at(img, 0.75, 0.25), want.tr)).toBe(true);
    expect(near(at(img, 0.25, 0.75), want.bl)).toBe(true);
    expect(near(at(img, 0.75, 0.75), want.br)).toBe(true);
  });

  it("embeds the JPEG data unchanged (no re-encoding)", async () => {
    const photo = await makePhoto({ width: 200, height: 120, orientation: 1, extras: true });
    const bytes = await build([photo]);
    const stripped = Buffer.from(inspectJpeg(photo).stripped);
    // The entropy-coded data (after SOS) is in the PDF byte for byte.
    const sos = stripped.indexOf(Buffer.from([0xff, 0xda]));
    expect(Buffer.from(bytes).includes(stripped.subarray(sos))).toBe(true);
  });

  it("20 phone photos → one PDF with no metadata, every page the right way up", async () => {
    const photos = await Promise.all(
      Array.from({ length: 20 }, (_, i) => makePhoto({ width: 120 + i * 4, height: 90, orientation: (i % 8) + 1, extras: true })),
    );
    const bytes = await build(photos, "a4");
    await checkSample("twenty-photos.pdf", bytes);
    expect(await pdfjsPageCount(bytes)).toBe(20);
    // No metadata anywhere in the file, raw or inflated.
    expect(findInFile(bytes, [...PHOTO_SECRETS, "Exif", "GPS", "ns.adobe.com/xap"])).toEqual([]);
    for (const page of [0, 5, 7]) {
      const img = await pdfjsRender(bytes, page, 0.5);
      const want = expectedQuadrants((page % 8) + 1);
      // A4 with margins: sample well inside the image box.
      const box = (fx: number, fy: number) => at(img, 0.5 + (fx - 0.5) * 0.5, 0.5 + (fy - 0.5) * 0.3);
      expect(near(box(0.25, 0.25), want.tl)).toBe(true);
      expect(near(box(0.75, 0.75), want.br)).toBe(true);
    }
  });

  it("decoded pixels go in on white (transparency flattened)", async () => {
    const width = 4;
    const height = 2;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) data.set(i < width ? [255, 0, 0, 255] : [0, 0, 255, 0], i * 4);
    const builder = await ImagePdfBuilder.create(engine, pdf);
    builder.add({ kind: "rgba", width, height, data: data.buffer }, "fit");
    const bytes = new Uint8Array(await builder.finish());
    await checkSample("pixels.pdf", bytes);
    const img = await pdfjsRender(bytes, 0, 0.5);
    expect(near(at(img, 0.5, 0.25), [255, 0, 0])).toBe(true);
    // The transparent half is white, not black.
    expect(near(at(img, 0.5, 0.75), [255, 255, 255])).toBe(true);
  });

  it("a bad image leaves the builder usable", async () => {
    const builder = await ImagePdfBuilder.create(engine, pdf);
    expect(() => builder.add({ kind: "jpeg", bytes: new Uint8Array([1, 2, 3]).buffer }, "fit")).toThrow(ImageFormatError);
    builder.add({ kind: "jpeg", bytes: ab(await makePhoto({ width: 40, height: 40, orientation: 1 })) }, "fit");
    expect(builder.pageCount).toBe(1);
    const bytes = new Uint8Array(await builder.finish());
    expect(await pdfjsPageCount(bytes)).toBe(1);
  });

  it("an ID card sheet: A4 with both sides at 85.6 × 54 mm, centred one above the other", async () => {
    const front = await makePhoto({ width: 856, height: 540, orientation: 1 });
    const back = await makePhoto({ width: 856, height: 540, orientation: 6 });
    const sheet = idCardSheet([
      { width: 856, height: 540 },
      { width: 856, height: 540 },
    ]);
    const builder = await ImagePdfBuilder.create(engine, pdf);
    builder.addSheet(sheet.width, sheet.height, [
      { input: { kind: "jpeg", bytes: ab(front) }, box: sheet.boxes[0]! },
      { input: { kind: "jpeg", bytes: ab(back) }, box: sheet.boxes[1]! },
    ]);
    const bytes = new Uint8Array(await builder.finish());
    await checkSample("idcard.pdf", bytes);
    expect(await pdfjsPageCount(bytes)).toBe(1);
    // As pdf.js reads the drawing: exactly the ID-1 boxes.
    const placed = await pdfjsImagePlacements(bytes, 0);
    expect(placed.images).toHaveLength(2);
    placed.images.forEach((box, i) => {
      expect(box.width).toBeCloseTo(sheet.boxes[i]!.width, 2);
      expect(box.height).toBeCloseTo(sheet.boxes[i]!.height, 2);
      expect(box.y).toBeCloseTo(sheet.boxes[i]!.y, 2);
    });
    const img = await pdfjsRender(bytes, 0, 2);
    const mm = (pt: number) => (pt * 25.4) / 72;
    expect(mm(img.width / img.scale)).toBeCloseTo(210, 0);
    expect(mm(img.height / img.scale)).toBeCloseTo(297, 0);
    // The non-white extent of each half of the page is one side.
    const extent = (fromY: number, toY: number) => {
      let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
      for (let y = Math.round(fromY * img.height); y < Math.round(toY * img.height); y++) {
        for (let x = 0; x < img.width; x++) {
          const o = (y * img.width + x) * 4;
          if ((img.data[o] ?? 255) < 235 || (img.data[o + 1] ?? 255) < 235 || (img.data[o + 2] ?? 255) < 235) {
            x0 = Math.min(x0, x);
            x1 = Math.max(x1, x);
            y0 = Math.min(y0, y);
            y1 = Math.max(y1, y);
          }
        }
      }
      return { x: mm(x0 / img.scale), y: mm(y0 / img.scale), w: mm((x1 + 1 - x0) / img.scale), h: mm((y1 + 1 - y0) / img.scale) };
    };
    const top = extent(0, 0.5);
    const bottom = extent(0.5, 1);
    for (const side of [top, bottom]) {
      expect(Math.abs(side.w - 85.6)).toBeLessThanOrEqual(1);
      expect(Math.abs(side.h - 54)).toBeLessThanOrEqual(1);
      // Centred across the page.
      expect(Math.abs(side.x + side.w / 2 - 105)).toBeLessThanOrEqual(1);
    }
    // Centred as a pair, 10 mm apart.
    expect(Math.abs(bottom.y - (top.y + top.h) - 10)).toBeLessThanOrEqual(1);
    expect(Math.abs((top.y + bottom.y + bottom.h) / 2 - 148.5)).toBeLessThanOrEqual(1);
  });

  it("an ID card side taller than wide gets an upright ID-1 box", () => {
    const sheet = idCardSheet([
      { width: 540, height: 856 },
      { width: 856, height: 540 },
    ]);
    expect(sheet.width).toBeCloseTo(A4_EXACT.width, 3);
    expect(sheet.boxes[0]!.width).toBeCloseTo((54 * 72) / 25.4, 3);
    expect(sheet.boxes[0]!.height).toBeCloseTo((85.6 * 72) / 25.4, 3);
    expect(sheet.boxes[0]!.y).toBeGreaterThan(sheet.boxes[1]!.y);
  });
});
