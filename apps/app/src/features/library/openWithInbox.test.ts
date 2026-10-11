import { describe, expect, it, vi } from "vitest";
import type { ImportOutcome, PendingOpen } from "../../lib/api";
import type { ImportErrorState, ImportHandlers } from "./importController";
import { OpenWithInbox, type OpenWithDeps } from "./openWithInbox";

const outcome = (id: string) => ({ document: { id }, duplicate: false }) as unknown as ImportOutcome;
const item = (id: string, name: string | null = null): PendingOpen => ({ id, source: `content://${id}`, name });

function setup(pending: PendingOpen[][]) {
  let busy = false;
  let started: Array<{ source: string; name: string | null; handlers: ImportHandlers }> = [];
  const listeners = new Set<() => void>();
  const deps: OpenWithDeps = {
    pending: vi.fn(() => Promise.resolve(pending.shift() ?? [])),
    dismiss: vi.fn(() => Promise.resolve(null)),
    importSource: vi.fn((source: string, name: string | null, handlers: ImportHandlers) => {
      if (busy) return false;
      busy = true;
      started.push({ source, name, handlers });
      return true;
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onImported: vi.fn(),
    onFailed: vi.fn(),
    log: vi.fn(),
  };
  const inbox = new OpenWithInbox(deps);
  const finishActive = (result: ImportOutcome | ImportErrorState) => {
    const active = started.shift();
    if (!active) throw new Error("nothing running");
    busy = false;
    if ("document" in result) active.handlers.onDone(result);
    else active.handlers.onError(result);
  };
  return {
    inbox,
    deps,
    finishActive,
    running: () => started.map((s) => s.source),
    setBusy: (value: boolean) => {
      busy = value;
      for (const l of [...listeners]) l();
    },
    reset: () => {
      started = [];
    },
  };
}

describe("OpenWithInbox", () => {
  it("imports a shared document with its name, dismisses it, reports a single-document batch", async () => {
    const t = setup([[item("a", "Report.pdf")]]);
    await t.inbox.check();
    expect(t.deps.importSource).toHaveBeenCalledWith("content://a", "Report.pdf", expect.anything());
    t.finishActive(outcome("doc-a"));
    expect(t.deps.dismiss).toHaveBeenCalledWith("a");
    expect(t.deps.onImported).toHaveBeenCalledWith(outcome("doc-a"), { last: true, count: 1 });
  });

  it("imports several one after another and counts the batch", async () => {
    const t = setup([[item("a"), item("b"), item("c")]]);
    await t.inbox.check();
    expect(t.running()).toEqual(["content://a"]);
    t.finishActive(outcome("1"));
    expect(t.deps.onImported).toHaveBeenLastCalledWith(outcome("1"), { last: false, count: 1 });
    t.finishActive(outcome("2"));
    t.finishActive(outcome("3"));
    expect(t.deps.onImported).toHaveBeenLastCalledWith(outcome("3"), { last: true, count: 3 });
    expect(t.deps.dismiss).toHaveBeenCalledTimes(3);
  });

  it("never imports the same pending id twice across checks", async () => {
    const t = setup([[item("a")], [item("a")]]);
    await t.inbox.check();
    await t.inbox.check();
    expect(t.deps.importSource).toHaveBeenCalledTimes(1);
  });

  it("waits while the user is importing, then continues", async () => {
    const t = setup([[item("a")]]);
    t.setBusy(true);
    await t.inbox.check();
    expect(t.running()).toEqual([]);
    t.setBusy(false);
    expect(t.running()).toEqual(["content://a"]);
  });

  it("a failure is shown, dismissed, and the next one still runs", async () => {
    const t = setup([[item("a"), item("b")]]);
    await t.inbox.check();
    const error = { status: "error", attempt: 1, kind: "failed", error: "io", source: "content://a" } as ImportErrorState;
    t.finishActive(error);
    expect(t.deps.onFailed).toHaveBeenCalledWith(error);
    expect(t.deps.dismiss).toHaveBeenCalledWith("a");
    expect(t.running()).toEqual(["content://b"]);
  });

  it("a lost or failed read is logged and retried on the next check", async () => {
    const t = setup([]);
    t.deps.pending = vi.fn().mockRejectedValueOnce(new Error("lost")).mockResolvedValueOnce([item("a")]);
    await t.inbox.check();
    expect(t.deps.log).toHaveBeenCalled();
    await t.inbox.check();
    expect(t.running()).toEqual(["content://a"]);
  });
});
