import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportOutcome } from "../../lib/api";
import { ImportController, type ImportDeps, ImportTimeoutError } from "./importController";

const outcome = { document: { id: "d1" }, duplicate: false } as unknown as ImportOutcome;

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(overrides: Partial<ImportDeps> = {}) {
  let pick = deferred<string | null>();
  let imp = deferred<ImportOutcome>();
  let foreground: { leave: () => void; back: () => void } | null = null;
  const deps: ImportDeps = {
    pick: vi.fn(() => pick.promise),
    recoverPick: vi.fn(() => Promise.resolve(undefined)),
    importDocument: vi.fn(() => imp.promise),
    isTimeoutError: (e) => e instanceof ImportTimeoutError,
    warmUp: vi.fn(),
    watchForeground: (leave, back) => {
      foreground = { leave, back };
      return () => {
        foreground = null;
      };
    },
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id),
    timeoutMs: 30_000,
    pickerGraceMs: 2_000,
    ...overrides,
  };
  const handlers = { onDone: vi.fn(), onError: vi.fn() };
  const controller = new ImportController(deps);
  return {
    controller,
    deps,
    handlers,
    pick: () => pick,
    imp: () => imp,
    newPick: () => (pick = deferred()),
    newImport: () => (imp = deferred()),
    foreground: () => foreground,
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ImportController", () => {
  it("happy path: picker → import → done → idle, warming the engine", async () => {
    const t = setup();
    t.controller.start(t.handlers);
    expect(t.controller.getState().status).toBe("picking");
    expect(t.deps.warmUp).toHaveBeenCalled();
    t.pick().resolve("content://doc");
    await flush();
    expect(t.controller.getState().status).toBe("importing");
    expect(t.deps.importDocument).toHaveBeenCalledWith("content://doc");
    t.imp().resolve(outcome);
    await flush();
    expect(t.handlers.onDone).toHaveBeenCalledWith(outcome);
    expect(t.controller.getState().status).toBe("idle");
  });

  it("user cancel returns to idle without an error", async () => {
    const t = setup();
    t.controller.start(t.handlers);
    t.pick().resolve(null);
    await flush();
    expect(t.controller.getState().status).toBe("idle");
    expect(t.handlers.onError).not.toHaveBeenCalled();
  });

  it("times out a hanging import after the deadline and allows a retry", async () => {
    const t = setup();
    t.controller.start(t.handlers);
    t.pick().resolve("s");
    await flush();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(t.controller.getState().status).toBe("importing");
    await vi.advanceTimersByTimeAsync(1);
    expect(t.controller.getState()).toMatchObject({ status: "error", kind: "timeout", source: "s" });
    expect(t.handlers.onError).toHaveBeenCalledTimes(1);

    t.newImport();
    t.controller.retry();
    expect(t.controller.getState()).toMatchObject({ status: "importing", attempt: 2 });
    expect(t.deps.importDocument).toHaveBeenLastCalledWith("s");
    t.imp().resolve(outcome);
    await flush();
    expect(t.handlers.onDone).toHaveBeenCalled();
  });

  it("maps a backend timeout error to the timeout kind", async () => {
    const t = setup();
    t.controller.start(t.handlers);
    t.pick().resolve("s");
    await flush();
    t.imp().reject(new ImportTimeoutError());
    await flush();
    expect(t.controller.getState()).toMatchObject({ status: "error", kind: "timeout" });
  });

  it("reports import failures and returns to idle on dismiss", async () => {
    const t = setup();
    t.controller.start(t.handlers);
    t.pick().resolve("s");
    await flush();
    t.imp().reject(new Error("not a pdf"));
    await flush();
    expect(t.controller.getState()).toMatchObject({ status: "error", kind: "failed" });
    t.controller.dismiss();
    expect(t.controller.getState().status).toBe("idle");
  });

  it("recovers a lost picker reply from Rust and continues the import", async () => {
    const recoverPick = vi.fn(() => Promise.resolve("content://recovered"));
    const t = setup({ recoverPick });
    t.controller.start(t.handlers);
    const requestId = (t.deps.pick as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as number;
    t.foreground()?.leave(); // picker covers the app
    await vi.advanceTimersByTimeAsync(60_000); // browsing in the picker is fine
    expect(t.controller.getState().status).toBe("picking");
    t.foreground()?.back(); // app visible again, but the reply never arrives
    await vi.advanceTimersByTimeAsync(1_999);
    expect(recoverPick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(recoverPick).toHaveBeenCalledWith(requestId);
    await flush();
    expect(t.controller.getState()).toMatchObject({ status: "importing", source: "content://recovered" });
    // The late original reply is ignored.
    t.pick().resolve("content://late");
    await flush();
    expect(t.deps.importDocument).toHaveBeenCalledTimes(1);
  });

  it("a recovered cancel returns to idle", async () => {
    const t = setup({ recoverPick: vi.fn(() => Promise.resolve(null)) });
    t.controller.start(t.handlers);
    t.foreground()?.leave();
    t.foreground()?.back();
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(t.controller.getState().status).toBe("idle");
    expect(t.handlers.onError).not.toHaveBeenCalled();
  });

  it("reports a lost result when Rust has no outcome either, then retries with a new request", async () => {
    const t = setup();
    t.controller.start(t.handlers);
    t.foreground()?.leave();
    t.foreground()?.back();
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(t.controller.getState()).toMatchObject({ status: "error", kind: "resultLost", source: null });

    t.newPick();
    t.controller.retry();
    expect(t.controller.getState()).toEqual({ status: "picking", attempt: 2 });
    const ids = (t.deps.pick as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as number);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe((ids[0] ?? 0) + 1);
  });

  it("gives up if the recovery call itself never answers", async () => {
    const t = setup({ recoverPick: vi.fn(() => new Promise<string | null | undefined>(() => undefined)) });
    t.controller.start(t.handlers);
    t.foreground()?.leave();
    t.foreground()?.back();
    await vi.advanceTimersByTimeAsync(2_000); // grace → recovery starts
    await vi.advanceTimersByTimeAsync(2_000); // recovery deadline
    expect(t.controller.getState()).toMatchObject({ status: "error", kind: "resultLost" });
  });

  it("a reply arriving within the grace period wins over the watchdog", async () => {
    const t = setup();
    t.controller.start(t.handlers);
    t.foreground()?.leave();
    t.foreground()?.back();
    await vi.advanceTimersByTimeAsync(1_000);
    t.pick().resolve("s");
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.controller.getState().status).toBe("importing");
    expect(t.deps.recoverPick).not.toHaveBeenCalled();
    expect(t.handlers.onError).not.toHaveBeenCalled();
  });

  it("picker errors other than cancel surface as a failed import", async () => {
    const t = setup();
    t.controller.start(t.handlers);
    t.pick().reject(new Error("no activity"));
    await flush();
    expect(t.controller.getState()).toMatchObject({ status: "error", kind: "failed" });
  });

  it("ignores start while busy (only one picker at a time)", () => {
    const t = setup();
    t.controller.start(t.handlers);
    t.controller.start(t.handlers);
    expect(t.deps.pick).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers on every transition", async () => {
    const t = setup();
    const seen: string[] = [];
    t.controller.subscribe(() => seen.push(t.controller.getState().status));
    t.controller.start(t.handlers);
    t.pick().resolve(null);
    await flush();
    expect(seen).toEqual(["picking", "cancelled", "idle"]);
  });
});
