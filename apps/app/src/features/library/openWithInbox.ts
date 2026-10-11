/**
 * Documents handed over by other apps ("Open with" / share). Rust keeps them
 * in a queue (commands/open_with.rs) until they are imported here through the
 * normal import state machine, one at a time, then dismissed.
 *
 * `check()` runs on startup and whenever the app is back in front: on Android
 * a warm "Open with" arrives as onNewIntent right before the activity resumes.
 */
import type { ImportOutcome, PendingOpen } from "../../lib/api";
import type { ImportErrorState, ImportHandlers } from "./importController";

export type OpenWithDeps = {
  pending: () => Promise<PendingOpen[]>;
  dismiss: (id: string) => Promise<unknown>;
  importSource: (source: string, name: string | null, handlers: ImportHandlers) => boolean;
  /** Notifies when the import controller changes state (so a busy one can be retried). */
  subscribe: (listener: () => void) => () => void;
  /** One document imported; `last` is true when nothing else is waiting. */
  onImported: (outcome: ImportOutcome, batch: { last: boolean; count: number }) => void;
  onFailed: (state: ImportErrorState) => void;
  log: (message: string, error: unknown) => void;
};

export class OpenWithInbox {
  private readonly deps: OpenWithDeps;
  private readonly seen = new Set<string>();
  private readonly queue: PendingOpen[] = [];
  private active: PendingOpen | null = null;
  private checking = false;
  private stopWaiting: (() => void) | null = null;
  /** Imported in the current batch (reset once the queue runs dry). */
  private imported = 0;

  constructor(deps: OpenWithDeps) {
    this.deps = deps;
  }

  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const item of await this.deps.pending()) {
        if (this.seen.has(item.id)) continue;
        this.seen.add(item.id);
        this.queue.push(item);
      }
    } catch (err) {
      // Asked again on the next resume; reading consumes nothing.
      this.deps.log("selis: could not read shared documents", err);
    } finally {
      this.checking = false;
    }
    this.pump();
  }

  dispose(): void {
    this.stopWaiting?.();
    this.stopWaiting = null;
  }

  private pump(): void {
    if (this.active || this.stopWaiting) return;
    const next = this.queue[0];
    if (!next) return;
    const started = this.deps.importSource(next.source, next.name, {
      onDone: (outcome) => {
        this.finish(next, outcome);
      },
      onError: (state) => {
        this.fail(next, state);
      },
    });
    if (started) {
      this.queue.shift();
      this.active = next;
      return;
    }
    // The user is picking or importing: try again when that changes.
    const unsubscribe = this.deps.subscribe(() => {
      unsubscribe();
      this.stopWaiting = null;
      this.pump();
    });
    this.stopWaiting = unsubscribe;
  }

  private finish(item: PendingOpen, outcome: ImportOutcome): void {
    void this.deps.dismiss(item.id);
    if (this.active?.id === item.id) this.active = null;
    this.imported += 1;
    const last = this.queue.length === 0;
    this.deps.onImported(outcome, { last, count: this.imported });
    if (last) this.imported = 0;
    this.pump();
  }

  private fail(item: PendingOpen, state: ImportErrorState): void {
    void this.deps.dismiss(item.id);
    if (this.active?.id === item.id) this.active = null;
    this.deps.onFailed(state);
    if (this.queue.length === 0) this.imported = 0;
    this.pump();
  }
}
