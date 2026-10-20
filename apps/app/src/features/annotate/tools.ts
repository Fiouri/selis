/**
 * Annotate tools and their settings (docs/design/p1-ui-brief.md §3). The
 * choices live for the app session, so coming back to annotate picks up where
 * the user left off.
 */
import type { Annotation, DocHandle } from "@selis/engine";
import { create } from "zustand";
import type { Command } from "./session";

/** "eraser" removes annotations; "erase" removes page content (ADR 0033). */
export type Tool = "highlight" | "underline" | "strikeout" | "pen" | "shapes" | "text" | "note" | "eraser" | "erase";
export type Shape = "square" | "circle" | "line" | "arrow";

export const TOOLS: readonly Tool[] = ["highlight", "underline", "strikeout", "pen", "shapes", "text", "note", "eraser", "erase"];
export const SHAPES: readonly Shape[] = ["square", "circle", "line", "arrow"];

/** Brief §3 swatches; black first for ink-like tools (text on white must stay readable). */
export const COLORS = {
  black: "#211f1a",
  yellow: "#f4c430",
  green: "#5fbf7f",
  pink: "#ef7fae",
  blue: "#6ea8f0",
  orange: "#f39a4a",
} as const;
export type ColorName = keyof typeof COLORS;

const MARKUP_COLORS: readonly ColorName[] = ["yellow", "green", "pink", "blue", "orange"];
const INK_COLORS: readonly ColorName[] = ["black", "yellow", "green", "pink", "blue", "orange"];

/** Swatches offered for a tool (none for the erasers). */
export function colorsFor(tool: Tool): readonly ColorName[] {
  if (tool === "eraser" || tool === "erase") return [];
  return tool === "highlight" || tool === "underline" || tool === "strikeout" || tool === "note" ? MARKUP_COLORS : INK_COLORS;
}

/** Highlight alpha from the brief; everything else is opaque. */
export const HIGHLIGHT_OPACITY = 0.42;
export const THICKNESS_RANGE = { min: 1, max: 12 } as const;
export const FONT_SIZE_RANGE = { min: 10, max: 36 } as const;

type ToolState = {
  tool: Tool;
  shape: Shape;
  colors: Record<Tool, ColorName>;
  /** Pen and shape stroke width, points. */
  thickness: number;
  fontSize: number;
  /** Tool sheet folded down to the tool row. */
  collapsed: boolean;
  setTool: (tool: Tool) => void;
  setShape: (shape: Shape) => void;
  setColor: (color: ColorName) => void;
  setThickness: (value: number) => void;
  setFontSize: (value: number) => void;
  toggleCollapsed: () => void;
};

export const useTools = create<ToolState>((set) => ({
  tool: "highlight",
  shape: "square",
  colors: {
    highlight: "yellow",
    underline: "blue",
    strikeout: "pink",
    pen: "black",
    shapes: "blue",
    text: "black",
    note: "yellow",
    eraser: "black",
    erase: "black",
  },
  thickness: 3,
  fontSize: 14,
  collapsed: false,
  setTool: (tool) => set({ tool }),
  setShape: (shape) => set({ shape }),
  setColor: (color) => set((s) => ({ colors: { ...s.colors, [s.tool]: color } })),
  setThickness: (thickness) => set({ thickness: clamp(thickness, THICKNESS_RANGE.min, THICKNESS_RANGE.max) }),
  setFontSize: (fontSize) => set({ fontSize: clamp(fontSize, FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max) }),
  toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
}));

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** /NM for a new annotation; Selis's own stamps carry a prefix so they are recognised when read back. */
export function newAnnotationId(kind: Annotation["kind"]): string {
  const id = crypto.randomUUID();
  if (kind === "text") return `selis-text-${id}`;
  if (kind === "signature") return `selis-sig-${id}`;
  return id;
}

/** Adds an annotation; undo removes it. */
export function addCommand(doc: DocHandle, annotation: Annotation, tool: string): Command {
  return {
    tool,
    apply: async () => {
      await doc.addAnnotation(annotation);
    },
    revert: async () => {
      await doc.removeAnnotation(annotation.page, annotation.id);
    },
  };
}

/** Removes an annotation; undo puts the same one back (same id). */
export function removeCommand(doc: DocHandle, annotation: Annotation, tool: string): Command {
  return {
    tool,
    apply: async () => {
      await doc.removeAnnotation(annotation.page, annotation.id);
    },
    revert: async () => {
      await doc.addAnnotation(annotation);
    },
  };
}

/** Replaces an annotation with a new version of itself (same id). */
export function replaceCommand(doc: DocHandle, before: Annotation, after: Annotation, tool: string): Command {
  return {
    tool,
    apply: async () => {
      await doc.addAnnotation(after);
    },
    revert: async () => {
      await doc.addAnnotation(before);
    },
  };
}
