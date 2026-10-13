import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STARTUP_RETRY_MS, retryOnStartup } from "./startupRetry";

describe("retryOnStartup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tries again until the call succeeds, then stops", async () => {
    const results = [false, false, true];
    const attempt = vi.fn(() => Promise.resolve(results.shift() ?? true));
    retryOnStartup(attempt);
    await vi.runAllTimersAsync();
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("gives up after the last delay", async () => {
    const attempt = vi.fn(() => Promise.resolve(false));
    retryOnStartup(attempt);
    await vi.runAllTimersAsync();
    expect(attempt).toHaveBeenCalledTimes(STARTUP_RETRY_MS.length + 1);
  });

  it("stops when cancelled", async () => {
    const attempt = vi.fn(() => Promise.resolve(false));
    const cancel = retryOnStartup(attempt);
    await vi.advanceTimersByTimeAsync(0);
    cancel();
    await vi.runAllTimersAsync();
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
