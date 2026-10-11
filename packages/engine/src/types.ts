/** Page size in PDF points (1/72 in), after the page's own /Rotate is applied. */
import type { PageRect, QuarterTurns } from "./geometry";
import type { RenderLimits } from "./limits";

export type PageSize = { readonly width: number; readonly height: number };

export type EngineErrorCode = "password" | "format" | "closed" | "cancelled" | "init" | "unknown";

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

export type OpenOptions = {
  password?: string;
};

/** One outline (bookmarks) entry; `page` is null when it points nowhere in this file. */
export type OutlineItem = { readonly title: string; readonly page: number | null; readonly children: readonly OutlineItem[] };

/** One search match: its highlight rects in page points (top-left origin, unrotated). */
export type SearchHit = { readonly rects: readonly PageRect[] };

/** A run of text on the page, for the selectable text layer (page points, unrotated). */
export type TextRun = PageRect & { readonly text: string; readonly fontSize: number };

export type SearchOptions = {
  signal?: AbortSignal;
  /** Called per page with matches, in page order, while the search runs. */
  onHits?: (page: number, hits: readonly SearchHit[]) => void;
};

export type RenderOptions = {
  /** Aborting drops a queued render; the promise rejects with code "cancelled". */
  signal?: AbortSignal;
  /** Prefetch renders (off-screen buffer pages) yield to visible ones. */
  prefetch?: boolean;
  /** View rotation, clockwise quarter turns (not saved into the document). */
  rotation?: QuarterTurns;
  /** Night mode: lightness inverted, hues and images kept. */
  night?: boolean;
};

/** An encoded page preview, ready to store. */
export type Thumbnail = {
  readonly mime: string;
  readonly bytes: ArrayBuffer;
  readonly width: number;
  readonly height: number;
};

/** An open document inside the engine worker. */
export interface DocHandle {
  readonly id: string;
  readonly pageCount: number;
  readonly pages: readonly PageSize[];
  /** /Title from the document info dictionary, if any. */
  readonly title: string | null;
  /**
   * Renders one page. `scale` is device pixels per PDF point. The bitmap may be
   * smaller than requested when it would exceed the engine's pixel budget.
   * The caller owns the bitmap and must `close()` it (or transfer it) when done.
   */
  renderPage(index: number, scale: number, options?: RenderOptions): Promise<ImageBitmap>;
  /**
   * Same as `renderPage` but returns raw RGBA pixels. Preferred for on-screen
   * pages drawn into reused canvases: no per-render GPU/shared-memory resource.
   */
  renderPageImage(index: number, scale: number, options?: RenderOptions): Promise<ImageData>;
  /**
   * Renders a small preview of one page and encodes it in the worker (WebP;
   * JPEG where the WebView cannot encode WebP). Queued behind visible pages.
   */
  renderThumbnail(index: number, maxWidth: number, maxHeight: number, options?: RenderOptions): Promise<Thumbnail>;
  /** The document outline (bookmarks), empty when there is none. */
  outline(): Promise<OutlineItem[]>;
  /** Case-insensitive full-text search over all pages; resolves to the number of matches. */
  search(query: string, options?: SearchOptions): Promise<number>;
  /** Text runs of one page (for selection and copy). */
  textRuns(index: number): Promise<TextRun[]>;
  /** Every glyph of one page in reading order (text markup selection). */
  glyphs(index: number): Promise<readonly Glyph[]>;
  /** Annotations of one page, in drawing order. */
  annotations(index: number): Promise<Annotation[]>;
  /**
   * Adds an annotation and returns it as stored. An `id` that is already on the
   * page is replaced (redo of a removal keeps the same id).
   */
  addAnnotation(annotation: Annotation): Promise<Annotation>;
  /** Removes an annotation; resolves false if it was not there. */
  removeAnnotation(page: number, id: string): Promise<boolean>;
  /** Monotonic counter per page, bumped by every change to the page. */
  pageRevision(index: number): number;
  /** Called with the page index after each change; returns an unsubscribe function. */
  onPageChange(listener: (index: number) => void): () => void;
  /** The document with all changes, as a new PDF file (the original bytes stay untouched). */
  save(): Promise<ArrayBuffer>;
  close(): Promise<void>;
}

export interface PdfEngine {
  open(bytes: ArrayBuffer, options?: OpenOptions): Promise<DocHandle>;
  /** Current render limits (resolution cap, bitmap budget, page cache bounds). */
  readonly limits: RenderLimits;
  /** Applies limits for this device (see `renderLimitsFor`). */
  setLimits(limits: RenderLimits): void;
  /** Loads and compiles the PDF engine ahead of the first `open` (idempotent). */
  warmUp(): Promise<void>;
  /** Terminates the worker and frees all WASM memory. */
  destroy(): void;
}

export type Point = { readonly x: number; readonly y: number };

/**
 * An annotation as the editor sees it. Geometry is in page points, top-left
 * origin, on the unrotated page (like text and search rects). Colors are
 * `#rrggbb`.
 */
export type Annotation =
  | (AnnotationBase & {
      readonly kind: "highlight" | "underline" | "strikeout";
      /** One rect per selected line. */
      readonly segments: readonly PageRect[];
    })
  | (AnnotationBase & { readonly kind: "ink"; readonly width: number; readonly strokes: readonly (readonly Point[])[] })
  | (AnnotationBase & {
      readonly kind: "square" | "circle";
      readonly width: number;
      /** Interior color, null = transparent. */
      readonly fill: string | null;
    })
  | (AnnotationBase & {
      readonly kind: "line" | "arrow";
      readonly width: number;
      readonly start: Point;
      readonly end: Point;
    })
  /** Typed text, drawn with the embedded Latin + Greek font (a Stamp annotation). */
  | (AnnotationBase & { readonly kind: "text"; readonly text: string; readonly fontSize: number })
  /** Sticky note: an icon on the page with a comment (a Text annotation). */
  | (AnnotationBase & { readonly kind: "note"; readonly text: string })
  /** Anything else (links, form widgets, foreign stamps…): shown, never edited. */
  | (AnnotationBase & { readonly kind: "other" });

type AnnotationBase = {
  /** /NM of the annotation (stable across saves). */
  readonly id: string;
  readonly page: number;
  /** Bounding box. */
  readonly rect: PageRect;
  readonly color: string;
  readonly opacity: number;
};

export type AnnotationKind = Annotation["kind"];

/** One glyph of the page text, in logical (reading) order. */
export type Glyph = PageRect & {
  /** Index of the text run (PDF text object) the glyph belongs to. */
  readonly run: number;
  readonly space: boolean;
};
