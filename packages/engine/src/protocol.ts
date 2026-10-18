import type { QuarterTurns } from "./geometry";
import type { PageSizeOption } from "./images";
import type { SheetImage } from "./types";
import type { PageOp } from "./pages";
import type {
  Annotation,
  EngineErrorCode,
  FieldChange,
  FormField,
  Glyph,
  ImportLosses,
  OutlineItem,
  PageSize,
  PageTextInfo,
  RedactionPreview,
  SearchHit,
  StampImage,
  TextLayerWord,
  TextRun,
} from "./types";

/** Max pixels per rendered bitmap (≈ 4096²): bounds WebView memory on mobile. */
export const MAX_BITMAP_PIXELS = 16_777_216;

export type WorkerRequest =
  | { type: "warmup"; reqId: number }
  | { type: "open"; reqId: number; bytes: ArrayBuffer; password?: string }
  | {
      type: "render";
      reqId: number;
      docId: string;
      index: number;
      scale: number;
      prefetch: boolean;
      rotation: QuarterTurns;
      night: boolean;
    }
  | { type: "outline"; reqId: number; docId: string }
  | { type: "search"; reqId: number; docId: string; query: string }
  | { type: "text"; reqId: number; docId: string; index: number }
  | { type: "thumbnail"; reqId: number; docId: string; index: number; maxWidth: number; maxHeight: number }
  | { type: "glyphs"; reqId: number; docId: string; index: number }
  | { type: "annotations"; reqId: number; docId: string; index: number }
  | { type: "addAnnotation"; reqId: number; docId: string; annotation: Annotation }
  | { type: "removeAnnotation"; reqId: number; docId: string; index: number; id: string }
  | { type: "save"; reqId: number; docId: string }
  | { type: "formFields"; reqId: number; docId: string; index: number }
  | { type: "documentFields"; reqId: number; docId: string }
  | { type: "setFormField"; reqId: number; docId: string; index: number; id: string; change: FieldChange }
  | { type: "flatten"; reqId: number; docId: string }
  | { type: "reload"; reqId: number; docId: string; bytes: ArrayBuffer }
  | { type: "editPages"; reqId: number; docId: string; op: PageOp }
  | { type: "extract"; reqId: number; docId: string; indices: number[] }
  | { type: "applyRedactions"; reqId: number; docId: string }
  | { type: "redactionPreview"; reqId: number; docId: string }
  | { type: "importLosses"; reqId: number; docId: string; bytes: ArrayBuffer }
  | { type: "appearance"; reqId: number; docId: string; index: number; id: string }
  /** Images → PDF (P4b): a builder in the worker, fed one image at a time. */
  | { type: "imagesBegin"; reqId: number }
  | { type: "imagesAdd"; reqId: number; builder: number; bytes: ArrayBuffer; mime: string; size: PageSizeOption }
  | { type: "imagesAddSheet"; reqId: number; builder: number; width: number; height: number; items: SheetImage[] }
  | { type: "imagesFinish"; reqId: number; builder: number }
  | { type: "imagesDiscard"; reqId: number; builder: number }
  /** A page as a PNG/JPEG at `dpi`, within `maxPixels`. */
  | { type: "exportImage"; reqId: number; docId: string; index: number; dpi: number; format: "png" | "jpeg"; maxPixels: number }
  /** OCR text layer (P4d): replaces the page's Selis OCR words with `words`. */
  | { type: "setTextLayer"; reqId: number; docId: string; index: number; words: TextLayerWord[] }
  | { type: "pageTextInfo"; reqId: number; docId: string; index: number }
  | { type: "pageGray"; reqId: number; docId: string; index: number; scale: number }
  | { type: "cancel"; reqId: number }
  | { type: "close"; reqId: number; docId: string };

export type WorkerResponse =
  | { type: "ready"; reqId: number }
  | { type: "opened"; reqId: number; docId: string; pages: PageSize[]; title: string | null }
  | { type: "rendered"; reqId: number; width: number; height: number; pixels: ArrayBuffer }
  | { type: "thumbnail"; reqId: number; width: number; height: number; mime: string; bytes: ArrayBuffer }
  | { type: "outline"; reqId: number; items: OutlineItem[] }
  /** Progress of a search (not its final reply): hits on one page. */
  | { type: "searchHits"; reqId: number; page: number; hits: SearchHit[] }
  | { type: "searchDone"; reqId: number; total: number }
  | { type: "text"; reqId: number; runs: TextRun[] }
  | { type: "glyphs"; reqId: number; glyphs: Glyph[] }
  | { type: "annotations"; reqId: number; items: Annotation[] }
  | { type: "annotation"; reqId: number; annotation: Annotation }
  | { type: "removed"; reqId: number; removed: boolean }
  | { type: "saved"; reqId: number; bytes: ArrayBuffer }
  | { type: "formFields"; reqId: number; fields: FormField[] }
  | { type: "flattened"; reqId: number; pages: number }
  | { type: "reloaded"; reqId: number; pages: PageSize[] }
  /** The document after a page operation, and its bytes before (the undo snapshot). */
  | { type: "pagesEdited"; reqId: number; pages: PageSize[]; before: ArrayBuffer }
  | { type: "extracted"; reqId: number; bytes: ArrayBuffer }
  | { type: "redacted"; reqId: number; pages: PageSize[]; before: ArrayBuffer; applied: number }
  | { type: "importLosses"; reqId: number; losses: ImportLosses }
  | { type: "redactionPreview"; reqId: number; preview: RedactionPreview }
  | { type: "appearance"; reqId: number; image: StampImage }
  | { type: "imagesBuilder"; reqId: number; builder: number }
  | { type: "imagesAdded"; reqId: number; pages: number }
  | { type: "imagesDone"; reqId: number; bytes: ArrayBuffer }
  /** `mime` RAW_RGBA when the worker could not encode (the client encodes). */
  | { type: "exportedImage"; reqId: number; mime: string; width: number; height: number; bytes: ArrayBuffer }
  | { type: "textLayer"; reqId: number; replaced: TextLayerWord[] }
  | { type: "pageTextInfo"; reqId: number; info: PageTextInfo }
  | { type: "pageGray"; reqId: number; width: number; height: number; bytes: ArrayBuffer }
  | { type: "closed"; reqId: number }
  | { type: "error"; reqId: number; code: EngineErrorCode; message: string };

/**
 * Clamps a render scale so the bitmap stays within the pixel budget.
 * Returns the effective scale (never above the requested one).
 */
export function clampScale(page: PageSize, scale: number, maxPixels = MAX_BITMAP_PIXELS): number {
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  const pixels = page.width * scale * page.height * scale;
  if (pixels <= maxPixels) return scale;
  return Math.sqrt(maxPixels / (page.width * page.height));
}

/** Thumbnail `mime` when the worker could not encode: width × height RGBA pixels. */
export const RAW_RGBA = "application/x-selis-rgba";

/** Largest scale at which the page fits in a maxWidth × maxHeight pixel box. */
export function thumbnailScale(page: PageSize, maxWidth: number, maxHeight: number): number {
  if (page.width <= 0 || page.height <= 0 || maxWidth <= 0 || maxHeight <= 0) return 0;
  return Math.min(maxWidth / page.width, maxHeight / page.height);
}
