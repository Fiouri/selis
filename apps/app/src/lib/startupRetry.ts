/**
 * Delays between startup attempts. On a cold start (slow phones, the 3 GB AVD)
 * the first IPC calls can fail while the native side is still starting; a link
 * or document handed over by the launch intent must not be dropped then.
 */
export const STARTUP_RETRY_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

type Timers = {
  set: (fn: () => void, ms: number) => number;
  clear: (id: number) => void;
};

const windowTimers: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
};

/** Runs `attempt` now and again after each delay until it succeeds. Returns a cancel function. */
export function retryOnStartup(attempt: () => Promise<boolean>, timers: Timers = windowTimers): () => void {
  let cancelled = false;
  let timer = 0;
  const run = async (index: number) => {
    const delay: number | undefined = STARTUP_RETRY_MS[index];
    if (cancelled || (await attempt()) || delay === undefined) return;
    timer = timers.set(() => void run(index + 1), delay);
  };
  void run(0);
  return () => {
    cancelled = true;
    timers.clear(timer);
  };
}
