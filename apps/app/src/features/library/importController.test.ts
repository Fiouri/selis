import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportOutcome } from "../../lib/api";
import { LostResponseError } from "../../lib/ipc/reliable";
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
  const deps: ImportDeps = {
    pick: vi.fn(() => pick.promise),
    importDocument: vi.fn(() => imp.promise),
    isTimeoutError: (e) => e instanceof ImportTimeoutError,
    isLostResponse: (e) => e instanceof LostResponseError,
    warmUp: vi.fn(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id),
    timeoutMs: 30_000,
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

  it("an unrecoverable lost picker reply becomes resultLost, and retry reopens the picker", async () => {
    const t = setup();
    t.controller.start(t.handlers);
    t.pick().reject(new LostResponseError("pick_pdf"));
    await flush();
    expect(t.controller.getState()).toMatchObject({ status: "error", kind: "resultLost", source: null });
    expect(t.handlers.onError).toHaveBeenCalledTimes(1);

    t.newPick();
    t.controller.retry();
    expect(t.controller.getState()).toEqual({ status: "picking", attempt: 2 });
    expect(t.deps.pick).toHaveBeenCalledTimes(2);
    // The superseded attempt's late answer is ignored.
    t.pick().resolve("s");
    await flush();
    expect(t.controller.getState()).toMatchObject({ status: "importing", attempt: 2, source: "s" });
  });

  it("a lost import reply fails the import with a retry that keeps the source", async () => {
    const t = setup();
    t.controller.start(t.handlers);
    t.pick().resolve("s");
    await flush();
    t.imp().reject(new LostResponseError("import_document"));
    await flush();
    expect(t.controller.getState()).toMatchObject({ status: "error", kind: "failed", source: "s" });
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
