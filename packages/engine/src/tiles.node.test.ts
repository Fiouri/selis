/**
 * Tiles against whole-page renders with the real PDFium WASM: a tile must equal
 * the same pixels of the page rendered at the same scale, for every view rotation,
 * so tiles drawn side by side are indistinguishable from one sharp bitmap.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { PdfDocumentObject } from "@embedpdf/models";
import { init } from "@embedpdf/pdfium";
import { FIXTURES } from "@selis/fixtures";
import { crop, ssim } from "@selis/fixtures/ssim";
import { beforeAll, describe, expect, it } from "vitest";
import { type QuarterTurns, rotateSize } from "./geometry";
import { renderArea } from "./render-area";
import { visibleTiles } from "./tiles";

const require = createRequire(import.meta.url);
let engine: PdfiumNative;
let pdfium: Awaited<ReturnType<typeof init>>;

async function open(name: string): Promise<PdfDocumentObject> {
  const fixture = FIXTURES.find((f) => f.name === name);
  if (!fixture) throw new Error(`unknown fixture ${name}`);
  return engine.openDocumentBuffer({ id: `${name}-${Math.random()}`, content: fixture.build().slice().buffer }, {}).toPromise();
}

beforeAll(async () => {
  const wasm = readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
  const module = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
  pdfium = module;
  engine = new PdfiumNative(module, { fontFallback: null });
}, 60_000);

describe("tiles", () => {
  for (const turns of [0, 1, 2, 3] as QuarterTurns[]) {
    it(`show the same pixels as the whole-page render (rotation ${String(turns * 90)}°)`, async () => {
      const doc = await open("small-text");
      const page = doc.pages[0];
      if (!page) throw new Error("no page");
      const shown = rotateSize(page.size, turns);
      // 2.4 × fit-width on a 412 px Pixel 7 at DPR 2.625: a zoomed, tiled page.
      const deviceWidth = Math.round(396 * 2.4 * 2.625);
      const scale = deviceWidth / shown.width;
      const full = await renderArea(engine, pdfium, doc, page, scale, turns);
      expect(full.width).toBe(deviceWidth);
      const tiles = visibleTiles(full.width, full.height, { x: 700, y: 900, width: 1081, height: 1300 }, 0, 512);
      expect(tiles.length).toBeGreaterThan(4);
      // Tiles put side by side over the visible area, against the same area of the page.
      const view = { x: 700, y: 900, width: 1081, height: 1300 };
      const mosaic = new Uint8ClampedArray(full.data.length);
      for (const tile of tiles) {
        const part = await renderArea(engine, pdfium, doc, page, scale, turns, tile);
        expect([part.width, part.height]).toEqual([tile.width, tile.height]);
        for (let y = 0; y < tile.height; y++) {
          mosaic.set(part.data.subarray(y * tile.width * 4, (y + 1) * tile.width * 4), ((tile.y + y) * full.width + tile.x) * 4);
        }
      }
      const tiled = crop({ data: mosaic, width: full.width, height: full.height }, view.x, view.y, view.width, view.height);
      const whole = crop(full, view.x, view.y, view.width, view.height);
      expect(ssim(tiled, whole)).toBeGreaterThan(0.995);
      await engine.closeDocument(doc).toPromise();
    });
  }

  for (const name of ["acroform", "greek", "erase"]) {
    it(`draws ${name} like EmbedPDF's own render (annotations and form fields included)`, async () => {
      const doc = await open(name);
      const page = doc.pages[0];
      if (!page) throw new Error("no page");
      const scale = 2.5;
      const ours = await renderArea(engine, pdfium, doc, page, scale, 0);
      const theirs = await engine.renderPageRaw(doc, page, { scaleFactor: scale, dpr: 1, withAnnotations: true, withForms: true }).toPromise();
      expect([ours.width, ours.height]).toEqual([theirs.width, theirs.height]);
      expect(ssim(ours, theirs)).toBeGreaterThan(0.97);
      await engine.closeDocument(doc).toPromise();
    });
  }

  it("falls back to EmbedPDF's render when its internals are unreachable", async () => {
    const doc = await open("small-text");
    const page = doc.pages[0];
    if (!page) throw new Error("no page");
    const tile = { x: 512, y: 512, width: 300, height: 200 };
    const part = await renderArea(engine, null, doc, page, 3, 1, tile);
    expect([part.width, part.height]).toEqual([300, 200]);
    const whole = await renderArea(engine, null, doc, page, 3, 1);
    expect(ssim(part, crop(whole, 512, 512, 300, 200))).toBeGreaterThan(0.9);
    await engine.closeDocument(doc).toPromise();
  });
});
