/**
 * An independent PDF oracle for tests: pdf.js (Mozilla's reader, not PDFium,
 * which writes the files under test) extracts text, lists annotations and
 * renders pages; a raw scan inflates every Flate stream and searches the bytes.
 * Redaction tests check the produced file with this, never the engine's own
 * view of it (ADR 0009).
 *
 * Coordinates are PDF points with a top-left origin (as the editor uses).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { AnnotationMode, getDocument, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

export type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
export type TextItem = Box & { readonly page: number; readonly str: string };
export type OracleAnnotation = { readonly page: number; readonly subtype: string; readonly rect: Box; readonly contents: string };
export type Raster = { readonly width: number; readonly height: number; readonly scale: number; readonly data: Uint8ClampedArray };

const require = createRequire(import.meta.url);
const PDFJS_DIR = dirname(require.resolve("pdfjs-dist/package.json"));
const asset = (dir: string) => `${pathToFileURL(join(PDFJS_DIR, dir)).href}/`;

async function withDocument<T>(bytes: Uint8Array, use: (doc: PDFDocumentProxy) => Promise<T>): Promise<T> {
  const task = getDocument({
    data: bytes.slice(),
    verbosity: 0,
    standardFontDataUrl: asset("standard_fonts"),
    cMapUrl: asset("cmaps"),
    wasmUrl: asset("wasm"),
  });
  try {
    return await use(await task.promise);
  } finally {
    await task.destroy();
  }
}

/** Text of every page as pdf.js extracts it: one string per page, and the positioned items. */
export async function pdfjsText(bytes: Uint8Array): Promise<{ pages: string[]; items: TextItem[] }> {
  return withDocument(bytes, async (doc) => {
    const pages: string[] = [];
    const items: TextItem[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const top = page.view[3] ?? 0;
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str + (item.hasEOL ? "\n" : "");
        if (item.str.trim() === "") continue;
        const [, , , , x = 0, baseline = 0] = item.transform as number[];
        items.push({ page: n - 1, str: item.str, x, y: top - baseline - item.height, width: item.width, height: item.height });
      }
      pages.push(text);
    }
    return { pages, items };
  });
}

/** Annotations as pdf.js reads them (subtype, top-left rect, /Contents). */
export async function pdfjsAnnotations(bytes: Uint8Array): Promise<OracleAnnotation[]> {
  return withDocument(bytes, async (doc) => {
    const out: OracleAnnotation[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const top = page.view[3] ?? 0;
      const annots = (await page.getAnnotations()) as Array<{ subtype: string; rect: number[]; contentsObj?: { str?: string } }>;
      for (const a of annots) {
        const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = a.rect;
        out.push({
          page: n - 1,
          subtype: a.subtype,
          rect: { x: x0, y: top - y1, width: x1 - x0, height: y1 - y0 },
          contents: a.contentsObj?.str ?? "",
        });
      }
    }
    return out;
  });
}

type CanvasAndContext = {
  canvas: unknown;
  context: { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } };
};

/** Renders one page with pdf.js; `annotations: false` draws the page content only. */
export async function pdfjsRender(bytes: Uint8Array, pageIndex: number, scale: number, annotations = true): Promise<Raster> {
  return withDocument(bytes, async (doc) => {
    const page = await doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    const factory = doc.canvasFactory as { create(w: number, h: number): CanvasAndContext };
    const { canvas, context } = factory.create(width, height);
    // pdf.js's own Node canvas (@napi-rs/canvas) stands in for the DOM types it declares.
    const params = { canvas, canvasContext: context, viewport, annotationMode: annotations ? AnnotationMode.ENABLE : AnnotationMode.DISABLE };
    await page.render(params as unknown as Parameters<PDFPageProxy["render"]>[0]).promise;
    return { width, height, scale, data: context.getImageData(0, 0, width, height).data };
  });
}

/** Pixels in `area` (points) for which `test(r, g, b)` holds. */
export function countPixels(img: Raster, area: Box, test: (r: number, g: number, b: number) => boolean): number {
  const x0 = Math.max(0, Math.floor(area.x * img.scale));
  const y0 = Math.max(0, Math.floor(area.y * img.scale));
  const x1 = Math.min(img.width, Math.ceil((area.x + area.width) * img.scale));
  const y1 = Math.min(img.height, Math.ceil((area.y + area.height) * img.scale));
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * img.width + x) * 4;
      if (test(img.data[o] ?? 0, img.data[o + 1] ?? 0, img.data[o + 2] ?? 0)) n++;
    }
  }
  return n;
}

export const isDark = (r: number, g: number, b: number): boolean => r < 80 && g < 80 && b < 80;

/**
 * The box (points) of a solid filled rectangle inside `within`: the rows where
 * more than half of the pixels pass `test`, then the columns filled on nearly
 * all of those rows. Text glyphs never fill half a row, so they do not count.
 * Null if none.
 */
export function solidBox(img: Raster, within: Box, test: (r: number, g: number, b: number) => boolean): Box | null {
  const x0 = Math.max(0, Math.floor(within.x * img.scale));
  const y0 = Math.max(0, Math.floor(within.y * img.scale));
  const x1 = Math.min(img.width, Math.ceil((within.x + within.width) * img.scale));
  const y1 = Math.min(img.height, Math.ceil((within.y + within.height) * img.scale));
  const hit = (x: number, y: number) => {
    const o = (y * img.width + x) * 4;
    return test(img.data[o] ?? 0, img.data[o + 1] ?? 0, img.data[o + 2] ?? 0);
  };
  const rows: number[] = [];
  for (let y = y0; y < y1; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) if (hit(x, y)) n++;
    if (n * 2 > x1 - x0) rows.push(y);
  }
  // Columns of the box: filled on (nearly) all of those rows.
  const cols: number[] = [];
  for (let x = x0; x < x1; x++) {
    let n = 0;
    for (const y of rows) if (hit(x, y)) n++;
    if (rows.length > 0 && n >= rows.length * 0.9) cols.push(x);
  }
  const top = rows[0];
  const bottom = rows.at(-1);
  const left = cols[0];
  const right = cols.at(-1);
  if (top === undefined || bottom === undefined || left === undefined || right === undefined) return null;
  return { x: left / img.scale, y: top / img.scale, width: (right + 1 - left) / img.scale, height: (bottom + 1 - top) / img.scale };
}

/** Largest difference between two boxes' edges, in points. */
export function boxDistance(a: Box, b: Box): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.x + a.width - (b.x + b.width)),
    Math.abs(a.y + a.height - (b.y + b.height)),
  );
}

export const intersects = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The file as latin1 text plus every stream body inflated where it is Flate (object streams included). */
export function rawAndInflated(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
      // Not Flate data (or the "stream" of "endstream"): nothing to inflate.
    }
    at = end + 9;
  }
  return parts.join("\n");
}

/** How a string can appear in a PDF's bytes: UTF-8 (XMP, names), UTF-16BE (text strings), latin1. */
function encodings(s: string): string[] {
  const utf16 = Buffer.alloc(s.length * 2);
  for (let i = 0; i < s.length; i++) utf16.writeUInt16BE(s.charCodeAt(i), i * 2);
  const hex16 = utf16.toString("hex");
  return [Buffer.from(s, "utf8").toString("latin1"), utf16.toString("latin1"), hex16, hex16.toUpperCase(), s];
}

/**
 * Every place a needle survives in the file, raw or inflated: as text (UTF-8,
 * UTF-16BE literal or hex) or as glyph codes (`glyphHex`, hex of the codes
 * the content stream shows the string with). Empty when the file is clean.
 */
export function findInFile(bytes: Uint8Array, needles: readonly string[], glyphHex: readonly string[] = []): string[] {
  const hay = rawAndInflated(bytes);
  const lower = hay.toLowerCase();
  const found: string[] = [];
  for (const needle of needles) {
    if (encodings(needle).some((e) => e.length > 0 && hay.includes(e))) found.push(needle);
  }
  for (const hex of glyphHex) if (lower.includes(hex.toLowerCase())) found.push(`glyphs <${hex}>`);
  return found;
}
