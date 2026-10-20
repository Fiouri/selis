/**
 * Erase tool state (ADR 0033): the mode (brush, rectangle, object), the brush
 * size and fill choice, the strokes waiting for "Apply", and the object picked
 * for "Delete". Strokes are previews: they are session commands (undo / redo
 * one by one) that never touch the document until applied.
 */
import type { AreaAnnotations, DocHandle, PageObjectInfo, PageRect } from "@selis/engine";
import { create } from "zustand";
import type { Command } from "../annotate/session";
import type { BrushSize } from "./geometry";

export type EraseMode = "brush" | "rect" | "object";
export const ERASE_MODES: readonly EraseMode[] = ["brush", "rect", "object"];
export const BRUSH_SIZES: readonly BrushSize[] = ["s", "m", "l"];
export type FillMode = "white" | "match" | "pick";
export const FILL_MODES: readonly FillMode[] = ["white", "match", "pick"];

export const WHITE = "#ffffff";

export type Stroke = {
  readonly id: string;
  readonly page: number;
  readonly rects: readonly PageRect[];
  /** #rrggbb painted over the area. */
  readonly fill: string;
};

/** The object picked in object mode: what is under the finger, and which of it is chosen. */
export type Selection = { readonly page: number; readonly candidates: readonly PageObjectInfo[]; readonly at: number };

type EraseState = {
  mode: EraseMode;
  brush: BrushSize;
  fill: FillMode;
  /** The eyedropper's colour (null until the user picks one). */
  picked: string | null;
  /** The next tap on the page picks the fill colour. */
  picking: boolean;
  strokes: readonly Stroke[];
  selection: Selection | null;
  setMode: (mode: EraseMode) => void;
  setBrush: (brush: BrushSize) => void;
  setFill: (fill: FillMode) => void;
  setPicked: (color: string) => void;
  setPicking: (picking: boolean) => void;
  setStrokes: (strokes: readonly Stroke[]) => void;
  select: (selection: Selection | null) => void;
  /** Leaves the tool: pending strokes and the selection go. */
  reset: () => void;
};

export const useEraseState = create<EraseState>((set) => ({
  mode: "brush",
  brush: "m",
  fill: "white",
  picked: null,
  picking: false,
  strokes: [],
  selection: null,
  setMode: (mode) => set({ mode, selection: null, picking: false }),
  setBrush: (brush) => set({ brush }),
  setFill: (fill) => set((s) => ({ fill, picking: fill === "pick" && s.picked === null })),
  setPicked: (picked) => set({ picked, picking: false, fill: "pick" }),
  setPicking: (picking) => set({ picking }),
  setStrokes: (strokes) => set({ strokes }),
  select: (selection) => set({ selection }),
  reset: () => set({ strokes: [], selection: null, picking: false }),
}));

export function newStrokeId(): string {
  return `selis-erase-${crypto.randomUUID()}`;
}

/** The selected object, if any. */
export function selectedObject(s: Selection | null): PageObjectInfo | null {
  return s ? (s.candidates[s.at] ?? null) : null;
}

/** Adds a stroke to the preview; undo takes it away. The document does not change. */
export function strokeCommand(stroke: Stroke): Command {
  const store = useEraseState.getState;
  return {
    tool: "erase:stroke",
    preview: true,
    apply: () => {
      store().setStrokes([...store().strokes, stroke]);
      return Promise.resolve();
    },
    revert: () => {
      store().setStrokes(store().strokes.filter((s) => s.id !== stroke.id));
      return Promise.resolve();
    },
  };
}

/** Strokes grouped by page and fill colour: one erase per group. */
export function eraseGroups(strokes: readonly Stroke[]): { page: number; fill: string; rects: PageRect[] }[] {
  const groups = new Map<string, { page: number; fill: string; rects: PageRect[] }>();
  for (const s of strokes) {
    const key = `${s.page}:${s.fill}`;
    let g = groups.get(key);
    if (!g) {
      g = { page: s.page, fill: s.fill, rects: [] };
      groups.set(key, g);
    }
    g.rects.push(...s.rects);
  }
  return [...groups.values()].sort((a, b) => a.page - b.page);
}

/** Adds up what erases or redactions did to the annotations over their areas. */
export function addAnnotations(a: AreaAnnotations, b: AreaAnnotations): AreaAnnotations {
  return { removed: a.removed + b.removed, clipped: a.clipped + b.clipped };
}

/** The note saved on the version (ADR 0033 amendment): null when no annotation was touched. */
export function versionNote(a: AreaAnnotations): string | null {
  if (a.removed === 0 && a.clipped === 0) return null;
  return JSON.stringify({ annotationsRemoved: a.removed, annotationsClipped: a.clipped });
}

/**
 * Erases every pending stroke from the document (one page / colour at a time).
 * Undo reloads the document from before and brings the strokes back.
 * `onErased` gets what happened to the annotations over the areas.
 */
export function applyEraseCommand(doc: DocHandle, onErased?: (annotations: AreaAnnotations) => void): Command {
  let before: ArrayBuffer | null = null;
  let strokes: readonly Stroke[] = [];
  return {
    tool: "erase:apply",
    apply: async () => {
      strokes = useEraseState.getState().strokes;
      let first: ArrayBuffer | null = null;
      let annotations: AreaAnnotations = { removed: 0, clipped: 0 };
      try {
        for (const g of eraseGroups(strokes)) {
          const result = await doc.erase({ page: g.page, rects: g.rects, fill: g.fill });
          first ??= result.before;
          annotations = addAnnotations(annotations, result.annotations);
        }
      } catch (err) {
        // All or nothing: a group that failed undoes the ones before it.
        if (first) await doc.reload(first.slice(0));
        throw err;
      }
      before ??= first;
      useEraseState.getState().setStrokes([]);
      onErased?.(annotations);
    },
    revert: async () => {
      if (!before) return;
      await doc.reload(before.slice(0));
      useEraseState.getState().setStrokes(strokes);
    },
  };
}

/** Removes one page object. Undo reloads the document from before. */
export function deleteObjectCommand(doc: DocHandle, page: number, object: PageObjectInfo): Command {
  let before: ArrayBuffer | null = null;
  return {
    tool: "erase:object",
    apply: async () => {
      const result = await doc.deleteObject(page, object);
      before ??= result.before;
      useEraseState.getState().select(null);
    },
    revert: async () => {
      if (!before) return;
      await doc.reload(before.slice(0));
    },
  };
}
