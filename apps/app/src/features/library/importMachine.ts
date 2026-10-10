/**
 * Import flow as an explicit state machine. Every busy state has an exit, so the
 * UI can never wait forever:
 *
 *   idle ──start──▶ picking ──picked──▶ importing ──imported──▶ done
 *                     │  │                  │ └──failed/timeout──▶ error
 *                     │  └─cancelled──▶ cancelled                   │
 *                     └──failed / resultLost──▶ error ◀─────────────┘
 *   done | error | cancelled ──reset──▶ idle ;  error ──retry──▶ importing (same source)
 *
 * `resultLost`: the picker's IPC reply never reached the WebView and the IPC
 * layer could not recover it either (docs/adr/0005-ipc-reliability.md).
 */
import type { ImportOutcome } from "../../lib/api";

export type ImportErrorKind = "timeout" | "resultLost" | "failed";

export type ImportState =
  | { readonly status: "idle"; readonly attempt: number }
  | { readonly status: "picking"; readonly attempt: number }
  | { readonly status: "importing"; readonly attempt: number; readonly source: string }
  | { readonly status: "done"; readonly attempt: number; readonly outcome: ImportOutcome }
  | {
      readonly status: "error";
      readonly attempt: number;
      readonly kind: ImportErrorKind;
      readonly error: unknown;
      /** Source to retry with; absent when the picker itself failed. */
      readonly source: string | null;
    }
  | { readonly status: "cancelled"; readonly attempt: number };

export type ImportEvent =
  | { readonly type: "start" }
  | { readonly type: "picked"; readonly attempt: number; readonly source: string }
  | { readonly type: "cancelled"; readonly attempt: number }
  | { readonly type: "pickFailed"; readonly attempt: number; readonly error: unknown }
  | { readonly type: "resultLost"; readonly attempt: number }
  | { readonly type: "imported"; readonly attempt: number; readonly outcome: ImportOutcome }
  | { readonly type: "importFailed"; readonly attempt: number; readonly error: unknown; readonly timedOut: boolean }
  | { readonly type: "retry" }
  | { readonly type: "reset" };

export const IDLE: ImportState = { status: "idle", attempt: 0 };

export function isBusy(state: ImportState): boolean {
  return state.status === "picking" || state.status === "importing";
}

/**
 * Pure transition function. Events from a superseded attempt (e.g. a late picker
 * result after the user already retried) are ignored.
 */
export function importReducer(state: ImportState, event: ImportEvent): ImportState {
  if ("attempt" in event && event.attempt !== state.attempt) return state;

  switch (event.type) {
    case "start":
      // Never launch a second picker while one is open (Tauri keeps one result callback).
      return isBusy(state) ? state : { status: "picking", attempt: state.attempt + 1 };
    case "picked":
      return state.status === "picking" ? { status: "importing", attempt: state.attempt, source: event.source } : state;
    case "cancelled":
      return state.status === "picking" ? { status: "cancelled", attempt: state.attempt } : state;
    case "pickFailed":
      return state.status === "picking"
        ? { status: "error", attempt: state.attempt, kind: "failed", error: event.error, source: null }
        : state;
    case "resultLost":
      return state.status === "picking"
        ? { status: "error", attempt: state.attempt, kind: "resultLost", error: null, source: null }
        : state;
    case "imported":
      return state.status === "importing" ? { status: "done", attempt: state.attempt, outcome: event.outcome } : state;
    case "importFailed":
      return state.status === "importing"
        ? {
            status: "error",
            attempt: state.attempt,
            kind: event.timedOut ? "timeout" : "failed",
            error: event.error,
            source: state.source,
          }
        : state;
    case "retry":
      if (state.status !== "error") return state;
      // With a known source, retry the import itself; otherwise pick again.
      return state.source !== null
        ? { status: "importing", attempt: state.attempt + 1, source: state.source }
        : { status: "picking", attempt: state.attempt + 1 };
    case "reset":
      // The attempt counter is monotonic so late events from an old cycle stay ignored.
      return isBusy(state) ? state : { status: "idle", attempt: state.attempt };
  }
}
