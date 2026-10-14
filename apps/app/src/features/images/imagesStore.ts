/**
 * Images → PDF (P4b, ADR 0017; docs/design/p4-ui-brief.md §5): the picked photos, their order,
 * the page size, and making the PDF. Android picks through the system photo picker (Rust) and
 * stages each photo; iOS and desktop pick with a file input (WKWebView shows PHPicker). The PDF
 * is built in the engine worker one photo at a time, uploaded and added to the library.
 */
import { EngineError, type PageSizeOption } from "@selis/engine";
import { create } from "zustand";
import { ApiError, api, type Document } from "../../lib/api";
import { getEngine } from "../../lib/engine";
import { assetUrl } from "../../lib/files";
import { platform } from "../../lib/platform";
import { upload } from "../../lib/save";

export type PickedImage = {
  readonly id: string;
  /** Small blob URL shown in the grid; null while it is made or when it cannot be. */
  readonly thumb: string | null;
  readonly mime: string;
  read: () => Promise<ArrayBuffer>;
  dispose: () => void;
};

export type ImagesPhase =
  | { step: "closed" }
  | { step: "picking" }
  | { step: "edit" }
  | { step: "creating"; done: number; total: number };

/** What happened, for the caller to say (i18n keys under `images.`). */
export type ImagesResult =
  | { kind: "created"; document: Document; skipped: number }
  | { kind: "noneReadable" }
  | { kind: "failed" };

type ImagesState = {
  phase: ImagesPhase;
  items: PickedImage[];
  size: PageSizeOption;
  /** Android: the photo picker, then the screen. Elsewhere the screen's file input calls `addFiles`. */
  pickNative: () => Promise<void>;
  addFiles: (files: readonly File[]) => void;
  move: (id: string, delta: -1 | 1) => void;
  remove: (id: string) => void;
  setSize: (size: PageSizeOption) => void;
  close: () => void;
  create: (title: string) => Promise<ImagesResult>;
};

/** Android picks natively; iOS and desktop through `<input type="file">`. */
export const nativePicker = platform === "android";

let nextId = 0;
const newId = () => `img-${String(nextId++)}`;

/** Grid thumbnails: long side in px (3 columns on a phone, at 2–3×). */
const THUMB_PX = 240;

/**
 * A small thumbnail (blob URL) decoded at thumbnail size: twenty 12-MP photos shown as they
 * are would make the WebView decode ~1 GB of pixels. Null when this WebView cannot decode the
 * format (the tile then shows a placeholder; the engine may still read a JPEG).
 */
async function thumbnail(blob: Blob): Promise<string | null> {
  try {
    const probe = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const scale = Math.min(1, THUMB_PX / Math.max(probe.width, probe.height));
    const width = Math.max(1, Math.round(probe.width * scale));
    const height = Math.max(1, Math.round(probe.height * scale));
    probe.close();
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image", resizeWidth: width, resizeHeight: height, resizeQuality: "medium" });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    bitmap.close();
    const small = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", 0.8);
    });
    canvas.width = 0;
    canvas.height = 0;
    return small ? URL.createObjectURL(small) : null;
  } catch {
    return null;
  }
}

function disposeAll(items: readonly PickedImage[]): void {
  for (const item of items) item.dispose();
}

export const useImages = create<ImagesState>()((set, get) => ({
  phase: { step: "closed" },
  items: [],
  size: "fit",

  pickNative: async () => {
    if (get().phase.step === "creating") return;
    const before = get().phase.step;
    set({ phase: { step: "picking" } });
    try {
      const pick = await api.pickPhotos();
      if (pick.status === "cancelled") {
        set({ phase: before === "edit" ? { step: "edit" } : { step: "closed" } });
        return;
      }
      const staged: PickedImage[] = [];
      for (const source of pick.sources) {
        try {
          const path = await api.stagePhoto(source);
          const url = assetUrl(path);
          const thumb = await thumbnail(await (await fetch(url)).blob());
          staged.push({
            id: newId(),
            thumb,
            mime: "",
            read: async () => (await fetch(url)).arrayBuffer(),
            dispose: () => {
              if (thumb) URL.revokeObjectURL(thumb);
              void api.unstage(path).catch(() => undefined);
            },
          });
        } catch (err) {
          // A photo that cannot be read (not an image, too large) is left out.
          if (!(err instanceof ApiError)) throw err;
        }
      }
      set((s) => ({ items: [...s.items, ...staged], phase: { step: "edit" } }));
    } catch {
      set({ phase: before === "edit" ? { step: "edit" } : { step: "closed" } });
    }
  },

  addFiles: (files) => {
    if (files.length === 0) return;
    const added: PickedImage[] = files.map((file) => ({
      id: newId(),
      thumb: null,
      mime: file.type,
      read: () => file.arrayBuffer(),
      dispose: () => undefined,
    }));
    set((s) => ({ items: [...s.items, ...added], phase: { step: "edit" } }));
    // Thumbnails one at a time, after the screen is up.
    void (async () => {
      for (const [i, item] of added.entries()) {
        const file = files[i];
        if (!file) continue;
        const thumb = await thumbnail(file);
        if (!thumb) continue;
        const live = get().items.some((it) => it.id === item.id);
        if (!live) {
          URL.revokeObjectURL(thumb);
          continue;
        }
        set((s) => ({
          items: s.items.map((it) =>
            it.id === item.id ? { ...it, thumb, dispose: () => URL.revokeObjectURL(thumb) } : it,
          ),
        }));
      }
    })();
  },

  move: (id, delta) => {
    const items = [...get().items];
    const from = items.findIndex((i) => i.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= items.length) return;
    const [item] = items.splice(from, 1);
    if (item) items.splice(to, 0, item);
    set({ items });
  },

  remove: (id) => {
    const item = get().items.find((i) => i.id === id);
    item?.dispose();
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  },

  setSize: (size) => set({ size }),

  close: () => {
    if (get().phase.step === "creating") return;
    disposeAll(get().items);
    set({ items: [], phase: { step: "closed" } });
  },

  create: async (title) => {
    const { items, size, phase } = get();
    if (items.length === 0 || phase.step === "creating") return { kind: "failed" };
    set({ phase: { step: "creating", done: 0, total: items.length } });
    let skipped = 0;
    try {
      const session = await getEngine().createImagePdf();
      let pages = 0;
      try {
        for (const [index, item] of items.entries()) {
          try {
            pages = await session.add(await item.read(), item.mime, size);
          } catch (err) {
            if (!(err instanceof EngineError) || err.code !== "format") throw err;
            skipped += 1;
          }
          set({ phase: { step: "creating", done: index + 1, total: items.length } });
        }
      } catch (err) {
        await session.discard();
        throw err;
      }
      if (pages === 0) {
        await session.discard();
        set({ phase: { step: "edit" } });
        return { kind: "noneReadable" };
      }
      const bytes = await session.finish();
      const outcome = await api.importUpload(await upload(bytes), title);
      disposeAll(items);
      set({ items: [], phase: { step: "closed" } });
      return { kind: "created", document: outcome.document, skipped };
    } catch (err) {
      console.warn("selis: images to PDF failed", err);
      set({ phase: { step: "edit" } });
      return { kind: "failed" };
    }
  },
}));
