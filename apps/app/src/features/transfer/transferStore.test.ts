import { describe, expect, it, vi } from "vitest";
import { ApiError, type ReceiveView, type SendView } from "../../lib/api";
import { cleanLink, formatCode, formatCountdown, percent } from "./format";
import { createTransferStore, type TransferApi, type TransferDeps } from "./transferStore";

const LINK = "selis://transfer/selisabc";

function fakeApi(overrides: Partial<TransferApi> = {}): TransferApi {
  return {
    transferOpen: vi.fn(() => Promise.resolve({ deviceId: "d", network: "default" as const, debug: false })),
    transferClose: vi.fn(() => Promise.resolve(true)),
    transferOffer: vi.fn(() =>
      Promise.resolve({ sessionId: "s1", link: LINK, qrSvg: "<svg/>", docCount: 2, totalBytes: 10, expiresAt: 1e10 }),
    ),
    transferSendStatus: vi.fn((): Promise<SendView> => Promise.resolve({ kind: "waitingForReceiver" })),
    transferDecide: vi.fn(() => Promise.resolve(null)),
    transferCancelSend: vi.fn(() => Promise.resolve(null)),
    transferReceive: vi.fn(() => Promise.resolve("r1")),
    transferReceiveStatus: vi.fn((): Promise<ReceiveView> => Promise.resolve({ kind: "connecting" })),
    transferCancelReceive: vi.fn(() => Promise.resolve(null)),
    transferResumable: vi.fn(() => Promise.resolve([])),
    transferResume: vi.fn(() => Promise.resolve(null)),
    transferPause: vi.fn(() => Promise.resolve(null)),
    transferForeground: vi.fn(() => Promise.resolve(null)),
    transferForegroundStop: vi.fn(() => Promise.resolve(null)),
    transferNotifications: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  } as TransferApi;
}

/** Timers run when `flush` is called (one poll step each). */
function harness(api: TransferApi) {
  const timers: Array<() => void> = [];
  let now = 0;
  const received: string[][] = [];
  const deps: TransferDeps = {
    api,
    translate: (key) => key,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    now: () => now,
    onReceived: (ids) => received.push(ids),
  };
  const store = createTransferStore(deps);
  const flush = async () => {
    now += 1_000;
    const pending = timers.splice(0);
    for (const fn of pending) fn();
    // Let the polled promises settle.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  return { store, flush, received, timers };
}

describe("transfer store", () => {
  it("opens, then starts a pending deep link once the endpoint is there", async () => {
    const api = fakeApi();
    const { store } = harness(api);
    store.getState().setIncomingLink(LINK);
    expect(api.transferReceive).not.toHaveBeenCalled();
    await store.getState().open();
    expect(api.transferReceive).toHaveBeenCalledWith(LINK);
    expect(store.getState().tab).toBe("receive");
    expect(store.getState().receiveId).toBe("r1");
  });

  it("refuses a link that is not one without calling Rust", async () => {
    const api = fakeApi();
    const { store } = harness(api);
    await store.getState().open();
    await store.getState().receiveLink("https://example.com");
    expect(api.transferReceive).not.toHaveBeenCalled();
    expect(store.getState().receiveProblem).toBe("invalidLink");
  });

  it("maps an expired ticket from Rust to the expired message", async () => {
    const api = fakeApi({
      transferReceive: vi.fn(() => Promise.reject(new ApiError({ code: "invalidArgument", message: "expired" }))),
    });
    const { store } = harness(api);
    await store.getState().open();
    await store.getState().receiveLink(LINK);
    expect(store.getState().receiveProblem).toBe("expired");
    expect(store.getState().receive).toBeNull();
  });

  it("polls a send through the code to done and stops the notification", async () => {
    const views: SendView[] = [
      { kind: "confirm", code: "482913" },
      { kind: "sending", bytes: 5, total: 10, route: "lan" },
      { kind: "done" },
    ];
    const api = fakeApi({ transferSendStatus: vi.fn(() => Promise.resolve(views.shift() ?? { kind: "done" })) });
    const { store, flush, timers } = harness(api);
    await store.getState().open();
    await store.getState().offerDocuments(["a", "b"], true);
    expect(api.transferOffer).toHaveBeenCalledWith(["a", "b"], true);
    await flush();
    expect(store.getState().send).toEqual({ kind: "confirm", code: "482913" });
    await store.getState().decide(true);
    expect(api.transferDecide).toHaveBeenCalledWith("s1", true);
    await flush();
    await flush();
    expect(store.getState().send).toEqual({ kind: "done" });
    expect(api.transferForeground).toHaveBeenCalled();
    expect(api.transferForegroundStop).toHaveBeenCalled();
    // Finished: no more polling.
    expect(timers).toHaveLength(0);
  });

  it("reports received documents once and refreshes the paused list", async () => {
    const views: ReceiveView[] = [
      { kind: "confirm", code: "111222" },
      { kind: "receiving", bytes: 1, total: 2, route: "relay" },
      { kind: "done", documentIds: ["x"], duplicates: 0 },
    ];
    const api = fakeApi({ transferReceiveStatus: vi.fn(() => Promise.resolve(views.shift() ?? { kind: "connecting" })) });
    const { store, flush, received } = harness(api);
    await store.getState().open();
    await store.getState().receiveLink(LINK);
    await flush();
    await flush();
    await flush();
    await flush();
    expect(store.getState().receive).toEqual({ kind: "done", documentIds: ["x"], duplicates: 0 });
    expect(received).toEqual([["x"]]);
    expect(api.transferResumable).toHaveBeenCalledTimes(2);
  });

  it("asks Rust to close but keeps a running send visible", async () => {
    const api = fakeApi({ transferClose: vi.fn(() => Promise.resolve(false)) });
    const { store } = harness(api);
    await store.getState().open();
    await store.getState().offerDocuments(["a"], false);
    await store.getState().close();
    expect(store.getState().info).not.toBeNull();
    expect(store.getState().offer).not.toBeNull();
  });
});

describe("transfer formatting", () => {
  it("formats codes, percentages and countdowns", () => {
    expect(formatCode("482913")).toBe("482 913");
    expect(percent(5, 10)).toBe(50);
    expect(percent(5, 0)).toBe(0);
    expect(percent(20, 10)).toBe(100);
    expect(formatCountdown(581)).toBe("9:41");
    expect(formatCountdown(-3)).toBe("0:00");
  });

  it("accepts links and bare tickets, nothing else", () => {
    expect(cleanLink(`  ${LINK}\n`)).toBe(LINK);
    expect(cleanLink("selisabc123")).toBe("selisabc123");
    expect(cleanLink("https://example.com")).toBeNull();
    expect(cleanLink("")).toBeNull();
    expect(cleanLink(`selis://transfer/${"a".repeat(5000)}`)).toBeNull();
  });
});
