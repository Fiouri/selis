/**
 * Runs the import state machine (importMachine.ts): starts the picker, imports
 * with a deadline, and reports the outcome. Lost IPC replies are recovered one
 * layer down (lib/ipc/reliable.ts); a reply that stays lost arrives here as an
 * error, so every state still has an exit. Dependencies are injected so every
 * transition is unit-testable.
 */
import type { ImportOutcome } from "../../lib/api";
import { IDLE, type ImportEvent, importReducer, type ImportState } from "./importMachine";

/** Rust cancels `import_document` after 30 s; the UI waits slightly longer for that reply. */
export const IMPORT_TIMEOUT_MS = 32_000;

export type ImportErrorState = Extract<ImportState, { status: "error" }>;

export type ImportDeps = {
  /** Opens the picker; resolves to a source or null (cancelled). */
  pick: () => Promise<string | null>;
  importDocument: (source: string) => Promise<ImportOutcome>;
  isTimeoutError: (error: unknown) => boolean;
  /** The picker's reply was lost and could not be recovered. */
  isLostResponse: (error: unknown) => boolean;
  warmUp: () => void;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  timeoutMs: number;
};

export type ImportHandlers = {
  onDone: (outcome: ImportOutcome) => void;
  onError: (state: ImportErrorState) => void;
};

export class ImportTimeoutError extends Error {
  constructor() {
    super("import timed out");
    this.name = "ImportTimeoutError";
  }
}

export class ImportController {
  private state: ImportState = IDLE;
  private readonly listeners = new Set<() => void>();
  private handlers: ImportHandlers | null = null;
  private cleanups: Array<() => void> = [];
  private readonly deps: ImportDeps;

  constructor(deps: ImportDeps) {
    this.deps = deps;
  }

  getState = (): ImportState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Opens the picker unless an import is already running. */
  start(handlers: ImportHandlers): void {
    this.handlers = handlers;
    this.send({ type: "start" });
  }

  /** After an error: re-imports the same file, or reopens the picker if none was picked. */
  retry(): void {
    this.send({ type: "retry" });
  }

  /** Back to idle after an error has been shown. */
  dismiss(): void {
    this.send({ type: "reset" });
  }

  private send(event: ImportEvent): void {
    const previous = this.state;
    const next = importReducer(previous, event);
    if (next === previous) return;
    this.state = next;
    this.runCleanups();
    for (const listener of this.listeners) listener();
    this.enter(next);
  }

  private enter(state: ImportState): void {
    switch (state.status) {
      case "picking":
        this.runPick(state.attempt);
        break;
      case "importing":
        this.runImport(state.attempt, state.source);
        break;
      case "done":
        this.handlers?.onDone(state.outcome);
        this.send({ type: "reset" });
        break;
      case "cancelled":
        this.send({ type: "reset" });
        break;
      case "error":
        this.handlers?.onError(state);
        break;
      case "idle":
        break;
    }
  }

  private runPick(attempt: number): void {
    const { deps } = this;
    deps.warmUp(); // the picker is open for seconds: get the PDF engine ready meanwhile
    void (async () => {
      try {
        const source = await deps.pick();
        this.send(source === null ? { type: "cancelled", attempt } : { type: "picked", attempt, source });
      } catch (error) {
        this.send(deps.isLostResponse(error) ? { type: "resultLost", attempt } : { type: "pickFailed", attempt, error });
      }
    })();
  }

  private runImport(attempt: number, source: string): void {
    const { deps } = this;
    const timer = deps.setTimer(
      () => this.send({ type: "importFailed", attempt, error: new ImportTimeoutError(), timedOut: true }),
      deps.timeoutMs,
    );
    this.cleanups.push(() => deps.clearTimer(timer));

    void (async () => {
      try {
        const outcome = await deps.importDocument(source);
        this.send({ type: "imported", attempt, outcome });
      } catch (error) {
        this.send({ type: "importFailed", attempt, error, timedOut: deps.isTimeoutError(error) });
      }
    })();
  }

  private runCleanups(): void {
    const cleanups = this.cleanups;
    this.cleanups = [];
    for (const cleanup of cleanups) cleanup();
  }
}
