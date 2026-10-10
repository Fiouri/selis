/**
 * IPC reliability layer over the generated bindings (docs/adr/0005-ipc-reliability.md).
 *
 * On Android (Tauri 2.11 / wry 0.55) a command's reply can be lost on its way
 * back to the WebView while the app resumes: Rust finishes, but the JS promise
 * never settles. Two kinds of calls are protected here:
 *
 * - **Long-running commands** (`long`) get a client-generated request id. Rust
 *   stores their final result under it (`take_result`). When the app comes back
 *   to the foreground, and on a per-call deadline, every in-flight request is
 *   checked with a fresh `take_result` call instead of waiting forever. A request
 *   Rust has never seen is sent again with the same id; the command is
 *   idempotent per id, so this never repeats a write.
 * - **Short commands** (`short`) get a plain timeout and, if read-only, a single
 *   retry.
 */
import type { CommandError, TakeResult } from "./bindings";

export type CallResult<T> = { status: "ok"; data: T } | { status: "error"; error: CommandError };

/** The reply never arrived and could not be recovered. */
export class LostResponseError extends Error {
  readonly command: string;

  constructor(command: string) {
    super(`no reply from ${command}`);
    this.name = "LostResponseError";
    this.command = command;
  }
}

/** A short command did not answer in time (after its retry, if any). */
export class IpcTimeoutError extends Error {
  readonly command: string;

  constructor(command: string) {
    super(`${command} timed out`);
    this.name = "IpcTimeoutError";
    this.command = command;
  }
}

export type LongCallOptions = {
  /** First check if no reply arrived after this long; null = only on resume. */
  checkAfterMs: number | null;
  /** While Rust reports the command as still running, check again this often. */
  pollMs: number;
};

export type ShortCallOptions = {
  timeoutMs: number;
  /** Retry once after a timeout. Only for read-only (or otherwise repeatable) commands. */
  retry: boolean;
};

export type ReliableIpcDeps = {
  takeResult: (requestId: string) => Promise<CallResult<TakeResult>>;
  /** Calls `listener` whenever the app is back in the foreground. */
  onResume: (listener: () => void) => () => void;
  newRequestId: () => string;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  now: () => number;
  log: (message: string) => void;
};

export type ReliableIpcConfig = {
  /** After a resume, a normal reply gets this long before `take_result` is asked. */
  resumeGraceMs: number;
  /** Budget for one `take_result` call (it can be lost too). */
  takeTimeoutMs: number;
  /** Give up after this many `take_result` calls in a row without an answer. */
  maxFailedChecks: number;
  /** Give up after Rust said "unknown" this many times (each one re-sends the call). */
  maxUnknown: number;
  /**
   * Rust forgets finished results after this long (`RESULT_TTL`). An "unknown"
   * for an older request may mean "expired", so it is never re-sent: that could
   * run the command a second time.
   */
  resultTtlMs: number;
};

export const DEFAULT_CONFIG: ReliableIpcConfig = {
  resumeGraceMs: 1_500,
  takeTimeoutMs: 3_000,
  maxFailedChecks: 3,
  maxUnknown: 2,
  resultTtlMs: 5 * 60_000,
};

export type ReliableIpc = {
  long: <T>(
    command: string,
    send: (requestId: string) => Promise<CallResult<T>>,
    options: LongCallOptions,
  ) => Promise<CallResult<T>>;
  short: <T>(command: string, send: () => Promise<T>, options: ShortCallOptions) => Promise<T>;
  /** Number of long requests still waiting for a result. */
  inFlight: () => number;
  dispose: () => void;
};

const TIMED_OUT = Symbol("timedOut");

export function createReliableIpc(deps: ReliableIpcDeps, config: ReliableIpcConfig = DEFAULT_CONFIG): ReliableIpc {
  const inflight = new Map<string, { resumed: () => void }>();

  const stopResume = deps.onResume(() => {
    for (const request of [...inflight.values()]) request.resumed();
  });

  async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    let expire: (value: typeof TIMED_OUT) => void = () => undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      expire = resolve;
    });
    const timer = deps.setTimer(() => {
      expire(TIMED_OUT);
    }, ms);
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      deps.clearTimer(timer);
    }
  }

  function long<T>(
    command: string,
    send: (requestId: string) => Promise<CallResult<T>>,
    options: LongCallOptions,
  ): Promise<CallResult<T>> {
    const requestId = deps.newRequestId();
    const sentAt = deps.now();

    return new Promise<CallResult<T>>((resolve, reject) => {
      let settled = false;
      /** Read through a function: `settled` changes while a check awaits. */
      const isSettled = () => settled;
      let timer: number | null = null;
      let checking = false;
      let failedChecks = 0;
      let unknownCount = 0;

      const clear = () => {
        if (timer !== null) deps.clearTimer(timer);
        timer = null;
      };
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clear();
        inflight.delete(requestId);
        settle();
      };
      const schedule = (ms: number) => {
        if (settled) return;
        clear();
        timer = deps.setTimer(() => {
          timer = null;
          void check();
        }, ms);
      };

      const dispatch = async () => {
        try {
          const result = await send(requestId);
          finish(() => {
            resolve(result);
          });
        } catch (error) {
          finish(() => {
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        }
      };

      const check = async () => {
        if (settled || checking) return;
        checking = true;
        let answer: CallResult<TakeResult> | typeof TIMED_OUT | null;
        try {
          answer = await withTimeout(deps.takeResult(requestId), config.takeTimeoutMs);
        } catch {
          answer = null;
        } finally {
          checking = false;
        }
        if (isSettled()) return;

        if (answer === null || answer === TIMED_OUT || answer.status === "error") {
          failedChecks += 1;
          if (failedChecks >= config.maxFailedChecks) {
            deps.log(`[selis:ipc] ${command}: reply lost, take_result unanswered`);
            finish(() => {
              reject(new LostResponseError(command));
            });
          } else {
            schedule(options.pollMs);
          }
          return;
        }
        failedChecks = 0;

        const taken = answer.data;
        switch (taken.status) {
          case "done":
            deps.log(`[selis:ipc] ${command}: reply lost, recovered via take_result`);
            finish(() => {
              resolve(taken.result as CallResult<T>);
            });
            return;
          case "pending":
            schedule(options.pollMs);
            return;
          case "unknown":
            unknownCount += 1;
            if (unknownCount >= config.maxUnknown || deps.now() - sentAt >= config.resultTtlMs) {
              deps.log(`[selis:ipc] ${command}: request unknown to Rust, giving up`);
              finish(() => {
                reject(new LostResponseError(command));
              });
              return;
            }
            // The call never reached Rust (or has not registered yet): send it
            // again with the same id. Rust runs it at most once.
            deps.log(`[selis:ipc] ${command}: request unknown to Rust, re-sending`);
            void dispatch();
            schedule(options.pollMs);
            return;
        }
      };

      inflight.set(requestId, {
        resumed: () => {
          schedule(config.resumeGraceMs);
        },
      });
      void dispatch();
      if (options.checkAfterMs !== null) schedule(options.checkAfterMs);
    });
  }

  async function short<T>(command: string, send: () => Promise<T>, options: ShortCallOptions): Promise<T> {
    const attempts = options.retry ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = await withTimeout(send(), options.timeoutMs);
      if (result !== TIMED_OUT) return result;
      deps.log(`[selis:ipc] ${command}: no reply within ${String(options.timeoutMs)} ms (attempt ${String(attempt)})`);
    }
    throw new IpcTimeoutError(command);
  }

  return {
    long,
    short,
    inFlight: () => inflight.size,
    dispose: stopResume,
  };
}

/** 128 random bits as hex; accepted by Rust's request id check. */
export function randomRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
