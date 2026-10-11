/**
 * Page operations as undoable commands (P2c). The engine returns the
 * document's bytes from before each change; undo reloads them, redo applies the
 * same operation again. Extract / split make new library documents and leave
 * this one as it is (not commands: nothing here to undo).
 */
import type { DocHandle, PageOp } from "@selis/engine";
import { useSyncExternalStore } from "react";
import { api, type Document } from "../../lib/api";
import { upload } from "../../lib/save";
import type { Command } from "../annotate/session";

/** Re-renders when the document's list of pages changes. */
export function useDocStructure(doc: DocHandle | null): number {
  return useSyncExternalStore(
    (notify) => doc?.onStructureChange(notify) ?? (() => undefined),
    () => doc?.structureRevision() ?? 0,
  );
}

export function pageCommand(doc: DocHandle, op: PageOp): Command {
  let before: ArrayBuffer | null = null;
  return {
    tool: `pages:${op.op}`,
    apply: async () => {
      // `insertPdf` hands its bytes to the worker: send a copy, keep ours for redo.
      const sent: PageOp = op.op === "insertPdf" ? { ...op, bytes: op.bytes.slice(0) } : op;
      const snapshot = await doc.editPages(sent);
      before ??= snapshot;
    },
    revert: async () => {
      if (!before) return;
      // `reload` takes the buffer: a copy, so undo can happen again after a redo.
      await doc.reload(before.slice(0));
    },
  };
}

/** "1–3, 5" for the title of an extracted document (1-based page numbers). */
export function pageRanges(indices: readonly number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b).map((i) => i + 1);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i] as number;
    let end = start;
    while (sorted[i + 1] === end + 1) {
      end++;
      i++;
    }
    parts.push(start === end ? String(start) : `${start}–${end}`);
  }
  return parts.join(", ");
}

/** Makes the pages `indices` a new library document titled `title`. */
export async function extractToLibrary(doc: DocHandle, indices: readonly number[], title: string): Promise<Document> {
  const bytes = await doc.extractPages(indices);
  const uploadId = await upload(bytes);
  const outcome = await api.importUpload(uploadId, title);
  return outcome.document;
}

/** Where `slot` (0…n, a gap between pages) puts moved pages, in FPDF_MovePages terms. */
export function moveTarget(selected: readonly number[], slot: number): number {
  const before = selected.filter((i) => i < slot).length;
  return slot - before;
}

/** True when dropping `selected` at `slot` would leave the order as it is. */
export function isNoOpMove(selected: readonly number[], slot: number): boolean {
  const sorted = [...selected].sort((a, b) => a - b);
  const contiguous = sorted.every((v, i) => i === 0 || v === (sorted[i - 1] as number) + 1);
  const first = sorted[0] ?? 0;
  const last = sorted[sorted.length - 1] ?? 0;
  return contiguous && slot >= first && slot <= last + 1;
}
