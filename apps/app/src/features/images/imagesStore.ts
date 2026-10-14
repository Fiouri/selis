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
  /** Shown in the grid (blob or asset URL). */
  readonly thumb: string;
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
          staged.push({
            id: newId(),
            thumb: url,
            mime: "",
            read: async () => (await fetch(url)).arrayBuffer(),
            dispose: () => void api.unstage(path).catch(() => undefined),
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
    const added: PickedImage[] = files.map((file) => {
      const url = URL.createObjectURL(file);
      return {
        id: newId(),
        thumb: url,
        mime: file.type,
        read: () => file.arrayBuffer(),
        dispose: () => URL.revokeObjectURL(url),
      };
    });
    if (added.length === 0 && get().items.length === 0) return;
    set((s) => ({ items: [...s.items, ...added], phase: { step: "edit" } }));
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
