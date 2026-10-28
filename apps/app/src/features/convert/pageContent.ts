/**
 * One page of the open document for "Export as Word / text" (ADR 0035): its styled text runs
 * and image placements from the engine; a page without text of its own (a scan) is read by
 * OCR first (the P4d Tesseract path) and its words become runs. Images are cut from the page
 * render at the export resolution, as PNG.
 */
import type { DocHandle } from "@selis/engine";
import { appOcrPaths, createOcr, layoutWords, type Ocr } from "@selis/ocr";
import { simdSupported } from "@selis/scan";
import { MIN_TEXT_CHARS, OCR_DPI, OCR_MAX_PIXELS, OCR_MAX_SIDE, useOcr } from "../ocr/ocrStore";

type StyledRun = { x: number; y: number; width: number; height: number; text: string; fontSize: number; bold: boolean; italic: boolean };
type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

export type PageForExport = {
  readonly page: { width: number; height: number; runs: StyledRun[]; images: Rect[] };
  /** The page's images as PNG at `dpi`, by their index in `page.images`. */
  images: (dpi: number) => Array<[number, Promise<{ type: "png"; data: Uint8Array }>]>;
};

let reader: Ocr | null = null;

/** Lets the OCR worker go (call when an export ends). */
export function releaseExportOcr(): void {
  const current = reader;
  reader = null;
  void current?.terminate().catch(() => undefined);
}

async function ocrRuns(doc: DocHandle, index: number): Promise<StyledRun[]> {
  const size = doc.pages[index];
  if (!size) return [];
  reader ??= await createOcr(useOcr.getState().languages, appOcrPaths(new URL("ocr/", document.baseURI).href, simdSupported()));
  const image = await doc.renderPageGray(index, { dpi: OCR_DPI, maxPixels: OCR_MAX_PIXELS, maxSide: OCR_MAX_SIDE });
  const read = await reader.recognize(new Uint8Array(image.bytes), (image.width / size.width) * 72);
  // Words on one baseline become one run each; the structure step joins them into lines.
  return layoutWords(read, size.width, size.height).map((w) => ({
    x: w.x,
    y: w.y - w.fontSize * 0.8,
    width: w.width,
    height: w.fontSize,
    text: w.text,
    fontSize: w.fontSize,
    bold: false,
    italic: false,
  }));
}

async function cropPng(doc: DocHandle, index: number, rect: Rect, dpi: number): Promise<{ type: "png"; data: Uint8Array }> {
  const scale = dpi / 72;
  const size = doc.pages[index];
  const pageWidth = Math.round((size?.width ?? 0) * scale);
  const pageHeight = Math.round((size?.height ?? 0) * scale);
  const x = Math.max(0, Math.floor(rect.x * scale));
  const y = Math.max(0, Math.floor(rect.y * scale));
  const width = Math.max(1, Math.min(pageWidth - x, Math.ceil(rect.width * scale)));
  const height = Math.max(1, Math.min(pageHeight - y, Math.ceil(rect.height * scale)));
  const image = await doc.renderPageImage(index, scale, { rect: { x, y, width, height } });
  const canvas = new OffscreenCanvas(image.width, image.height);
  // Software canvas: one small image does not need a GPU context.
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("no 2d context for an export image");
  context.putImageData(image, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { type: "png", data: new Uint8Array(await blob.arrayBuffer()) };
}

export async function readPageContent(doc: DocHandle, index: number): Promise<PageForExport> {
  const size = doc.pages[index] ?? { width: 595.28, height: 841.89 };
  const content = await doc.pageContent(index);
  let runs: StyledRun[] = content.runs.map((r) => ({ ...r }));
  const chars = runs.reduce((n, r) => n + r.text.trim().length, 0);
  if (chars < MIN_TEXT_CHARS) {
    const info = await doc.pageTextInfo(index);
    // A scan (no text of its own, or only Selis' OCR layer): read it.
    if (info.chars < MIN_TEXT_CHARS && (content.images.length > 0 || info.ocr)) runs = await ocrRuns(doc, index);
  }
  // A scanned page's single full-page image is the text that was just read: not repeated.
  const scanned = runs.length > 0 && chars < MIN_TEXT_CHARS;
  const images = scanned ? [] : content.images.map((r) => ({ ...r }));
  return {
    page: { width: size.width, height: size.height, runs, images },
    images: (dpi) => images.map((rect, i) => [i, cropPng(doc, index, rect, dpi)]),
  };
}
