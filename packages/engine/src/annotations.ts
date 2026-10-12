/**
 * Annotations in and out of PDFium (worker side). EmbedPDF writes the standard
 * subtypes (markup, ink, shapes, lines, notes) and generates their appearance
 * streams, so any PDF reader shows them. Typed text is the exception: PDFium's
 * FreeText appearance only knows the standard 14 fonts, which have no Greek, so
 * typed text is a Stamp whose appearance holds real text objects in an embedded
 * Latin + Greek font (Selis Sans: a Noto Sans subset, OFL). Its /Contents carries the plain
 * text for reviewers' comment lists.
 *
 * Shared by the worker and the Node tests (annotations.node.test.ts), which pin
 * the EmbedPDF internals used here to the version in package.json.
 */
import type { PdfiumNative } from "@embedpdf/engines/pdfium";
import {
  type PdfAnnotationObject,
  PdfAnnotationBorderStyle,
  PdfAnnotationLineEnding,
  PdfAnnotationSubtype,
  type PdfDocumentObject,
  type PdfPageObject,
  type PdfStampAnnoObject,
  type Rect,
} from "@embedpdf/models";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import type { PageRect } from "./geometry";
import type { Annotation, Point } from "./types";

/** /NM prefix of typed-text stamps written by Selis. */
export const TEXT_STAMP_PREFIX = "selis-text-";
/** /NM prefix of the stamps that show a form field's non-Latin value (see `setFieldOverlay`). */
export const FIELD_OVERLAY_PREFIX = "selis-field-";
/** /NM prefix of visual-signature stamps written by Selis. */
export const SIGNATURE_PREFIX = "selis-sig-";
/**
 * /Contents of a visual signature: what reviewers' comment lists show. It says
 * plainly that this is an image of a signature, not a certificate-based one.
 */
export const SIGNATURE_CONTENTS = "Οπτική υπογραφή (όχι ψηφιακή) / Visual signature (not a digital signature)";
/** Annotation dictionary key holding a typed-text stamp's style (JSON). */
const TEXT_STYLE_KEY = "SelisText";
/** Line height and first baseline of the embedded font, in em. */
const LINE_HEIGHT_EM = 1.36;
const ASCENT_EM = 1.07;
/** Inner padding of a typed-text box, in points. */
export const TEXT_PADDING = 2;

const ANNOT_FLAG_PRINT = 4;
/** FPDF_ANNOT_APPEARANCEMODE_NORMAL */
const APPEARANCE_NORMAL = 0;
const FPDF_FONT_TRUETYPE = 2;

type PageCtx = { pagePtr: number; release(): void };
type DocCtx = { docPtr: number; acquirePage(index: number): PageCtx };
/** EmbedPDF internals this module relies on (checked by the Node tests). */
type EngineInternals = {
  cache: { getContext(id: string): DocCtx | undefined };
  convertDevicePointToPagePoint(doc: PdfDocumentObject, page: PdfPageObject, p: Point): Point;
  setPageAnnoRect(doc: PdfDocumentObject, page: PdfPageObject, annotPtr: number, rect: Rect): boolean;
};
type Heap = { HEAPU8: Uint8Array; HEAPU16: Uint16Array };

function internals(engine: PdfiumNative): EngineInternals {
  return engine as unknown as EngineInternals;
}

const toRect = (r: PageRect): Rect => ({ origin: { x: r.x, y: r.y }, size: { width: r.width, height: r.height } });
const fromRect = (r: Rect): PageRect => ({ x: r.origin.x, y: r.origin.y, width: r.size.width, height: r.size.height });
const toPosition = (p: Point) => ({ x: p.x, y: p.y });

function hexColor(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

function isTransparent(value: string | undefined): boolean {
  return !value || value === "transparent";
}

/** EmbedPDF annotation → editor annotation. */
export function fromPdfAnnotation(a: PdfAnnotationObject, textStyle?: TextStyle | null): Annotation {
  const base = { id: a.id, page: a.pageIndex, rect: fromRect(a.rect) };
  switch (a.type) {
    case PdfAnnotationSubtype.HIGHLIGHT:
    case PdfAnnotationSubtype.UNDERLINE:
    case PdfAnnotationSubtype.STRIKEOUT: {
      const kind =
        a.type === PdfAnnotationSubtype.HIGHLIGHT ? "highlight" : a.type === PdfAnnotationSubtype.UNDERLINE ? "underline" : "strikeout";
      return {
        ...base,
        kind,
        color: hexColor(a.strokeColor, "#f4c430"),
        opacity: a.opacity,
        segments: (a.segmentRects.length > 0 ? a.segmentRects : [a.rect]).map(fromRect),
      };
    }
    case PdfAnnotationSubtype.INK:
      return {
        ...base,
        kind: "ink",
        color: hexColor(a.strokeColor, "#000000"),
        opacity: a.opacity,
        width: a.strokeWidth,
        strokes: a.inkList.map((s) => s.points.map((p) => ({ x: p.x, y: p.y }))),
      };
    case PdfAnnotationSubtype.SQUARE:
    case PdfAnnotationSubtype.CIRCLE:
      return {
        ...base,
        kind: a.type === PdfAnnotationSubtype.SQUARE ? "square" : "circle",
        color: hexColor(a.strokeColor, "#000000"),
        opacity: a.opacity,
        width: a.strokeWidth,
        fill: isTransparent(a.color) ? null : hexColor(a.color, "#ffffff"),
      };
    case PdfAnnotationSubtype.LINE:
      return {
        ...base,
        kind: a.lineEndings?.end === PdfAnnotationLineEnding.OpenArrow ? "arrow" : "line",
        color: hexColor(a.strokeColor, "#000000"),
        opacity: a.opacity,
        width: a.strokeWidth,
        start: { x: a.linePoints.start.x, y: a.linePoints.start.y },
        end: { x: a.linePoints.end.x, y: a.linePoints.end.y },
      };
    case PdfAnnotationSubtype.TEXT:
      return { ...base, kind: "note", color: hexColor(a.strokeColor, "#f4c430"), opacity: a.opacity ?? 1, text: a.contents };
    case PdfAnnotationSubtype.REDACT:
      return {
        ...base,
        kind: "redact",
        color: "#000000",
        opacity: 1,
        segments: (a.segmentRects.length > 0 ? a.segmentRects : [a.rect]).map(fromRect),
        fill: hexColor(a.color, "#000000").toLowerCase() === "#ffffff" ? "white" : "black",
        text: a.contents ?? "",
      };
    case PdfAnnotationSubtype.STAMP:
      if (a.id.startsWith(SIGNATURE_PREFIX)) return { ...base, kind: "signature", color: "#000000", opacity: 1, image: null };
      if (a.id.startsWith(TEXT_STAMP_PREFIX) && textStyle) {
        return { ...base, kind: "text", color: textStyle.color, opacity: 1, text: a.contents ?? "", fontSize: textStyle.fontSize };
      }
      return { ...base, kind: "other", color: "#000000", opacity: 1 };
    default:
      return { ...base, kind: "other", color: "#000000", opacity: 1 };
  }
}

/** A visual signature as an EmbedPDF stamp; its image goes in the create context. */
export function toSignatureStamp(a: Extract<Annotation, { kind: "signature" }>): PdfStampAnnoObject {
  return {
    id: a.id,
    pageIndex: a.page,
    rect: toRect(a.rect),
    flags: ["print"],
    type: PdfAnnotationSubtype.STAMP,
    contents: SIGNATURE_CONTENTS,
  };
}

/** Editor annotation → EmbedPDF annotation (all subtypes except typed text and signatures). */
export function toPdfAnnotation(a: Exclude<Annotation, { kind: "text" | "other" | "signature" }>): PdfAnnotationObject {
  const base = { id: a.id, pageIndex: a.page, rect: toRect(a.rect), flags: ["print" as const] };
  switch (a.kind) {
    case "highlight":
    case "underline":
    case "strikeout":
      return {
        ...base,
        type:
          a.kind === "highlight"
            ? PdfAnnotationSubtype.HIGHLIGHT
            : a.kind === "underline"
              ? PdfAnnotationSubtype.UNDERLINE
              : PdfAnnotationSubtype.STRIKEOUT,
        strokeColor: a.color,
        opacity: a.opacity,
        segmentRects: a.segments.map(toRect),
      };
    case "ink":
      return {
        ...base,
        type: PdfAnnotationSubtype.INK,
        strokeColor: a.color,
        opacity: a.opacity,
        strokeWidth: a.width,
        inkList: a.strokes.map((s) => ({ points: s.map(toPosition) })),
      };
    case "square":
    case "circle":
      return {
        ...base,
        type: a.kind === "square" ? PdfAnnotationSubtype.SQUARE : PdfAnnotationSubtype.CIRCLE,
        color: a.fill ?? "transparent",
        strokeColor: a.color,
        strokeWidth: a.width,
        strokeStyle: PdfAnnotationBorderStyle.SOLID,
        opacity: a.opacity,
      };
    case "line":
    case "arrow":
      return {
        ...base,
        type: PdfAnnotationSubtype.LINE,
        color: "transparent",
        strokeColor: a.color,
        strokeWidth: a.width,
        strokeStyle: PdfAnnotationBorderStyle.SOLID,
        opacity: a.opacity,
        linePoints: { start: toPosition(a.start), end: toPosition(a.end) },
        lineEndings: {
          start: PdfAnnotationLineEnding.None,
          end: a.kind === "arrow" ? PdfAnnotationLineEnding.OpenArrow : PdfAnnotationLineEnding.None,
        },
      };
    case "redact":
      // The replacement text goes in /Contents, not /OverlayText: PDFium would
      // draw that in a standard-14 font (no Greek). Selis writes it on apply.
      return {
        ...base,
        type: PdfAnnotationSubtype.REDACT,
        segmentRects: a.segments.map(toRect),
        color: a.fill === "white" ? "#ffffff" : "#000000",
        strokeColor: "#d13c3c",
        opacity: 1,
        contents: a.text,
      };
    case "note":
      return {
        ...base,
        flags: ["print", "noZoom", "noRotate"],
        type: PdfAnnotationSubtype.TEXT,
        contents: a.text,
        strokeColor: a.color,
        opacity: a.opacity,
      };
  }
}

export type TextStyle = { readonly fontSize: number; readonly color: string };

/** How a form text field draws its value (from the widget's /DA). */
export type FieldTextStyle = {
  /** Points; 0 = auto (fit the box), as in PDF. */
  readonly fontSize: number;
  readonly color: string;
  readonly multiline: boolean;
  /** The widget's own background and border (/MK BG, BC), redrawn by the overlay. */
  readonly background: string | null;
  readonly border: string | null;
  readonly borderWidth: number;
};

/**
 * Raw PDFium access for text drawn in the embedded Latin + Greek font: typed-text
 * stamps, and the appearance of form text fields whose value PDFium cannot draw
 * with the standard-14 fonts (Greek).
 */
export class EmbeddedText {
  /** Embedded font handle per document id (loaded on first use). */
  private readonly fonts = new Map<string, number>();

  constructor(
    private readonly engine: PdfiumNative,
    private readonly pdf: WrappedPdfiumModule,
    private readonly fontBytes: () => Promise<Uint8Array>,
  ) {}

  private get heap(): Heap {
    return this.pdf.pdfium as unknown as Heap;
  }

  private malloc(size: number): number {
    return this.pdf.pdfium.wasmExports.malloc(size);
  }

  private free(ptr: number): void {
    this.pdf.pdfium.wasmExports.free(ptr);
  }

  /** NUL-terminated UTF-16LE (FPDF_WIDESTRING). */
  private wideString(value: string): number {
    const ptr = this.malloc((value.length + 1) * 2);
    const base = ptr >> 1;
    for (let i = 0; i < value.length; i++) this.heap.HEAPU16[base + i] = value.charCodeAt(i);
    this.heap.HEAPU16[base + value.length] = 0;
    return ptr;
  }

  private setString(annot: number, key: string, value: string): boolean {
    const v = this.wideString(value);
    try {
      return this.pdf.FPDFAnnot_SetStringValue(annot, key, v);
    } finally {
      this.free(v);
    }
  }

  private getString(annot: number, key: string): string | null {
    const bytes = this.pdf.FPDFAnnot_GetStringValue(annot, key, 0, 0);
    if (bytes <= 2) return null;
    const buf = this.malloc(bytes);
    try {
      this.pdf.FPDFAnnot_GetStringValue(annot, key, buf, bytes);
      const units = this.heap.HEAPU16.subarray(buf >> 1, (buf >> 1) + bytes / 2 - 1);
      return String.fromCharCode(...units);
    } finally {
      this.free(buf);
    }
  }

  private context(doc: PdfDocumentObject): DocCtx {
    const ctx = internals(this.engine).cache.getContext(doc.id);
    if (!ctx) throw new Error("document is not open");
    return ctx;
  }

  /** The page text inside `rect` (page view coordinates), as PDFium extracts it. */
  boundedText(doc: PdfDocumentObject, page: PdfPageObject, rect: PageRect): string {
    const toPage = (p: Point) => internals(this.engine).convertDevicePointToPagePoint(doc, page, p);
    const a = toPage({ x: rect.x, y: rect.y });
    const b = toPage({ x: rect.x + rect.width, y: rect.y + rect.height });
    const pageCtx = this.context(doc).acquirePage(page.index);
    const textPage = this.pdf.FPDFText_LoadPage(pageCtx.pagePtr);
    try {
      if (!textPage) return "";
      const args = [Math.min(a.x, b.x), Math.max(a.y, b.y), Math.max(a.x, b.x), Math.min(a.y, b.y)] as const;
      const units = this.pdf.FPDFText_GetBoundedText(textPage, ...args, 0, 0);
      if (units <= 0) return "";
      const buf = this.malloc((units + 1) * 2);
      try {
        const got = this.pdf.FPDFText_GetBoundedText(textPage, ...args, buf, units);
        return String.fromCharCode(...this.heap.HEAPU16.subarray(buf >> 1, (buf >> 1) + got));
      } finally {
        this.free(buf);
      }
    } finally {
      if (textPage) this.pdf.FPDFText_ClosePage(textPage);
      pageCtx.release();
    }
  }

  /** Whether the document has a security handler (an owner password at least). */
  isEncrypted(doc: PdfDocumentObject): boolean {
    return this.pdf.EPDF_IsEncrypted(this.context(doc).docPtr);
  }

  /** Saves without the security handler from now on (the document is open, so it is readable). */
  removeEncryption(doc: PdfDocumentObject): void {
    if (!this.pdf.EPDF_RemoveEncryption(this.context(doc).docPtr)) throw new Error("cannot remove the encryption");
  }

  private async font(doc: PdfDocumentObject): Promise<number> {
    const cached = this.fonts.get(doc.id);
    if (cached) return cached;
    const bytes = await this.fontBytes();
    const ptr = this.malloc(bytes.length);
    try {
      this.heap.HEAPU8.set(bytes, ptr);
      const handle = this.pdf.FPDFText_LoadFont(this.context(doc).docPtr, ptr, bytes.length, FPDF_FONT_TRUETYPE, true);
      if (!handle) throw new Error("embedded font failed to load");
      this.fonts.set(doc.id, handle);
      return handle;
    } finally {
      this.free(ptr);
    }
  }

  /** Index of the annotation named `id` on an open page, or -1. */
  private find(pagePtr: number, id: string): number {
    const count = this.pdf.FPDFPage_GetAnnotCount(pagePtr);
    for (let i = 0; i < count; i++) {
      const annot = this.pdf.FPDFPage_GetAnnot(pagePtr, i);
      if (!annot) continue;
      const name = this.getString(annot, "NM");
      this.pdf.FPDFPage_CloseAnnot(annot);
      if (name === id) return i;
    }
    return -1;
  }

  /** Style of Selis typed-text stamps on a page, by id. */
  styles(doc: PdfDocumentObject, page: PdfPageObject, ids: readonly string[]): Map<string, TextStyle> {
    const out = new Map<string, TextStyle>();
    if (ids.length === 0) return out;
    const pageCtx = this.context(doc).acquirePage(page.index);
    try {
      const count = this.pdf.FPDFPage_GetAnnotCount(pageCtx.pagePtr);
      for (let i = 0; i < count; i++) {
        const annot = this.pdf.FPDFPage_GetAnnot(pageCtx.pagePtr, i);
        if (!annot) continue;
        const name = this.getString(annot, "NM");
        if (name && ids.includes(name)) {
          const style = parseStyle(this.getString(annot, TEXT_STYLE_KEY));
          if (style) out.set(name, style);
        }
        this.pdf.FPDFPage_CloseAnnot(annot);
      }
    } finally {
      pageCtx.release();
    }
    return out;
  }

  /** Width of `text` set in the embedded font at `fontSize`, in points. */
  private measure(docPtr: number, font: number, fontSize: number, text: string): number {
    if (text === "") return 0;
    const obj = this.pdf.FPDFPageObj_CreateTextObj(docPtr, font, fontSize);
    const wide = this.wideString(text);
    const bounds = this.malloc(16);
    try {
      this.pdf.FPDFText_SetText(obj, wide);
      if (!this.pdf.FPDFPageObj_GetBounds(obj, bounds, bounds + 4, bounds + 8, bounds + 12)) return 0;
      const f32 = new Float32Array(this.heap.HEAPU8.buffer, bounds, 4);
      return (f32[2] as number) - (f32[0] as number);
    } finally {
      this.free(wide);
      this.free(bounds);
      this.pdf.FPDFPageObj_Destroy(obj);
    }
  }

  /** Breaks `text` into lines no wider than `maxWidth` (explicit newlines kept). */
  private wrap(docPtr: number, font: number, fontSize: number, text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split(/\r?\n/)) {
      let line = "";
      for (const word of paragraph.split(/(\s+)/)) {
        const candidate = line + word;
        if (line !== "" && word.trim() !== "" && this.measure(docPtr, font, fontSize, candidate.trimEnd()) > maxWidth) {
          lines.push(line.trimEnd());
          line = word;
        } else {
          line = candidate;
        }
      }
      lines.push(line.trimEnd());
    }
    return lines;
  }

  /**
   * Writes a typed-text stamp. The box keeps `a.rect`'s top-left corner and
   * width (the wrap width); its height follows the lines. Returns the stored rect.
   */
  async create(doc: PdfDocumentObject, page: PdfPageObject, a: Extract<Annotation, { kind: "text" }>): Promise<PageRect> {
    const font = await this.font(doc);
    const ctx = this.context(doc);
    const inner = Math.max(1, a.rect.width - 2 * TEXT_PADDING);
    const lines = this.wrap(ctx.docPtr, font, a.fontSize, a.text, inner);
    const lineHeight = a.fontSize * LINE_HEIGHT_EM;
    const widest = Math.max(0, ...lines.map((l) => this.measure(ctx.docPtr, font, a.fontSize, l)));
    const rect: PageRect = {
      x: a.rect.x,
      y: a.rect.y,
      width: Math.max(a.rect.width, widest + 2 * TEXT_PADDING),
      height: lines.length * lineHeight + 2 * TEXT_PADDING,
    };
    const engine = internals(this.engine);
    const pageCtx = ctx.acquirePage(page.index);
    try {
      const existing = this.find(pageCtx.pagePtr, a.id);
      if (existing >= 0) this.pdf.FPDFPage_RemoveAnnot(pageCtx.pagePtr, existing);
      const annot = this.pdf.FPDFPage_CreateAnnot(pageCtx.pagePtr, PdfAnnotationSubtype.STAMP);
      if (!annot) throw new Error("cannot create the text stamp");
      try {
        if (!engine.setPageAnnoRect(doc, page, annot, toRect(rect))) throw new Error("cannot place the text stamp");
        this.setString(annot, "NM", a.id);
        this.setString(annot, "Contents", a.text);
        this.setString(annot, TEXT_STYLE_KEY, JSON.stringify({ fontSize: a.fontSize, color: a.color }));
        this.pdf.FPDFAnnot_SetFlags(annot, ANNOT_FLAG_PRINT);
        const [r, g, b] = rgb(a.color);
        const toPage = (p: Point) => engine.convertDevicePointToPagePoint(doc, page, p);
        lines.forEach((line, i) => {
          if (line === "") return;
          const obj = this.pdf.FPDFPageObj_CreateTextObj(ctx.docPtr, font, a.fontSize);
          const wide = this.wideString(line);
          try {
            this.pdf.FPDFText_SetText(obj, wide);
          } finally {
            this.free(wide);
          }
          this.pdf.FPDFPageObj_SetFillColor(obj, r, g, b, 255);
          // Baseline in page view coordinates, turned into the page's own space so
          // the text reads upright whatever the page's /Rotate.
          const x = rect.x + TEXT_PADDING;
          const y = rect.y + TEXT_PADDING + a.fontSize * ASCENT_EM + i * lineHeight;
          const o = toPage({ x, y });
          const ex = toPage({ x: x + 1, y });
          const up = toPage({ x, y: y - 1 });
          this.pdf.FPDFPageObj_Transform(obj, ex.x - o.x, ex.y - o.y, up.x - o.x, up.y - o.y, o.x, o.y);
          if (!this.pdf.FPDFAnnot_AppendObject(annot, obj)) throw new Error("cannot write the text stamp");
        });
      } finally {
        this.pdf.FPDFPage_CloseAnnot(annot);
      }
    } finally {
      pageCtx.release();
    }
    return rect;
  }

  /**
   * Shows a form text field's value in the embedded font (Greek and other text
   * beyond Latin-1, which PDFium's own field appearance draws with Helvetica
   * and so leaves blank). The value itself (/V) is set by the caller through
   * PDFium; this draws it as a print-flagged Stamp exactly over the widget,
   * named `selis-field-<widget id>` with the value as /Contents, and empties the
   * widget's own appearance (viewers draw form fields last, over annotations).
   * The stamp repeats the field's background and border. `text` null removes
   * the overlay (the caller has just set a Latin value, which PDFium draws).
   *
   * Why not the widget's own appearance: with @embedpdf/pdfium 2.15.1,
   * EPDFAnnot_SetAppearanceFromPage on a widget keeps the wrapper's resources
   * but not the drawing's, so the font is lost and the text comes out garbled
   * (forms.node.test.ts checks the text that a flattened page extracts).
   */
  async setFieldOverlay(
    doc: PdfDocumentObject,
    page: PdfPageObject,
    widgetId: string,
    rect: PageRect,
    text: string | null,
    style: FieldTextStyle,
  ): Promise<void> {
    const id = `${FIELD_OVERLAY_PREFIX}${widgetId}`;
    const ctx = this.context(doc);
    if (text === null || text === "") {
      const pageCtx = ctx.acquirePage(page.index);
      try {
        const index = this.find(pageCtx.pagePtr, id);
        if (index >= 0) this.pdf.FPDFPage_RemoveAnnot(pageCtx.pagePtr, index);
      } finally {
        pageCtx.release();
      }
      return;
    }
    const font = await this.font(doc);
    const engine = internals(this.engine);
    const pad = 2;
    const size = style.fontSize > 0 ? style.fontSize : style.multiline ? 10 : Math.max(4, Math.min(12, (rect.height - 2 * pad) * 0.72));
    const lines = style.multiline ? this.wrap(ctx.docPtr, font, size, text, rect.width - 2 * pad) : [text.replace(/\s+/g, " ")];
    const lineHeight = size * 1.2;
    const pageCtx = ctx.acquirePage(page.index);
    try {
      const existing = this.find(pageCtx.pagePtr, id);
      if (existing >= 0) this.pdf.FPDFPage_RemoveAnnot(pageCtx.pagePtr, existing);
      // The widget draws nothing now (an empty normal appearance); the overlay draws it all.
      const widgetIndex = this.find(pageCtx.pagePtr, widgetId);
      if (widgetIndex < 0) throw new Error("form field not found");
      const widget = this.pdf.FPDFPage_GetAnnot(pageCtx.pagePtr, widgetIndex);
      const empty = this.wideString("");
      try {
        if (!this.pdf.FPDFAnnot_SetAP(widget, APPEARANCE_NORMAL, empty)) throw new Error("cannot clear the field appearance");
      } finally {
        this.free(empty);
        this.pdf.FPDFPage_CloseAnnot(widget);
      }
      const annot = this.pdf.FPDFPage_CreateAnnot(pageCtx.pagePtr, PdfAnnotationSubtype.STAMP);
      if (!annot) throw new Error("cannot create the field overlay");
      try {
        if (!engine.setPageAnnoRect(doc, page, annot, toRect(rect))) throw new Error("cannot place the field overlay");
        this.setString(annot, "NM", id);
        this.setString(annot, "Contents", text);
        this.pdf.FPDFAnnot_SetFlags(annot, ANNOT_FLAG_PRINT);
        const toPage = (p: Point) => engine.convertDevicePointToPagePoint(doc, page, p);
        if (style.background || style.border) {
          // The field's box, in page space (any /Rotate).
          const a = toPage({ x: rect.x, y: rect.y });
          const c = toPage({ x: rect.x + rect.width, y: rect.y + rect.height });
          const inset = style.border ? style.borderWidth / 2 : 0;
          const left = Math.min(a.x, c.x) + inset;
          const bottom = Math.min(a.y, c.y) + inset;
          const box = this.pdf.FPDFPageObj_CreateNewRect(left, bottom, Math.abs(c.x - a.x) - 2 * inset, Math.abs(c.y - a.y) - 2 * inset);
          if (style.background) {
            const [br, bg, bb] = rgb(style.background);
            this.pdf.FPDFPageObj_SetFillColor(box, br, bg, bb, 255);
          }
          if (style.border) {
            const [sr, sg, sb] = rgb(style.border);
            this.pdf.FPDFPageObj_SetStrokeColor(box, sr, sg, sb, 255);
            this.pdf.FPDFPageObj_SetStrokeWidth(box, Math.max(0.5, style.borderWidth));
          }
          // Fill mode 1 = alternate (non-zero would do as well for a rectangle).
          this.pdf.FPDFPath_SetDrawMode(box, style.background ? 1 : 0, style.border !== null);
          if (!this.pdf.FPDFAnnot_AppendObject(annot, box)) throw new Error("cannot write the field overlay");
        }
        const [r, g, b] = rgb(style.color);
        lines.forEach((line, i) => {
          if (line === "") return;
          const obj = this.pdf.FPDFPageObj_CreateTextObj(ctx.docPtr, font, size);
          const wide = this.wideString(line);
          try {
            this.pdf.FPDFText_SetText(obj, wide);
          } finally {
            this.free(wide);
          }
          this.pdf.FPDFPageObj_SetFillColor(obj, r, g, b, 255);
          // Baseline in view coordinates (top-left): single line centred, multiline from the top.
          const y = style.multiline ? rect.y + pad + size * ASCENT_EM + i * lineHeight : rect.y + rect.height / 2 + size * 0.36;
          const x = rect.x + pad;
          const o = toPage({ x, y });
          const ex = toPage({ x: x + 1, y });
          const up = toPage({ x, y: y - 1 });
          this.pdf.FPDFPageObj_Transform(obj, ex.x - o.x, ex.y - o.y, up.x - o.x, up.y - o.y, o.x, o.y);
          if (!this.pdf.FPDFAnnot_AppendObject(annot, obj)) throw new Error("cannot write the field overlay");
        });
      } finally {
        this.pdf.FPDFPage_CloseAnnot(annot);
      }
    } finally {
      pageCtx.release();
    }
  }

  /** Frees the font handle of a closed document. */
  forget(docId: string): void {
    const font = this.fonts.get(docId);
    if (font) this.pdf.FPDFFont_Close(font);
    this.fonts.delete(docId);
  }
}

function parseStyle(json: string | null): TextStyle | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as { fontSize?: unknown; color?: unknown };
    const fontSize = typeof v.fontSize === "number" && v.fontSize > 0 ? v.fontSize : 14;
    return { fontSize, color: hexColor(typeof v.color === "string" ? v.color : undefined, "#000000") };
  } catch {
    return null;
  }
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
