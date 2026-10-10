import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TakeResult } from "./bindings";
import {
  type CallResult,
  createReliableIpc,
  DEFAULT_CONFIG,
  IpcTimeoutError,
  type LongCallOptions,
  LostResponseError,
  randomRequestId,
  type ReliableIpcDeps,
} from "./reliable";

const ok = <T>(data: T): CallResult<T> => ({ status: "ok", data });
const never = <T>() => new Promise<T>(() => undefined);
const flush = () => vi.advanceTimersByTimeAsync(0);

const IMPORT: LongCallOptions = { checkAfterMs: 5_000, pollMs: 2_000 };
const PICK: LongCallOptions = { checkAfterMs: null, pollMs: 2_000 };

/**
 * A fake Rust side with the same contract as `RequestResults::run_once`: the
 * work runs once per request id, the result is kept for `take_result`, and a
 * duplicate call is answered from the store. `deliver` decides whether a reply
 * reaches the "WebView".
 */
function fakeBackend(ttlMs = DEFAULT_CONFIG.resultTtlMs) {
  const store = new Map<string, { result: CallResult<string> | null; at: number }>();
  let writes = 0;
  const lose = new Set<number>(); // indexes of calls whose reply is dropped
  const delay = new Map<number, number>(); // call index → ms before it reaches Rust
  let calls = 0;

  const expire = () => {
    for (const [id, entry] of store) {
      if (entry.result && Date.now() - entry.at >= ttlMs) store.delete(id);
    }
  };

  const run = (requestId: string): CallResult<string> => {
    expire();
    const existing = store.get(requestId);
    if (existing?.result) return existing.result;
    writes += 1;
    const result = ok(`doc-${String(writes)}`);
    store.set(requestId, { result, at: Date.now() });
    return result;
  };

  const send = async (requestId: string): Promise<CallResult<string>> => {
    const index = calls++;
    const ms = delay.get(index) ?? 0;
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    const result = run(requestId);
    if (lose.has(index)) return never();
    return result;
  };

  const takeResult = (requestId: string): Promise<CallResult<TakeResult>> => {
    expire();
    const entry = store.get(requestId);
    if (!entry) return Promise.resolve(ok({ status: "unknown" }));
    if (!entry.result) return Promise.resolve(ok({ status: "pending" }));
    return Promise.resolve(ok({ status: "done", result: entry.result }));
  };

  return {
    send: vi.fn(send),
    takeResult: vi.fn(takeResult),
    loseReply: (index: number) => lose.add(index),
    delayCall: (index: number, ms: number) => delay.set(index, ms),
    writes: () => writes,
    entries: () => store.size,
  };
}

function setup(takeResult: ReliableIpcDeps["takeResult"]) {
  let resume: (() => void) | null = null;
  let id = 0;
  const log = vi.fn();
  const ipc = createReliableIpc({
    takeResult,
    onResume: (listener) => {
      resume = listener;
      return () => {
        resume = null;
      };
    },
    newRequestId: () => `req-${String(++id)}`,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (timer) => {
      window.clearTimeout(timer);
    },
    now: () => Date.now(),
    log,
  });
  return { ipc, log, resume: () => resume?.() };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("long calls", () => {
  it("a normal reply settles the call without asking take_result", async () => {
    const backend = fakeBackend();
    const t = setup(backend.takeResult);
    const call = t.ipc.long("import_document", backend.send, IMPORT);
    await expect(call).resolves.toEqual(ok("doc-1"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(backend.takeResult).not.toHaveBeenCalled();
    expect(t.ipc.inFlight()).toBe(0);
  });

  it("a lost reply is recovered when the app resumes", async () => {
    const backend = fakeBackend();
    backend.loseReply(0);
    const t = setup(backend.takeResult);
    const call = t.ipc.long("pick_pdf", backend.send, PICK);
    await flush();
    expect(t.ipc.inFlight()).toBe(1);

    // No deadline for the picker: nothing happens while the app is away.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(backend.takeResult).not.toHaveBeenCalled();

    t.resume();
    await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.resumeGraceMs - 1);
    expect(backend.takeResult).not.toHaveBeenCalled(); // a normal reply still gets its chance
    await vi.advanceTimersByTimeAsync(1);
    await expect(call).resolves.toEqual(ok("doc-1"));
    expect(backend.takeResult).toHaveBeenCalledWith("req-1");
    expect(backend.writes()).toBe(1);
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining("recovered via take_result"));
    expect(t.ipc.inFlight()).toBe(0);
  });

  it("a lost reply is recovered on the per-call deadline, without a resume", async () => {
    const backend = fakeBackend();
    backend.loseReply(0);
    const t = setup(backend.takeResult);
    const call = t.ipc.long("import_document", backend.send, IMPORT);
    await vi.advanceTimersByTimeAsync(IMPORT.checkAfterMs ?? 0);
    await expect(call).resolves.toEqual(ok("doc-1"));
  });

  it("keeps polling while Rust reports the command as running", async () => {
    let state: TakeResult = { status: "pending" };
    const takeResult = vi.fn(() => Promise.resolve(ok(state)));
    const t = setup(takeResult);
    const call = t.ipc.long("import_document", () => never(), IMPORT);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(takeResult).toHaveBeenCalledTimes(3);
    state = { status: "done", result: { status: "error", error: { code: "timeout", message: "30 s" } } };
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(call).resolves.toEqual({ status: "error", error: { code: "timeout", message: "30 s" } });
  });

  it("re-sends a request Rust never received with the same id: no second write", async () => {
    const backend = fakeBackend();
    // The first call reaches Rust late (after the first check) and its reply is lost.
    backend.delayCall(0, 6_000);
    backend.loseReply(0);
    const t = setup(backend.takeResult);
    const call = t.ipc.long("import_document", backend.send, IMPORT);

    await vi.advanceTimersByTimeAsync(5_000); // check → "unknown" → re-send
    expect(backend.send).toHaveBeenCalledTimes(2);
    expect(backend.send.mock.calls.map((c) => c[0])).toEqual(["req-1", "req-1"]);
    await expect(call).resolves.toEqual(ok("doc-1"));

    await vi.advanceTimersByTimeAsync(10_000); // the delayed original arrives too
    expect(backend.writes()).toBe(1);
    expect(backend.entries()).toBe(1);
  });

  it("gives up with LostResponseError when Rust keeps not knowing the request", async () => {
    const takeResult = vi.fn(() => Promise.resolve(ok<TakeResult>({ status: "unknown" })));
    const send = vi.fn(() => never<CallResult<string>>());
    const t = setup(takeResult);
    const call = t.ipc.long("pick_pdf", send, PICK);
    const settled = expect(call).rejects.toBeInstanceOf(LostResponseError);
    t.resume();
    await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.resumeGraceMs); // unknown → re-send
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PICK.pollMs); // unknown again → give up
    await settled;
    expect(send).toHaveBeenCalledTimes(2);
    expect(t.ipc.inFlight()).toBe(0);
  });

  it("never re-sends after the result TTL: an expired result is not run again", async () => {
    const backend = fakeBackend();
    backend.loseReply(0);
    const t = setup(backend.takeResult);
    const call = t.ipc.long("pick_pdf", backend.send, PICK);
    const settled = expect(call).rejects.toBeInstanceOf(LostResponseError);
    await flush();
    expect(backend.writes()).toBe(1);

    // The app stays in the background longer than the TTL: Rust evicts the result.
    await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.resultTtlMs);
    expect(backend.entries()).toBe(1);
    t.resume();
    await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.resumeGraceMs);
    await settled;
    expect(backend.entries()).toBe(0);
    expect(backend.send).toHaveBeenCalledTimes(1);
    expect(backend.writes()).toBe(1);
  });

  it("gives up when take_result itself never answers", async () => {
    const takeResult = vi.fn(() => never<CallResult<TakeResult>>());
    const t = setup(takeResult);
    const call = t.ipc.long("import_document", () => never(), IMPORT);
    const settled = expect(call).rejects.toBeInstanceOf(LostResponseError);
    await vi.advanceTimersByTimeAsync(5_000);
    for (let i = 0; i < DEFAULT_CONFIG.maxFailedChecks; i += 1) {
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.takeTimeoutMs + IMPORT.pollMs);
    }
    await settled;
    expect(takeResult).toHaveBeenCalledTimes(DEFAULT_CONFIG.maxFailedChecks);
  });

  it("a resume checks every in-flight request", async () => {
    const backend = fakeBackend();
    backend.loseReply(0);
    backend.loseReply(1);
    const t = setup(backend.takeResult);
    const a = t.ipc.long("pick_pdf", backend.send, PICK);
    const b = t.ipc.long("import_document", backend.send, IMPORT);
    await flush();
    expect(t.ipc.inFlight()).toBe(2);
    t.resume();
    await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.resumeGraceMs);
    await expect(a).resolves.toEqual(ok("doc-1"));
    await expect(b).resolves.toEqual(ok("doc-2"));
    expect(backend.takeResult.mock.calls.map((c) => c[0]).sort()).toEqual(["req-1", "req-2"]);
  });

  it("passes rejections of the call through", async () => {
    const t = setup(vi.fn());
    const call = t.ipc.long("pick_pdf", () => Promise.reject(new Error("ipc down")), PICK);
    await expect(call).rejects.toThrow("ipc down");
    expect(t.ipc.inFlight()).toBe(0);
  });
});

describe("short calls", () => {
  it("returns the reply when it arrives in time", async () => {
    const t = setup(vi.fn());
    await expect(t.ipc.short("list_documents", () => Promise.resolve(3), { timeoutMs: 100, retry: true })).resolves.toBe(
      3,
    );
  });

  it("retries a read once after a timeout", async () => {
    const t = setup(vi.fn());
    const send = vi.fn().mockReturnValueOnce(never()).mockResolvedValueOnce("second");
    const call = t.ipc.short("list_documents", send, { timeoutMs: 100, retry: true });
    await vi.advanceTimersByTimeAsync(100);
    await expect(call).resolves.toBe("second");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("fails with IpcTimeoutError after the retry also times out", async () => {
    const t = setup(vi.fn());
    const send = vi.fn(() => never());
    const call = t.ipc.short("get_settings", send, { timeoutMs: 100, retry: true });
    const settled = expect(call).rejects.toBeInstanceOf(IpcTimeoutError);
    await vi.advanceTimersByTimeAsync(200);
    await settled;
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("never repeats a write", async () => {
    const t = setup(vi.fn());
    const send = vi.fn(() => never());
    const call = t.ipc.short("update_settings", send, { timeoutMs: 100, retry: false });
    const settled = expect(call).rejects.toBeInstanceOf(IpcTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("randomRequestId", () => {
  it("is 32 hex chars (accepted by Rust's request id check) and unique", () => {
    const ids = new Set(Array.from({ length: 100 }, randomRequestId));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});
