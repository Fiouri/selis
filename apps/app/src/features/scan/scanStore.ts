/**
 * Document scan (P4c, ADR 0016; docs/design/p4-ui-brief.md §7): one session from the camera
 * to a new PDF. The scan worker (`@selis/scan`) holds the current still; kept pages are
 * encoded images (JPEG, or PNG for black and white) held here until "Save as PDF", which
 * builds the PDF in the engine worker like Images → PDF (ADR 0017) and adds it to the library.
 */
import { createScanClient, defaultQuad, type Picture, type PhotoSource, type Quad, type ScanClient, type ScanFilter } from "@selis/scan";
import { create } from "zustand";
import { api, type Document } from "../../lib/api";
import { currentRenderLimits, getEngine } from "../../lib/engine";
import { upload } from "../../lib/save";

export type ScannedPage = {
  readonly id: string;
  readonly blob: Blob;
  readonly mime: "image/jpeg" | "image/png";
  readonly thumb: string;
};

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
};

export type ScanPhase =
  | { step: "closed" }
  | { step: "camera" }
  | { step: "capturing" }
  | { step: "adjust"; still: Adjusting }
  | { step: "keeping"; still: Adjusting }
  | { step: "queue" }
  | { step: "saving"; done: number; total: number };

export type ScanResult = { kind: "created"; document: Document } | { kind: "failed" };

/** Long side of the still's preview on the Adjust screen (sharp on a phone at 3×). */
const PREVIEW_SIDE = 1600;
/** Long side of the queue thumbnails. */
const THUMB_SIDE = 360;
/** A straightened page: A4 at 300 dpi at most, and never more than the device tier allows. */
const PAGE_PIXELS = 2480 * 3508;

/** Pixels allowed for a still and for a page on this device (the adaptive render limits). */
export function stillPixels(): number {
  return currentRenderLimits().maxBitmapPixels;
}

function pagePixels(): number {
  return Math.min(PAGE_PIXELS, currentRenderLimits().maxBitmapPixels);
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

type ScanState = {
  phase: ScanPhase;
  pages: ScannedPage[];
  client: ScanClient | null;
  open: () => Promise<void>;
  /** Hands a still to the worker and moves to the Adjust screen. */
  capture: (photo: () => Promise<PhotoSource>) => Promise<boolean>;
  setQuad: (quad: Quad) => void;
  setFilter: (filter: ScanFilter) => Promise<void>;
  retake: () => void;
  keep: () => Promise<boolean>;
  showQueue: () => void;
  backToCamera: () => void;
  move: (id: string, delta: -1 | 1) => void;
  remove: (id: string) => void;
  close: () => void;
  save: (title: string) => Promise<ScanResult>;
};

function revokeStill(still: Adjusting): void {
  for (const url of Object.values(still.previews)) if (url) URL.revokeObjectURL(url);
}

export const useScan = create<ScanState>()((set, get) => ({
  phase: { step: "closed" },
  pages: [],
  client: null,

  open: async () => {
    if (get().phase.step !== "closed") return;
    const client = createScanClient();
    set({ phase: { step: "camera" }, client, pages: [] });
    try {
      await client.init();
    } catch (err) {
      console.warn("selis: scan worker failed to start", err);
    }
  },

  capture: async (photo) => {
    const { client, phase } = get();
    if (!client || phase.step !== "camera") return false;
    set({ phase: { step: "capturing" } });
    try {
      const still = await client.still(await photo(), stillPixels(), PREVIEW_SIDE);
      const preview = await pictureBlob(still.preview, "image/jpeg", 0.85);
      if (get().phase.step !== "capturing") return false;
      const found = still.quad ?? defaultQuad({ width: still.width, height: still.height });
      set({
        phase: {
          step: "adjust",
          still: {
            width: still.width,
            height: still.height,
            found,
            detected: still.quad !== null,
            quad: found,
            filter: "original",
            previews: { original: URL.createObjectURL(preview) },
            previewWidth: still.preview.width,
            previewHeight: still.preview.height,
          },
        },
      });
      console.info(`[selis:perf] scan still=${still.width}x${still.height} found=${String(still.quad !== null)}`);
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
    revokeStill(phase.still);
    void client?.drop().catch(() => undefined);
    set({ phase: { step: "camera" } });
  },

  keep: async () => {
    const { phase, client } = get();
    if (phase.step !== "adjust" || !client) return false;
    set({ phase: { step: "keeping", still: phase.still } });
    try {
      const kept = await client.keep({ quad: phase.still.quad, filter: phase.still.filter, strokes: [], turns: 0 }, pagePixels(), THUMB_SIDE);
      const blob = await pictureBlob(kept.page, kept.mime);
      const thumb = URL.createObjectURL(await pictureBlob(kept.thumb, "image/jpeg", 0.8));
      revokeStill(phase.still);
      if (get().phase.step !== "keeping") {
        URL.revokeObjectURL(thumb);
        return false;
      }
      const page: ScannedPage = { id: `scan-${String(nextId++)}`, blob, mime: kept.mime, thumb };
      set((s) => ({ pages: [...s.pages, page], phase: { step: "camera" } }));
      console.info(`[selis:perf] scan keep=${Math.round(kept.ms)}ms pages=${String(get().pages.length)} bytes=${String(blob.size)}`);
      return true;
    } catch (err) {
      console.warn("selis: straightening failed", err);
      if (get().phase.step === "keeping") set({ phase: { step: "adjust", still: phase.still } });
      return false;
    }
  },

  showQueue: () => {
    const step = get().phase.step;
    if ((step === "camera" || step === "queue") && get().pages.length > 0) set({ phase: { step: "queue" } });
  },

  backToCamera: () => {
    if (get().phase.step === "queue") set({ phase: { step: "camera" } });
  },

  move: (id, delta) => {
    const pages = [...get().pages];
    const from = pages.findIndex((p) => p.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= pages.length) return;
    const [page] = pages.splice(from, 1);
    if (page) pages.splice(to, 0, page);
    set({ pages });
  },

  remove: (id) => {
    const page = get().pages.find((p) => p.id === id);
    if (page) URL.revokeObjectURL(page.thumb);
    const pages = get().pages.filter((p) => p.id !== id);
    set({ pages, ...(pages.length === 0 && get().phase.step === "queue" ? { phase: { step: "camera" } as const } : {}) });
  },

  close: () => {
    const { phase, pages, client } = get();
    if (phase.step === "saving") return;
    if (phase.step === "adjust" || phase.step === "keeping") revokeStill(phase.still);
    for (const page of pages) URL.revokeObjectURL(page.thumb);
    client?.terminate();
    set({ phase: { step: "closed" }, pages: [], client: null });
  },

  save: async (title) => {
    const { pages, phase } = get();
    if (pages.length === 0 || phase.step !== "queue") return { kind: "failed" };
    set({ phase: { step: "saving", done: 0, total: pages.length } });
    try {
      const session = await getEngine().createImagePdf();
      try {
        for (const [index, page] of pages.entries()) {
          await session.add(await page.blob.arrayBuffer(), page.mime, "fit");
          set({ phase: { step: "saving", done: index + 1, total: pages.length } });
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
}));
