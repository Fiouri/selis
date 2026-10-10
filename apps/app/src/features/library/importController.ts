/**
 * Runs the import state machine (importMachine.ts): starts the picker, guards
 * against a lost picker result, imports with a deadline, and reports the outcome.
 * Dependencies are injected so every transition is unit-testable.
 */
import type { ImportOutcome } from "../../lib/api";
import { IDLE, type ImportEvent, importReducer, type ImportState } from "./importMachine";

/** Rust cancels `import_document` after 30 s; the UI waits slightly longer for that reply. */
export const IMPORT_TIMEOUT_MS = 32_000;
/**
 * After the app is back in front, the picker reply should arrive within this
 * window; otherwise the outcome is fetched again from Rust (`recoverPick`).
 */
export const PICKER_RESULT_GRACE_MS = 2_000;

export type ImportErrorState = Extract<ImportState, { status: "error" }>;

export type ImportDeps = {
  /** Opens the picker; resolves to a source or null (cancelled). */
  pick: (requestId: number) => Promise<string | null>;
  /** Re-fetches a finished picker outcome: source, null (cancelled) or undefined (none). */
  recoverPick: (requestId: number) => Promise<string | null | undefined>;
  importDocument: (source: string) => Promise<ImportOutcome>;
  isTimeoutError: (error: unknown) => boolean;
  warmUp: () => void;
  /** Calls `onLeave` when the app goes to the background and `onReturn` when it is back. */
  watchForeground: (onLeave: () => void, onReturn: () => void) => () => void;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  timeoutMs: number;
  pickerGraceMs: number;
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
  /** Random per page load, so a Rust-side outcome from an earlier page is never mistaken for ours. */
  private readonly requestBase = Math.floor(Math.random() * 1_000_000) * 1_000;

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
    const requestId = this.requestBase + attempt;
    deps.warmUp(); // the picker is open for seconds: get the PDF engine ready meanwhile

    const settle = (source: string | null) =>
      this.send(source === null ? { type: "cancelled", attempt } : { type: "picked", attempt, source });

    // Watchdog for a lost picker reply: once the app is back in front, the answer
    // should arrive within the grace period. If not, ask Rust for the stored
    // outcome with a fresh call; only if that has nothing (or never answers) is
    // the result really lost.
    let timer: number | null = null;
    const clear = () => {
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
    };
    const recover = async () => {
      timer = deps.setTimer(() => this.send({ type: "resultLost", attempt }), deps.pickerGraceMs);
      try {
        const outcome = await deps.recoverPick(requestId);
        if (outcome === undefined) this.send({ type: "resultLost", attempt });
        else settle(outcome);
      } catch {
        this.send({ type: "resultLost", attempt });
      }
    };
    const stopWatching = deps.watchForeground(clear, () => {
      clear();
      timer = deps.setTimer(() => {
        timer = null;
        void recover();
      }, deps.pickerGraceMs);
    });
    this.cleanups.push(() => {
      stopWatching();
      clear();
    });

    void (async () => {
      try {
        settle(await deps.pick(requestId));
      } catch (error) {
        this.send({ type: "pickFailed", attempt, error });
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
