/**
 * Document scan (P4c, ADR 0016; Scan 2.0, ADR 0032; docs/design/p4-ui-brief.md §7): one
 * session from the camera to a new PDF. The scan worker (`@selis/scan`) holds the current
 * still. Each kept page keeps its photo and its edits (outline, filter, touch-ups, turns), so it
 * can be reopened from the review; its rendered image (JPEG, or PNG for black and white) is
 * held here until "Save as PDF", which builds the PDF in the engine worker like Images → PDF
 * (ADR 0017) and adds it to the library. An ID card session keeps two sides and saves them on
 * one A4 page at the ID-1 size.
 */
import { idCardSheet } from "@selis/engine";
import {
  createScanClient,
  defaultQuad,
  type PageEdits,
  type Picture,
  type PhotoSource,
  type Quad,
  type ScanClient,
  type ScanFilter,
  type Size,
  type Stroke,
} from "@selis/scan";
import { create } from "zustand";
import { api, type Document } from "../../lib/api";
import { currentRenderLimits, getEngine } from "../../lib/engine";
import { upload } from "../../lib/save";

export type ScanMode = "document" | "idcard";

export type ScannedPage = {
  readonly id: string;
  /** The photo the page is made from (to edit it later). */
  readonly source: Blob;
  /** The photo's size after the pixel cap (the outline's coordinates). */
  readonly photo: Size;
  readonly edits: PageEdits;
  readonly blob: Blob;
  readonly mime: "image/jpeg" | "image/png";
  /** The rendered page's size in pixels. */
  readonly size: Size;
  readonly thumb: string;
};

/** What a still in the Adjust step becomes: a new page, a retaken page, or new corners for a page being edited. */
export type StillTarget = { readonly kind: "new" } | { readonly kind: "replace"; readonly id: string } | { readonly kind: "edit"; readonly id: string };

export type Adjusting = {
  readonly width: number;
  readonly height: number;
  /** Where the page was found, or the default outline. */
  readonly found: Quad;
  readonly detected: boolean;
  readonly quad: Quad;
  readonly filter: ScanFilter;
  /** Preview images (object URLs) per filter, made on demand. */
  readonly previews: Partial<Record<ScanFilter, string>>;
  readonly previewWidth: number;
  readonly previewHeight: number;
  /** The photo, kept with the page. */
  readonly source: Blob;
  readonly target: StillTarget;
};

/** A kept page open for editing: its still is in the worker. */
export type EditingPage = {
  readonly id: string;
  readonly edits: PageEdits;
  /** The rendered page as it would be saved now (object URL), null while the first render runs. */
  readonly preview: string | null;
  readonly previewSize: Size | null;
  /** The photo's preview (for the corners) and size. */
  readonly photoPreview: string;
  readonly photoPreviewSize: Size;
  readonly photo: Size;
  readonly rendering: boolean;
};

export type ScanPhase =
  | { step: "closed" }
  | { step: "camera" }
  | { step: "capturing" }
  | { step: "adjust"; still: Adjusting }
  | { step: "keeping"; still: Adjusting }
  | { step: "queue" }
  | { step: "page"; page: EditingPage }
  | { step: "saving"; done: number; total: number };

export type ScanResult = { kind: "created"; document: Document } | { kind: "failed" };

/** Long side of the still's preview on the Adjust screen (sharp on a phone at 3×). */
const PREVIEW_SIDE = 1600;
/** A page being edited is shown at most this size. */
const EDIT_PREVIEW_PIXELS = 1200 * 1700;
/** Long side of the thumbnails. */
const THUMB_SIDE = 360;
/** A straightened page: A4 at 300 dpi at most, and never more than the device tier allows. */
const PAGE_PIXELS = 2480 * 3508;
const MB = 1024 * 1024;

/** The filters in the order the chips show them; Enhance is the default (ADR 0032). */
export const FILTER_ORDER: readonly ScanFilter[] = ["enhance", "grey", "bw", "original"];
/** The chips' labels (i18n keys). */
export const FILTER_KEYS: Record<ScanFilter, string> = {
  enhance: "scan.filterEnhance",
  original: "scan.filterOriginal",
  grey: "scan.filterGrey",
  bw: "scan.filterBw",
};

/** Pixels allowed for a still and for a page on this device (the adaptive render limits). */
export function stillPixels(): number {
  return currentRenderLimits().maxBitmapPixels;
}

function pagePixels(): number {
  return Math.min(PAGE_PIXELS, currentRenderLimits().maxBitmapPixels);
}

/**
 * Bytes of photos and pages a session may hold in the WebView (ADR 0032): 120 / 240 / 480 MB on
 * the low / mid / high memory tier (told apart by the tier's bitmap cap, `limits.ts`).
 */
export function batchCapBytes(): number {
  const pixels = currentRenderLimits().maxBitmapPixels;
  if (pixels >= 16_000_000) return 480 * MB;
  if (pixels >= 8_000_000) return 240 * MB;
  return 120 * MB;
}

/** Memory a page holds: its photo, its image and (roughly) its thumbnail. */
export function pageBytes(page: Pick<ScannedPage, "source" | "blob">): number {
  return page.source.size + page.blob.size + 64 * 1024;
}

export function batchBytes(pages: readonly ScannedPage[]): number {
  return pages.reduce((n, p) => n + pageBytes(p), 0);
}

/** A worker picture as a Blob (pixels are encoded here when the worker could not). */
export async function pictureBlob(picture: Picture, type: "image/jpeg" | "image/png", quality = 0.9): Promise<Blob> {
  if (picture.kind === "blob") return picture.blob;
  const canvas = document.createElement("canvas");
  canvas.width = picture.width;
  canvas.height = picture.height;
  canvas.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(picture.rgba), picture.width, picture.height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error("encoding failed");
  return blob;
}

let nextId = 0;
/** Bumped by every render request of the page being edited: only the newest one is shown. */
let renderToken = 0;

type ScanState = {
  phase: ScanPhase;
  pages: ScannedPage[];
  client: ScanClient | null;
  mode: ScanMode;
  /** The page a camera capture replaces (Retake from the review), if any. */
  retaking: string | null;
  /** The batch is at the device's memory cap: no more captures until it is saved or trimmed. */
  full: boolean;
  /** The page screen left for its corners (Adjust step), restored when they are done. */
  stash: EditingPage | null;
  open: () => Promise<void>;
  setMode: (mode: ScanMode) => void;
  /** Hands a still to the worker and moves to the Adjust screen. */
  capture: (photo: () => Promise<PhotoSource>) => Promise<boolean>;
  setQuad: (quad: Quad) => void;
  setFilter: (filter: ScanFilter) => Promise<void>;
  /** Leaves the Adjust step: back to the camera (or to the page being edited). */
  retake: () => void;
  keep: () => Promise<boolean>;
  showQueue: () => void;
  backToCamera: () => void;
  move: (id: string, delta: -1 | 1) => void;
  /** Moves a page so it lands in the gap `slot` (0…n) of the current order. */
  moveTo: (id: string, slot: number) => void;
  remove: (id: string) => void;
  /** Review → camera to retake `id` (the next capture replaces it in place). */
  retakePage: (id: string) => void;
  /** Leaves a retake without capturing. */
  cancelRetake: () => void;
  /** Review → the page screen (its photo goes back to the worker). */
  openPage: (id: string) => Promise<boolean>;
  editPage: (patch: Partial<Omit<PageEdits, "quad">>) => void;
  rotatePage: () => void;
  addStroke: (stroke: Stroke) => void;
  undoStroke: () => void;
  /** The page being edited → the Adjust step with its outline. */
  adjustPage: () => void;
  /** Leaves the page being edited, keeping its edits. */
  closePage: () => Promise<boolean>;
  close: () => void;
  save: (title: string) => Promise<ScanResult>;
};

/** Revokes a still's previews, except `keep` (a preview it borrowed from the page screen). */
function revokeStill(still: Adjusting, keep?: string): void {
  for (const url of Object.values(still.previews)) if (url && url !== keep) URL.revokeObjectURL(url);
}

function revokeEditing(page: EditingPage): void {
  if (page.preview) URL.revokeObjectURL(page.preview);
  URL.revokeObjectURL(page.photoPreview);
}

function sameEdits(a: PageEdits, b: PageEdits): boolean {
  return a.filter === b.filter && a.turns === b.turns && a.strokes === b.strokes && JSON.stringify(a.quad) === JSON.stringify(b.quad);
}

/** Pages an ID card session holds: front and back. */
export const ID_SIDES = 2;

export const useScan = create<ScanState>()((set, get) => {
  /** Renders the page being edited with its current edits (newest request wins). */
  const renderEditing = async () => {
    const { phase, client } = get();
    if (phase.step !== "page" || !client) return;
    const token = ++renderToken;
    set({ phase: { step: "page", page: { ...phase.page, rendering: true } } });
    try {
      const picture = await client.render(phase.page.edits, EDIT_PREVIEW_PIXELS);
      const url = URL.createObjectURL(await pictureBlob(picture, "image/jpeg", 0.85));
      const now = get().phase;
      if (token !== renderToken || now.step !== "page") {
        URL.revokeObjectURL(url);
        return;
      }
      if (now.page.preview) URL.revokeObjectURL(now.page.preview);
      set({ phase: { step: "page", page: { ...now.page, preview: url, previewSize: { width: picture.width, height: picture.height }, rendering: false } } });
    } catch (err) {
      console.warn("selis: page render failed", err);
      const now = get().phase;
      if (token === renderToken && now.step === "page") set({ phase: { step: "page", page: { ...now.page, rendering: false } } });
    }
  };

  const setEdits = (edits: PageEdits) => {
    const phase = get().phase;
    if (phase.step !== "page") return;
    set({ phase: { step: "page", page: { ...phase.page, edits } } });
    void renderEditing();
  };

  /** Where the camera goes after a page was kept or a retake ended. */
  const afterKeep = (pages: ScannedPage[], replaced: boolean): ScanPhase => {
    if (replaced) return { step: "queue" };
    if (get().mode === "idcard" && pages.length >= ID_SIDES) return { step: "queue" };
    return { step: "camera" };
  };

  return {
    phase: { step: "closed" },
    pages: [],
    client: null,
    mode: "document",
    retaking: null,
    full: false,
    stash: null,

    open: async () => {
      if (get().phase.step !== "closed") return;
      const client = createScanClient();
      set({ phase: { step: "camera" }, client, pages: [], mode: "document", retaking: null, full: false, stash: null });
      try {
        await client.init();
      } catch (err) {
        console.warn("selis: scan worker failed to start", err);
      }
    },

    setMode: (mode) => {
      if (get().pages.length > 0 || get().mode === mode) return;
      set({ mode });
      void get().client?.resetAuto().catch(() => undefined);
    },

    capture: async (photo) => {
      const { client, phase, retaking } = get();
      if (!client || phase.step !== "camera") return false;
      if (get().full && !retaking) return false;
      set({ phase: { step: "capturing" } });
      try {
        const source = await photo();
        const still = await client.still(source, stillPixels(), PREVIEW_SIDE);
        const preview = await pictureBlob(still.preview, "image/jpeg", 0.85);
        const kept = source.kind === "blob" ? source.blob : still.source ? await pictureBlob(still.source, "image/jpeg", 0.92) : null;
        if (get().phase.step !== "capturing") return false;
        if (!kept) throw new Error("no photo to keep");
        const found = still.quad ?? defaultQuad({ width: still.width, height: still.height });
        const target: StillTarget = retaking ? { kind: "replace", id: retaking } : { kind: "new" };
        const filter: ScanFilter = get().mode === "idcard" ? "original" : "enhance";
        set({
          phase: {
            step: "adjust",
            still: {
              width: still.width,
              height: still.height,
              found,
              detected: still.quad !== null,
              quad: found,
              filter,
              previews: { original: URL.createObjectURL(preview) },
              previewWidth: still.preview.width,
              previewHeight: still.preview.height,
              source: kept,
              target,
            },
          },
        });
        if (filter !== "original") void get().setFilter(filter);
        console.info(`[selis:perf] scan still=${String(still.width)}x${String(still.height)} found=${String(still.quad !== null)}`);
        return true;
      } catch (err) {
        console.warn("selis: capture failed", err);
        if (get().phase.step === "capturing") set({ phase: { step: "camera" } });
        return false;
      }
    },

    setQuad: (quad) => {
      const phase = get().phase;
      if (phase.step !== "adjust") return;
      set({ phase: { step: "adjust", still: { ...phase.still, quad } } });
    },

    setFilter: async (filter) => {
      const { phase, client } = get();
      if (phase.step !== "adjust" || !client) return;
      set({ phase: { step: "adjust", still: { ...phase.still, filter } } });
      if (phase.still.previews[filter]) return;
      try {
        const url = URL.createObjectURL(await pictureBlob(await client.preview(filter), "image/jpeg", 0.85));
        const now = get().phase;
        if (now.step !== "adjust" && now.step !== "keeping") {
          URL.revokeObjectURL(url);
          return;
        }
        set({ phase: { ...now, still: { ...now.still, previews: { ...now.still.previews, [filter]: url } } } });
      } catch (err) {
        console.warn("selis: filter preview failed", err);
      }
    },

    retake: () => {
      const { phase, client } = get();
      if (phase.step !== "adjust") return;
      const { target } = phase.still;
      const stash = get().stash;
      revokeStill(phase.still, stash?.photoPreview);
      if (target.kind === "edit" && stash) {
        // Back to the page being edited, its outline unchanged (the still stays in the worker).
        set({ phase: { step: "page", page: stash }, stash: null });
        void renderEditing();
        return;
      }
      // The camera resumes the tracker: the same framing is not captured again by itself
      // until the page moves or goes (the shutter always works).
      void client?.drop().catch(() => undefined);
      set({ phase: { step: "camera" } });
    },

    keep: async () => {
      const { phase, client } = get();
      if (phase.step !== "adjust" || !client) return false;
      const { still } = phase;
      const stash = get().stash;
      if (still.target.kind === "edit" && stash) {
        // New corners (and filter) for the page being edited: rendered there, kept on leaving it.
        revokeStill(still, stash.photoPreview);
        set({ phase: { step: "page", page: { ...stash, edits: { ...stash.edits, quad: still.quad, filter: still.filter } } }, stash: null });
        void renderEditing();
        return true;
      }
      set({ phase: { step: "keeping", still } });
      const edits: PageEdits = { quad: still.quad, filter: still.filter, strokes: [], turns: 0 };
      try {
        const kept = await client.keep(edits, pagePixels(), THUMB_SIDE);
        const blob = await pictureBlob(kept.page, kept.mime);
        const thumb = URL.createObjectURL(await pictureBlob(kept.thumb, "image/jpeg", 0.8));
        revokeStill(still);
        if (get().phase.step !== "keeping") {
          URL.revokeObjectURL(thumb);
          return false;
        }
        const replacing = still.target.kind === "replace" ? still.target.id : null;
        const page: ScannedPage = {
          id: replacing ?? `scan-${String(nextId++)}`,
          source: still.source,
          photo: { width: still.width, height: still.height },
          edits,
          blob,
          mime: kept.mime,
          size: { width: kept.page.width, height: kept.page.height },
          thumb,
        };
        const pages = replacing
          ? get().pages.map((p) => {
              if (p.id !== replacing) return p;
              URL.revokeObjectURL(p.thumb);
              return page;
            })
          : [...get().pages, page];
        set({ pages, phase: afterKeep(pages, replacing !== null), retaking: null, full: batchBytes(pages) >= batchCapBytes() });
        console.info(`[selis:perf] scan keep=${String(Math.round(kept.ms))}ms pages=${String(pages.length)} bytes=${String(blob.size)}`);
        return true;
      } catch (err) {
        console.warn("selis: straightening failed", err);
        if (get().phase.step === "keeping") set({ phase: { step: "adjust", still } });
        return false;
      }
    },

    showQueue: () => {
      const step = get().phase.step;
      if ((step === "camera" || step === "queue") && get().pages.length > 0) set({ phase: { step: "queue" }, retaking: null });
    },

    backToCamera: () => {
      if (get().phase.step !== "queue") return;
      if (get().mode === "idcard" && get().pages.length >= ID_SIDES) return;
      set({ phase: { step: "camera" } });
    },

    move: (id, delta) => {
      const from = get().pages.findIndex((p) => p.id === id);
      if (from < 0) return;
      get().moveTo(id, delta < 0 ? from - 1 : from + 2);
    },

    moveTo: (id, slot) => {
      const pages = [...get().pages];
      const from = pages.findIndex((p) => p.id === id);
      if (from < 0 || slot < 0 || slot > pages.length) return;
      const [page] = pages.splice(from, 1);
      if (!page) return;
      pages.splice(slot > from ? slot - 1 : slot, 0, page);
      set({ pages });
    },

    remove: (id) => {
      const { phase, client } = get();
      const page = get().pages.find((p) => p.id === id);
      if (page) URL.revokeObjectURL(page.thumb);
      const pages = get().pages.filter((p) => p.id !== id);
      if (phase.step === "page" && phase.page.id === id) {
        revokeEditing(phase.page);
        void client?.drop().catch(() => undefined);
      }
      let next: ScanPhase = phase;
      if (phase.step === "page" && phase.page.id === id) next = pages.length > 0 ? { step: "queue" } : { step: "camera" };
      else if (phase.step === "queue" && pages.length === 0) next = { step: "camera" };
      set({ pages, phase: next, full: batchBytes(pages) >= batchCapBytes() });
    },

    retakePage: (id) => {
      const { phase, client } = get();
      if (!get().pages.some((p) => p.id === id)) return;
      if (phase.step === "page") {
        revokeEditing(phase.page);
        void client?.drop().catch(() => undefined);
      } else if (phase.step !== "queue") return;
      void client?.resetAuto().catch(() => undefined);
      set({ retaking: id, phase: { step: "camera" } });
    },

    cancelRetake: () => {
      if (get().phase.step !== "camera" || !get().retaking) return;
      set({ retaking: null, phase: { step: "queue" } });
    },

    openPage: async (id) => {
      const { phase, client, pages } = get();
      const page = pages.find((p) => p.id === id);
      if (!client || !page || phase.step !== "queue") return false;
      try {
        const still = await client.still({ kind: "blob", blob: page.source }, stillPixels(), PREVIEW_SIDE, page.edits.quad);
        const photoPreview = URL.createObjectURL(await pictureBlob(still.preview, "image/jpeg", 0.85));
        if (get().phase.step !== "queue") {
          URL.revokeObjectURL(photoPreview);
          return false;
        }
        set({
          phase: {
            step: "page",
            page: {
              id,
              edits: page.edits,
              preview: null,
              previewSize: null,
              photoPreview,
              photoPreviewSize: { width: still.preview.width, height: still.preview.height },
              photo: { width: still.width, height: still.height },
              rendering: true,
            },
          },
        });
        await renderEditing();
        return true;
      } catch (err) {
        console.warn("selis: opening the page failed", err);
        return false;
      }
    },

    editPage: (patch) => {
      const phase = get().phase;
      if (phase.step !== "page") return;
      setEdits({ ...phase.page.edits, ...patch });
    },

    rotatePage: () => {
      const phase = get().phase;
      if (phase.step !== "page") return;
      setEdits({ ...phase.page.edits, turns: (phase.page.edits.turns + 1) % 4 });
    },

    addStroke: (stroke) => {
      const phase = get().phase;
      if (phase.step !== "page" || stroke.points.length === 0) return;
      setEdits({ ...phase.page.edits, strokes: [...phase.page.edits.strokes, stroke] });
    },

    undoStroke: () => {
      const phase = get().phase;
      if (phase.step !== "page" || phase.page.edits.strokes.length === 0) return;
      setEdits({ ...phase.page.edits, strokes: phase.page.edits.strokes.slice(0, -1) });
    },

    adjustPage: () => {
      const phase = get().phase;
      if (phase.step !== "page") return;
      const { page } = phase;
      const stored = get().pages.find((p) => p.id === page.id);
      if (!stored) return;
      // A render still on its way is dropped; the page renders again when it comes back.
      renderToken++;
      if (page.preview) URL.revokeObjectURL(page.preview);
      const stash: EditingPage = { ...page, preview: null, previewSize: null, rendering: true };
      set({
        stash,
        phase: {
          step: "adjust",
          still: {
            width: page.photo.width,
            height: page.photo.height,
            found: stored.edits.quad,
            detected: true,
            quad: page.edits.quad,
            filter: page.edits.filter,
            // The photo's preview stays the page screen's (not revoked by the Adjust step).
            previews: { original: page.photoPreview },
            previewWidth: page.photoPreviewSize.width,
            previewHeight: page.photoPreviewSize.height,
            source: stored.source,
            target: { kind: "edit", id: page.id },
          },
        },
      });
      if (page.edits.filter !== "original") void get().setFilter(page.edits.filter);
    },

    closePage: async () => {
      const { phase, client } = get();
      if (phase.step !== "page" || !client) return false;
      const { page } = phase;
      const stored = get().pages.find((p) => p.id === page.id);
      if (!stored || sameEdits(stored.edits, page.edits)) {
        revokeEditing(page);
        void client.drop().catch(() => undefined);
        set({ phase: { step: "queue" } });
        return true;
      }
      set({ phase: { step: "page", page: { ...page, rendering: true } } });
      try {
        const kept = await client.keep(page.edits, pagePixels(), THUMB_SIDE);
        const blob = await pictureBlob(kept.page, kept.mime);
        const thumb = URL.createObjectURL(await pictureBlob(kept.thumb, "image/jpeg", 0.8));
        revokeEditing(page);
        URL.revokeObjectURL(stored.thumb);
        const updated: ScannedPage = { ...stored, edits: page.edits, blob, mime: kept.mime, size: { width: kept.page.width, height: kept.page.height }, thumb };
        const pages = get().pages.map((p) => (p.id === page.id ? updated : p));
        set({ pages, phase: { step: "queue" }, full: batchBytes(pages) >= batchCapBytes() });
        return true;
      } catch (err) {
        console.warn("selis: saving the page edits failed", err);
        const now = get().phase;
        if (now.step === "page") set({ phase: { step: "page", page: { ...now.page, rendering: false } } });
        return false;
      }
    },

    close: () => {
      const { phase, pages, client } = get();
      if (phase.step === "saving") return;
      const stash = get().stash;
      if (phase.step === "adjust" || phase.step === "keeping") revokeStill(phase.still, stash?.photoPreview);
      if (phase.step === "page") revokeEditing(phase.page);
      if (stash) revokeEditing(stash);
      for (const page of pages) URL.revokeObjectURL(page.thumb);
      client?.terminate();
      set({ phase: { step: "closed" }, pages: [], client: null, mode: "document", retaking: null, full: false, stash: null });
    },

    save: async (title) => {
      const { pages, phase, mode } = get();
      if (pages.length === 0 || phase.step !== "queue") return { kind: "failed" };
      if (mode === "idcard" && pages.length !== ID_SIDES) return { kind: "failed" };
      const total = mode === "idcard" ? 1 : pages.length;
      set({ phase: { step: "saving", done: 0, total } });
      try {
        const session = await getEngine().createImagePdf();
        try {
          if (mode === "idcard") {
            const sheet = idCardSheet(pages.map((p) => p.size));
            const items = await Promise.all(
              pages.map(async (page, i) => {
                const box = sheet.boxes[i];
                if (!box) throw new Error("no place for the side");
                return { bytes: await page.blob.arrayBuffer(), mime: page.mime, box };
              }),
            );
            await session.addSheet(sheet.width, sheet.height, items);
            set({ phase: { step: "saving", done: 1, total } });
          } else {
            for (const [index, page] of pages.entries()) {
              await session.add(await page.blob.arrayBuffer(), page.mime, "fit");
              set({ phase: { step: "saving", done: index + 1, total } });
            }
          }
        } catch (err) {
          await session.discard();
          throw err;
        }
        const bytes = await session.finish();
        const outcome = await api.importUpload(await upload(bytes), title);
        set({ phase: { step: "queue" } });
        get().close();
        return { kind: "created", document: outcome.document };
      } catch (err) {
        console.warn("selis: scan to PDF failed", err);
        set({ phase: { step: "queue" } });
        return { kind: "failed" };
      }
    },
  };
});

