/**
 * Images → PDF (P4b, ADR 0017), worker side.
 *
 * - JPEG goes in as it is (no re-encoding: PDFium embeds the DCT data), after removing every
 *   metadata segment — EXIF (camera, date, GPS), XMP, IPTC, comments, maker notes — and anything
 *   after the first EOI (multi-picture files append previews and depth maps there). The colour
 *   profile (APP2 ICC_PROFILE) and the Adobe/JFIF markers that decoding needs stay.
 * - The EXIF orientation is applied by the image's placement matrix (rotation / mirror), so the
 *   pixels are not touched.
 * - Other formats arrive decoded (RGBA, already oriented by the browser) and are embedded as a
 *   lossless bitmap on white (transparency flattened).
 * - Page size: "fit" = the image's proportions with the long side 842 pt (A4 height), no margin;
 *   "a4" / "letter" = that paper, portrait or landscape like the image, image fitted inside a
 *   24 pt margin and centred.
 */
import type { PdfiumNative } from "@embedpdf/engines/pdfium";
import type { PdfDocumentObject } from "@embedpdf/models";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";

export type PageSizeOption = "fit" | "a4" | "letter";

export type ImageInput =
  | { readonly kind: "jpeg"; readonly bytes: ArrayBuffer }
  /** Decoded pixels (RGBA, row by row), already in display orientation. */
  | { readonly kind: "rgba"; readonly width: number; readonly height: number; readonly data: ArrayBuffer };

export type JpegInfo = {
  readonly width: number;
  readonly height: number;
  /** Colour components (1 grey, 3 YCbCr/RGB, 4 CMYK). */
  readonly components: number;
  /** EXIF orientation 1–8 (1 when absent or invalid). */
  readonly orientation: number;
  /** The JPEG without metadata segments and without anything after its first EOI. */
  readonly stripped: Uint8Array;
};

export class ImageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageFormatError";
  }
}

/** Segments kept: APP0 (JFIF), APP2 only for ICC_PROFILE, APP14 (Adobe: colour transform). */
function keepSegment(marker: number, data: Uint8Array): boolean {
  if (marker === 0xe0 || marker === 0xee) return true;
  if (marker === 0xe2) return new TextDecoder("latin1").decode(data.subarray(0, 12)) === "ICC_PROFILE\0";
  // Every other APPn (EXIF, XMP, IPTC, maker data, MPF) and comments go.
  return !((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe);
}

function readOrientation(tiff: Uint8Array): number {
  if (tiff.length < 8) return 1;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!le && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return 1;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const ifd0 = view.getUint32(4, le);
  if (ifd0 + 2 > tiff.length) return 1;
  const count = view.getUint16(ifd0, le);
  for (let i = 0; i < count; i++) {
    const at = ifd0 + 2 + i * 12;
    if (at + 12 > tiff.length) return 1;
    if (view.getUint16(at, le) === 0x0112) {
      const value = view.getUint16(at + 8, le);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** Reads a JPEG's size and orientation and removes its metadata. Throws `ImageFormatError`. */
export function inspectJpeg(bytes: Uint8Array): JpegInfo {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new ImageFormatError("not a JPEG");
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let pos = 2;
  let orientation = 1;
  let width = 0;
  let height = 0;
  let components = 0;
  for (;;) {
    // Fill bytes (0xFF) may pad between segments.
    while (pos < bytes.length && bytes[pos] === 0xff && bytes[pos + 1] === 0xff) pos++;
    if (pos + 4 > bytes.length || bytes[pos] !== 0xff) throw new ImageFormatError("truncated JPEG");
    const marker = bytes[pos + 1] ?? 0;
    if (marker === 0xd9) throw new ImageFormatError("JPEG without image data");
    const length = ((bytes[pos + 2] ?? 0) << 8) | (bytes[pos + 3] ?? 0);
    const end = pos + 2 + length;
    if (length < 2 || end > bytes.length) throw new ImageFormatError("truncated JPEG");
    const data = bytes.subarray(pos + 4, end);
    if (marker === 0xe1 && new TextDecoder("latin1").decode(data.subarray(0, 6)) === "Exif\0\0") {
      orientation = readOrientation(data.subarray(6));
    }
    // SOF0–SOF15 except DHT (C4), JPG (C8), DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (data.length < 6) throw new ImageFormatError("truncated JPEG");
      height = ((data[1] ?? 0) << 8) | (data[2] ?? 0);
      width = ((data[3] ?? 0) << 8) | (data[4] ?? 0);
      components = data[5] ?? 0;
    }
    if (keepSegment(marker, data)) parts.push(bytes.subarray(pos, end));
    pos = end;
    if (marker === 0xda) break; // SOS: entropy-coded data follows.
  }
  // Entropy-coded data up to the first EOI (0xFF 0xD9); 0xFF00 and RSTn do not end it.
  let eoi = -1;
  for (let i = pos; i + 1 < bytes.length; i++) {
    if (bytes[i] !== 0xff) continue;
    const next = bytes[i + 1] ?? 0;
    if (next === 0xd9) {
      eoi = i;
      break;
    }
  }
  if (eoi < 0) throw new ImageFormatError("JPEG without its end");
  if (width === 0 || height === 0 || components === 0) throw new ImageFormatError("JPEG without a frame header");
  parts.push(bytes.subarray(pos, eoi + 2));
  const stripped = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    stripped.set(p, at);
    at += p.length;
  }
  return { width, height, components, orientation, stripped };
}

/** Width and height as displayed (orientations 5–8 swap them). */
export function orientedSize(width: number, height: number, orientation: number): { width: number; height: number } {
  return orientation >= 5 ? { width: height, height: width } : { width, height };
}

/** Stored pixel (x, y), top-left origin → displayed position, for each EXIF orientation. */
function display(orientation: number, w: number, h: number, x: number, y: number): [number, number] {
  switch (orientation) {
    case 2:
      return [w - x, y];
    case 3:
      return [w - x, h - y];
    case 4:
      return [x, h - y];
    case 5:
      return [y, x];
    case 6:
      return [h - y, x];
    case 7:
      return [h - y, w - x];
    case 8:
      return [y, w - x];
    default:
      return [x, y];
  }
}

export type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/**
 * The image matrix [a b c d e f] that draws an image of `width`×`height` stored pixels with EXIF
 * `orientation` into `box` (page points, bottom-left origin). PDF image space is the unit square
 * with the first row at the top.
 */
export function imageMatrix(orientation: number, width: number, height: number, box: Box): [number, number, number, number, number, number] {
  const shown = orientedSize(width, height, orientation);
  const sx = box.width / shown.width;
  const sy = box.height / shown.height;
  // Unit square (u, v), v up → stored pixel (u·w, (1−v)·h) → displayed → page.
  const page = (u: number, v: number): [number, number] => {
    const [dx, dy] = display(orientation, width, height, u * width, (1 - v) * height);
    return [box.x + dx * sx, box.y + box.height - dy * sy];
  };
  const [e, f] = page(0, 0);
  const [ux, uy] = page(1, 0);
  const [vx, vy] = page(0, 1);
  return [ux - e, uy - f, vx - e, vy - f, e, f];
}

const A4 = { width: 595, height: 842 } as const;
const LETTER = { width: 612, height: 792 } as const;
const MARGIN = 24;

/** Page size and the box the image fills, for an image shown `width`×`height`. */
export function pageLayout(width: number, height: number, size: PageSizeOption): { width: number; height: number; box: Box } {
  if (size === "fit") {
    const scale = A4.height / Math.max(width, height);
    const w = Math.max(1, Math.round(width * scale * 100) / 100);
    const h = Math.max(1, Math.round(height * scale * 100) / 100);
    return { width: w, height: h, box: { x: 0, y: 0, width: w, height: h } };
  }
  const paper = size === "a4" ? A4 : LETTER;
  const landscape = width > height;
  const pw = landscape ? paper.height : paper.width;
  const ph = landscape ? paper.width : paper.height;
  const scale = Math.min((pw - 2 * MARGIN) / width, (ph - 2 * MARGIN) / height);
  const bw = width * scale;
  const bh = height * scale;
  return { width: pw, height: ph, box: { x: (pw - bw) / 2, y: (ph - bh) / 2, width: bw, height: bh } };
}

/** Points per millimetre. */
const MM = 72 / 25.4;
/** ISO A4 in points, exactly (the "a4" page size above rounds it). */
export const A4_EXACT = { width: 210 * MM, height: 297 * MM } as const;
/** ID-1 (ISO/IEC 7810: bank and ID cards), landscape, in points. */
export const ID1 = { width: 85.6 * MM, height: 54 * MM } as const;
/** Space between the two sides of an ID card on the sheet. */
const ID_GAP = 10 * MM;

/**
 * An ID card's sides on one A4 page (ADR 0032): each at the ID-1 size (85.6 × 54 mm; 54 × 85.6
 * for a side taller than wide), centred one above the other with 10 mm between. Boxes are page
 * points, bottom-left origin, the first side on top.
 */
export function idCardSheet(sides: readonly { width: number; height: number }[]): { width: number; height: number; boxes: Box[] } {
  const sizes = sides.map((s) => (s.height > s.width ? { width: ID1.height, height: ID1.width } : { width: ID1.width, height: ID1.height }));
  const total = sizes.reduce((h, s) => h + s.height, 0) + ID_GAP * Math.max(0, sizes.length - 1);
  let top = (A4_EXACT.height + total) / 2;
  const boxes = sizes.map((s) => {
    const box = { x: (A4_EXACT.width - s.width) / 2, y: top - s.height, width: s.width, height: s.height };
    top -= s.height + ID_GAP;
    return box;
  });
  return { width: A4_EXACT.width, height: A4_EXACT.height, boxes };
}

/** Pixel size of a page exported at `dpi` (page size in points). */
export function exportPixels(page: { readonly width: number; readonly height: number }, dpi: number): { width: number; height: number } {
  return { width: Math.round((page.width * dpi) / 72), height: Math.round((page.height * dpi) / 72) };
}

/** A one-page blank PDF to start from (PDFium cannot save a document with no page). */
const SEED = (() => {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>"];
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${String(i + 1)} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 4\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return out;
})();

type DocCtx = { docPtr: number };

function context(engine: PdfiumNative, doc: PdfDocumentObject): DocCtx {
  const ctx = (engine as unknown as { cache: { getContext(id: string): DocCtx | undefined } }).cache.getContext(doc.id);
  if (!ctx) throw new Error("document is not open");
  return ctx;
}

let builderId = 0;

/** An image read and ready to embed. */
type Prepared = {
  readonly input: ImageInput;
  /** JPEG data with the metadata removed (null for pixels). */
  readonly jpeg: Uint8Array | null;
  readonly stored: { width: number; height: number; orientation: number };
  readonly shown: { width: number; height: number };
};

/**
 * The Emscripten runtime: heap views (re-read after every allocation: memory growth replaces
 * them) and the function table (the WASM build has ALLOW_TABLE_GROWTH; EmbedPDF uses it too).
 */
type Runtime = {
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  addFunction(fn: (...args: number[]) => number, signature: string): number;
  removeFunction(pointer: number): void;
};
const runtime = (pdf: WrappedPdfiumModule): Runtime => pdf.pdfium as unknown as Runtime;
const heap = runtime;

/**
 * Builds a PDF one image at a time (each input buffer can be dropped as soon as it is added).
 * `finish` returns the PDF; `discard` frees it without saving.
 */
export class ImagePdfBuilder {
  private pages = 0;

  private constructor(
    private readonly engine: PdfiumNative,
    private readonly pdf: WrappedPdfiumModule,
    private readonly doc: PdfDocumentObject,
  ) {}

  static async create(engine: PdfiumNative, pdf: WrappedPdfiumModule): Promise<ImagePdfBuilder> {
    const seed = new TextEncoder().encode(SEED);
    const doc = await engine.openDocumentBuffer({ id: `images-${String(builderId++)}`, content: seed.buffer }).toPromise();
    return new ImagePdfBuilder(engine, pdf, doc);
  }

  get pageCount(): number {
    return this.pages;
  }

  add(input: ImageInput, size: PageSizeOption): void {
    const prepared = this.prepare(input);
    const layout = pageLayout(prepared.shown.width, prepared.shown.height, size);
    this.page(layout.width, layout.height, [{ prepared, box: layout.box }]);
  }

  /**
   * One page of `width × height` points with each image filling its box (page points, bottom-left
   * origin; the image is stretched to the box). Used for an ID card's two sides (ADR 0032).
   */
  addSheet(width: number, height: number, items: readonly { input: ImageInput; box: Box }[]): void {
    if (items.length === 0) throw new Error("a sheet needs at least one image");
    this.page(
      width,
      height,
      items.map((item) => ({ prepared: this.prepare(item.input), box: item.box })),
    );
  }

  private prepare(input: ImageInput): Prepared {
    if (input.kind === "jpeg") {
      const info = inspectJpeg(new Uint8Array(input.bytes));
      return {
        input,
        jpeg: info.stripped,
        stored: { width: info.width, height: info.height, orientation: info.orientation },
        shown: orientedSize(info.width, info.height, info.orientation),
      };
    }
    if (input.data.byteLength < input.width * input.height * 4) throw new ImageFormatError("truncated pixels");
    return { input, jpeg: null, stored: { width: input.width, height: input.height, orientation: 1 }, shown: { width: input.width, height: input.height } };
  }

  private page(width: number, height: number, images: readonly { prepared: Prepared; box: Box }[]): void {
    const { pdf } = this;
    const { docPtr } = context(this.engine, this.doc);
    // After the seed page and the pages added so far.
    const page = pdf.FPDFPage_New(docPtr, this.pages + 1, width, height);
    if (!page) throw new Error("cannot add a page");
    try {
      for (const { prepared, box } of images) {
        const image = pdf.FPDFPageObj_NewImageObj(docPtr);
        if (!image) throw new Error("cannot create an image object");
        let inserted = false;
        try {
          if (prepared.jpeg) this.loadJpeg(image, prepared.jpeg);
          else if (prepared.input.kind === "rgba") this.loadPixels(image, prepared.input);
          const { stored } = prepared;
          const m = imageMatrix(stored.orientation, stored.width, stored.height, box);
          if (!pdf.FPDFImageObj_SetMatrix(image, m[0], m[1], m[2], m[3], m[4], m[5])) throw new Error("cannot place the image");
          pdf.FPDFPage_InsertObject(page, image);
          inserted = true;
        } finally {
          if (!inserted) pdf.FPDFPageObj_Destroy(image);
        }
      }
      if (!pdf.FPDFPage_GenerateContent(page)) throw new Error("cannot write the page");
    } finally {
      pdf.FPDF_ClosePage(page);
    }
    this.pages += 1;
  }

  /** Embeds the JPEG as it is (PDFium reads it through an FPDF_FILEACCESS on WASM memory). */
  private loadJpeg(image: number, jpeg: Uint8Array): void {
    const { pdf } = this;
    const m = pdf.pdfium;
    const data = m.wasmExports.malloc(jpeg.length);
    const access = m.wasmExports.malloc(12);
    // int GetBlock(void* param, unsigned long position, unsigned char* buf, unsigned long size)
    const getBlock = runtime(pdf).addFunction((_param: number, position: number, buf: number, size: number) => {
      if (position + size > jpeg.length) return 0;
      heap(pdf).HEAPU8.copyWithin(buf, data + position, data + position + size);
      return 1;
    }, "iiiii");
    try {
      heap(pdf).HEAPU8.set(jpeg, data);
      const u32 = heap(pdf).HEAPU32;
      u32[access >> 2] = jpeg.length;
      u32[(access >> 2) + 1] = getBlock;
      u32[(access >> 2) + 2] = 0;
      if (!pdf.FPDFImageObj_LoadJpegFileInline(0, 0, image, access)) throw new ImageFormatError("PDFium could not read the JPEG");
    } finally {
      runtime(pdf).removeFunction(getBlock);
      m.wasmExports.free(access);
      m.wasmExports.free(data);
    }
  }

  /** Embeds decoded pixels on white (PDFium compresses the bitmap losslessly when saving). */
  private loadPixels(image: number, input: Extract<ImageInput, { kind: "rgba" }>): void {
    const { pdf } = this;
    const bitmap = pdf.FPDFBitmap_Create(input.width, input.height, 0);
    if (!bitmap) throw new Error("not enough memory for the image");
    try {
      const stride = pdf.FPDFBitmap_GetStride(bitmap);
      const buffer = pdf.FPDFBitmap_GetBuffer(bitmap);
      const rgba = new Uint8Array(input.data);
      const row = new Uint8Array(input.width * 4);
      for (let y = 0; y < input.height; y++) {
        for (let x = 0; x < input.width; x++) {
          const s = (y * input.width + x) * 4;
          const a = (rgba[s + 3] ?? 255) / 255;
          const over = (c: number) => Math.round(c * a + 255 * (1 - a));
          // BGRx
          row[x * 4] = over(rgba[s + 2] ?? 0);
          row[x * 4 + 1] = over(rgba[s + 1] ?? 0);
          row[x * 4 + 2] = over(rgba[s] ?? 0);
          row[x * 4 + 3] = 255;
        }
        heap(pdf).HEAPU8.set(row, buffer + y * stride);
      }
      if (!pdf.FPDFImageObj_SetBitmap(0, 0, image, bitmap)) throw new Error("cannot embed the image");
    } finally {
      pdf.FPDFBitmap_Destroy(bitmap);
    }
  }

  /** The PDF (the seed page removed). At least one image must have been added. */
  async finish(): Promise<ArrayBuffer> {
    try {
      if (this.pages === 0) throw new Error("no images");
      const { docPtr } = context(this.engine, this.doc);
      this.pdf.FPDFPage_Delete(docPtr, 0);
      return (await this.engine.saveAsCopy(this.doc).toPromise()) as ArrayBuffer;
    } finally {
      await this.discard();
    }
  }

  async discard(): Promise<void> {
    await this.engine.closeDocument(this.doc).toPromise();
  }
}
