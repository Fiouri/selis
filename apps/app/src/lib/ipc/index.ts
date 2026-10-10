/**
 * Typed IPC: the generated tauri-specta bindings plus the reliability layer
 * (`reliable.ts`) that `lib/api.ts` routes every call through.
 */
import { commands } from "./bindings";
import { createReliableIpc, randomRequestId, type ReliableIpc } from "./reliable";

export * from "./bindings";
export {
  type CallResult,
  IpcTimeoutError,
  type LongCallOptions,
  LostResponseError,
  type ShortCallOptions,
} from "./reliable";

/** The WebView reports it is visible again (Android: activity resumed). */
function onResume(listener: () => void): () => void {
  const onVisibility = () => {
    if (document.visibilityState === "visible") listener();
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

let instance: ReliableIpc | null = null;

export function reliableIpc(): ReliableIpc {
  instance ??= createReliableIpc({
    takeResult: commands.takeResult,
    onResume,
    newRequestId: randomRequestId,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => {
      window.clearTimeout(id);
    },
    now: () => Date.now(),
    // Shows in logcat (Tauri/Console): how often the upstream reply loss happens.
    log: (message) => {
      console.info(message);
    },
  });
  return instance;
}
