/**
 * One editing session on an open document (docs/SPEC.md, storage rules):
 *
 * - Every edit is a command with an inverse, kept on an undo/redo stack for the
 *   life of the open document (the session survives leaving the annotate mode).
 * - 3 s after the last edit the document is autosaved as the working copy
 *   (crash recovery), off the version history.
 * - `commit()` turns the working copy into the next version. The viewer calls it
 *   when the user finishes editing and when the document is closed.
 *
 * All engine and IPC work runs through one queue, so a save always sees the
 * edits made before it and never overlaps another save.
 */
import type { DocHandle } from "@selis/engine";
import { api, type SavedVersion, type VersionLabel } from "../../lib/api";
import { saveWorkingCopy } from "../../lib/save";

export const AUTOSAVE_IDLE_MS = 3_000;

export type SaveStatus =
  /** Nothing to save: the document is the current version. */
  | "saved"
  /** Edits waiting for the autosave timer, or being written. */
  | "saving"
  /** Autosaved as the working copy (safe on disk, not a version yet). */
  | "autosaved"
  | "error";

export type Command = {
  /** Which tool made the edit (undo/redo history per tool). */
  readonly tool: string;
  /**
   * Changes only what is shown over the page (an erase stroke waiting for
   * "Apply", ADR 0033), not the document: undoable, nothing to autosave.
   */
  readonly preview?: boolean;
  apply(): Promise<void>;
  revert(): Promise<void>;
};

export type SessionState = {
  readonly status: SaveStatus;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Tool of the edit that undo would revert, if any. */
  readonly undoTool: string | null;
};

type Deps = {
  saveWorkingCopy: typeof saveWorkingCopy;
  saveVersion: (documentId: string, label: VersionLabel) => Promise<SavedVersion>;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
};

const defaultDeps: Deps = {
  saveWorkingCopy,
  saveVersion: (documentId, label) => api.saveVersion(documentId, label),
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (id) => window.clearTimeout(id),
};

export class EditSession {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private timer: number | null = null;
  /** Edits since the last autosave. */
  private dirty = false;
  /** A working copy exists that is not a version yet. */
  private pendingVersion = false;
  private status: SaveStatus = "saved";
  private snapshot: SessionState;
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly doc: DocHandle,
    private readonly documentId: string,
    /** BLAKE3 of the version the edits apply to. */
    private base: string,
    private readonly deps: Deps = defaultDeps,
    /** Told about every new version (library refresh, thumbnail). */
    private readonly onVersion: (saved: SavedVersion) => void = () => undefined,
  ) {
    this.snapshot = this.computeState();
  }

  get state(): SessionState {
    return this.snapshot;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): SessionState => this.snapshot;

  private computeState(): SessionState {
    return {
      status: this.status,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoTool: this.undoStack[this.undoStack.length - 1]?.tool ?? null,
    };
  }

  private emit(): void {
    this.snapshot = this.computeState();
    for (const listener of this.listeners) listener();
  }

  private setStatus(status: SaveStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit();
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    const run = (async () => {
      await previous;
      return task();
    })();
    // The chain survives failures; callers still see their own task's error.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Read through a method: edits queued during an await can set it. */
  private hasNewEdits(): boolean {
    return this.dirty;
  }

  private changed(): void {
    this.dirty = true;
    this.setStatus("saving");
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.autosave().catch(() => undefined);
    }, AUTOSAVE_IDLE_MS);
  }

  /** Applies an edit and records it for undo. */
  run(command: Command): Promise<void> {
    return this.enqueue(async () => {
      await command.apply();
      this.undoStack.push(command);
      this.redoStack = [];
      if (!command.preview) this.changed();
      this.emit();
    });
  }

  undo(): Promise<void> {
    return this.enqueue(async () => {
      const command = this.undoStack.pop();
      if (!command) return;
      try {
        await command.revert();
      } catch (err) {
        this.undoStack.push(command);
        throw err;
      }
      this.redoStack.push(command);
      if (!command.preview) this.changed();
      this.emit();
    });
  }

  redo(): Promise<void> {
    return this.enqueue(async () => {
      const command = this.redoStack.pop();
      if (!command) return;
      try {
        await command.apply();
      } catch (err) {
        this.redoStack.push(command);
        throw err;
      }
      this.undoStack.push(command);
      if (!command.preview) this.changed();
      this.emit();
    });
  }

  /** Writes the working copy now if there are edits since the last one. */
  autosave(): Promise<void> {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    return this.enqueue(async () => {
      if (!this.dirty || this.disposed) return;
      this.dirty = false;
      try {
        const bytes = await this.doc.save();
        await this.deps.saveWorkingCopy(this.documentId, this.base, bytes);
        this.pendingVersion = true;
        if (!this.hasNewEdits()) this.setStatus("autosaved");
      } catch (err) {
        this.dirty = true;
        this.setStatus("error");
        throw err;
      }
    });
  }

  /**
   * Makes the edits so far a version (autosaving first), labelled `label`
   * ("erase" after the Erase tool, ADR 0033). Resolves null when there was
   * nothing new to save.
   */
  async commit(label: VersionLabel = "manual"): Promise<SavedVersion | null> {
    await this.autosave();
    return this.enqueue(async () => {
      if (!this.pendingVersion) {
        if (!this.dirty) this.setStatus("saved");
        return null;
      }
      this.setStatus("saving");
      try {
        const saved = await this.deps.saveVersion(this.documentId, label);
        this.pendingVersion = false;
        this.base = saved.document.blake3;
        this.setStatus(this.dirty ? "saving" : "saved");
        this.onVersion(saved);
        return saved;
      } catch (err) {
        this.setStatus("error");
        throw err;
      }
    });
  }

  /** Stops the autosave timer; queued work still finishes. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}
