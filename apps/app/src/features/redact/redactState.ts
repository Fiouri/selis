/**
 * Redaction mode state (P2d): the tool, and the marks not applied yet.
 *
 * Marks are tracked here, not read back from every page (a 1000-page document
 * would have to load each page to count them). Every change goes through a
 * command that keeps the list in step, undo / redo included.
 */
import type { Annotation, AreaAnnotations, DocHandle } from "@selis/engine";
import { create } from "zustand";
import type { Command } from "../annotate/session";

export type RedactTool = "text" | "area" | "whiteout" | "eraser";
export const REDACT_TOOLS: readonly RedactTool[] = ["text", "area", "whiteout", "eraser"];

export type Mark = Extract<Annotation, { kind: "redact" }>;

type RedactState = {
  tool: RedactTool;
  /** Marks placed and not applied, by id. */
  marks: ReadonlyMap<string, Mark>;
  /** Applies in effect since the last saved version (undo takes one back). */
  applied: number;
  setTool: (tool: RedactTool) => void;
  setMarks: (marks: ReadonlyMap<string, Mark>) => void;
  addApplied: (delta: number) => void;
  resetApplied: () => void;
};

export const useRedactState = create<RedactState>((set) => ({
  tool: "text",
  marks: new Map(),
  applied: 0,
  setTool: (tool) => set({ tool }),
  setMarks: (marks) => set({ marks }),
  addApplied: (delta) => set((s) => ({ applied: Math.max(0, s.applied + delta) })),
  resetApplied: () => set({ applied: 0 }),
}));

function withMark(mark: Mark, present: boolean): void {
  const next = new Map(useRedactState.getState().marks);
  if (present) next.set(mark.id, mark);
  else next.delete(mark.id);
  useRedactState.getState().setMarks(next);
}

export function newMarkId(): string {
  return `selis-redact-${crypto.randomUUID()}`;
}

/** Places a mark; undo removes it. */
export function markCommand(doc: DocHandle, mark: Mark): Command {
  return {
    tool: "redact:mark",
    apply: async () => {
      await doc.addAnnotation(mark);
      withMark(mark, true);
    },
    revert: async () => {
      await doc.removeAnnotation(mark.page, mark.id);
      withMark(mark, false);
    },
  };
}

/** Removes a mark (eraser); undo puts it back. */
export function unmarkCommand(doc: DocHandle, mark: Mark): Command {
  return {
    tool: "redact:erase",
    apply: async () => {
      await doc.removeAnnotation(mark.page, mark.id);
      withMark(mark, false);
    },
    revert: async () => {
      await doc.addAnnotation(mark);
      withMark(mark, true);
    },
  };
}

/** Removes every pending mark at once (leaving the mode without applying). */
export function discardCommand(doc: DocHandle, marks: readonly Mark[]): Command {
  return {
    tool: "redact:discard",
    apply: async () => {
      for (const m of marks) await doc.removeAnnotation(m.page, m.id);
      const next = new Map(useRedactState.getState().marks);
      for (const m of marks) next.delete(m.id);
      useRedactState.getState().setMarks(next);
    },
    revert: async () => {
      for (const m of marks) await doc.addAnnotation(m);
      const next = new Map(useRedactState.getState().marks);
      for (const m of marks) next.set(m.id, m);
      useRedactState.getState().setMarks(next);
    },
  };
}

/**
 * Applies all marks: the content under them leaves the document. Undo reloads
 * the document from before (marks included) while it is open; the version
 * saved afterwards no longer has the content.
 */
export function applyCommand(doc: DocHandle, onApplied?: (count: number, annotations: AreaAnnotations) => void): Command {
  let before: ArrayBuffer | null = null;
  let applied: ReadonlyMap<string, Mark> = new Map();
  return {
    tool: "redact:apply",
    apply: async () => {
      applied = useRedactState.getState().marks;
      const result = await doc.applyRedactions();
      before ??= result.before;
      useRedactState.getState().setMarks(new Map());
      useRedactState.getState().addApplied(1);
      onApplied?.(result.applied, result.annotations);
    },
    revert: async () => {
      if (!before) return;
      await doc.reload(before.slice(0));
      useRedactState.getState().setMarks(applied);
      useRedactState.getState().addApplied(-1);
    },
  };
}
