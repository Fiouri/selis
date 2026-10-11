import { describe, expect, it } from "vitest";
import type { ImportOutcome } from "../../lib/api";
import { IDLE, type ImportEvent, importReducer, type ImportState, isBusy } from "./importMachine";

const outcome = { document: { id: "d1" }, duplicate: false } as unknown as ImportOutcome;

function run(events: ImportEvent[], from: ImportState = IDLE): ImportState {
  return events.reduce(importReducer, from);
}

describe("import state machine", () => {
  it("idle → picking → importing → done → idle", () => {
    const picking = run([{ type: "start" }]);
    expect(picking).toEqual({ status: "picking", attempt: 1 });
    const importing = importReducer(picking, { type: "picked", attempt: 1, source: "content://x" });
    expect(importing).toEqual({ status: "importing", attempt: 1, source: "content://x" });
    const done = importReducer(importing, { type: "imported", attempt: 1, outcome });
    expect(done).toEqual({ status: "done", attempt: 1, outcome });
    expect(importReducer(done, { type: "reset" })).toEqual({ status: "idle", attempt: 1 });
  });

  it("picking → cancelled → idle (user backed out of the picker)", () => {
    const cancelled = run([{ type: "start" }, { type: "cancelled", attempt: 1 }]);
    expect(cancelled.status).toBe("cancelled");
    expect(importReducer(cancelled, { type: "reset" }).status).toBe("idle");
  });

  it("picking → error when the picker fails or its result is lost", () => {
    const failed = run([{ type: "start" }, { type: "pickFailed", attempt: 1, error: "boom" }]);
    expect(failed).toMatchObject({ status: "error", kind: "failed", source: null });
    const lost = run([{ type: "start" }, { type: "resultLost", attempt: 1 }]);
    expect(lost).toMatchObject({ status: "error", kind: "resultLost", source: null });
  });

  it("importing → error on failure and on timeout, keeping the source for retry", () => {
    const base: ImportEvent[] = [{ type: "start" }, { type: "picked", attempt: 1, source: "s" }];
    expect(run([...base, { type: "importFailed", attempt: 1, error: "io", timedOut: false }])).toMatchObject({
      status: "error",
      kind: "failed",
      source: "s",
    });
    expect(run([...base, { type: "importFailed", attempt: 1, error: null, timedOut: true }])).toMatchObject({
      status: "error",
      kind: "timeout",
      source: "s",
    });
  });

  it("retry re-imports the same source, or reopens the picker when there is none", () => {
    const timedOut = run([
      { type: "start" },
      { type: "picked", attempt: 1, source: "s" },
      { type: "importFailed", attempt: 1, error: null, timedOut: true },
      { type: "retry" },
    ]);
    expect(timedOut).toEqual({ status: "importing", attempt: 2, source: "s" });
    const lost = run([{ type: "start" }, { type: "resultLost", attempt: 1 }, { type: "retry" }]);
    expect(lost).toEqual({ status: "picking", attempt: 2 });
  });

  it("error → idle on dismiss", () => {
    const error = run([{ type: "start" }, { type: "resultLost", attempt: 1 }]);
    expect(importReducer(error, { type: "reset" })).toEqual({ status: "idle", attempt: 1 });
  });

  it("ignores events from a superseded attempt (late picker result after a retry)", () => {
    const retrying = run([{ type: "start" }, { type: "resultLost", attempt: 1 }, { type: "retry" }]);
    expect(importReducer(retrying, { type: "picked", attempt: 1, source: "late" })).toBe(retrying);
    expect(importReducer(retrying, { type: "picked", attempt: 2, source: "s" }).status).toBe("importing");
  });

  it("never starts a second picker or resets while busy", () => {
    const picking = run([{ type: "start" }]);
    expect(importReducer(picking, { type: "start" })).toBe(picking);
    expect(importReducer(picking, { type: "reset" })).toBe(picking);
    const importing = importReducer(picking, { type: "picked", attempt: 1, source: "s" });
    expect(importReducer(importing, { type: "start" })).toBe(importing);
  });

  it("ignores events that do not apply to the current state", () => {
    expect(importReducer(IDLE, { type: "imported", attempt: 0, outcome })).toBe(IDLE);
    expect(importReducer(IDLE, { type: "retry" })).toBe(IDLE);
    const picking = run([{ type: "start" }]);
    expect(importReducer(picking, { type: "imported", attempt: 1, outcome })).toBe(picking);
  });

  it("every busy state has an exit", () => {
    const picking = run([{ type: "start" }]);
    const importing = importReducer(picking, { type: "picked", attempt: 1, source: "s" });
    for (const [state, exits] of [
      [picking, ["picked", "cancelled", "pickFailed", "resultLost"]],
      [importing, ["imported", "importFailed"]],
    ] as const) {
      expect(isBusy(state)).toBe(true);
      for (const type of exits) {
        const event = { type, attempt: 1, source: "s", outcome, error: null, timedOut: false } as ImportEvent;
        expect(importReducer(state, event)).not.toBe(state);
      }
    }
  });

  it("external (Open with) skips the picker, keeps the name for retry, never interrupts", () => {
    const importing = importReducer(IDLE, { type: "external", source: "content://shared", name: "Report.pdf" });
    expect(importing).toEqual({ status: "importing", attempt: 1, source: "content://shared", name: "Report.pdf" });
    expect(importReducer(importing, { type: "external", source: "content://other", name: null })).toBe(importing);
    const failed = importReducer(importing, { type: "importFailed", attempt: 1, error: "io", timedOut: false });
    expect(failed).toMatchObject({ status: "error", source: "content://shared", name: "Report.pdf" });
    expect(importReducer(failed, { type: "retry" })).toEqual({
      status: "importing",
      attempt: 2,
      source: "content://shared",
      name: "Report.pdf",
    });
    // A new shared document replaces a shown error.
    expect(importReducer(failed, { type: "external", source: "content://next", name: null })).toEqual({
      status: "importing",
      attempt: 2,
      source: "content://next",
    });
  });
});
