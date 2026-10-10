import { useSyncExternalStore } from "react";
import { ApiError, api } from "../../lib/api";
import { warmUpEngine } from "../../lib/engine";
import { pickPdf, recoverPick } from "../../lib/files";
import { IMPORT_TIMEOUT_MS, ImportController, PICKER_RESULT_GRACE_MS, ImportTimeoutError } from "./importController";
import type { ImportState } from "./importMachine";

/** Mock-build-only knobs for Playwright (never read by the Tauri build). */
type TestHooks = { importTimeoutMs?: number; pickerGraceMs?: number };

function testHooks(): TestHooks {
  if (!__SELIS_MOCK_IPC__) return {};
  return (window as unknown as { __selisTest?: TestHooks }).__selisTest ?? {};
}

/** Foreground detection that works in the Android WebView (visibility) and desktop (focus). */
function watchForeground(onLeave: () => void, onReturn: () => void): () => void {
  let away = false;
  const leave = () => {
    away = true;
    onLeave();
  };
  const back = () => {
    if (!away) return;
    away = false;
    onReturn();
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") leave();
    else back();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", leave);
  window.addEventListener("focus", back);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("blur", leave);
    window.removeEventListener("focus", back);
  };
}

let controller: ImportController | null = null;

/** The app-wide import controller (one import at a time). */
export function importController(): ImportController {
  controller ??= new ImportController({
    pick: pickPdf,
    recoverPick,
    importDocument: api.importDocument,
    isTimeoutError: (error) =>
      error instanceof ImportTimeoutError || (error instanceof ApiError && error.code === "timeout"),
    warmUp: warmUpEngine,
    watchForeground,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id),
    get timeoutMs() {
      return testHooks().importTimeoutMs ?? IMPORT_TIMEOUT_MS;
    },
    get pickerGraceMs() {
      return testHooks().pickerGraceMs ?? PICKER_RESULT_GRACE_MS;
    },
  });
  return controller;
}

export function useImportState(): ImportState {
  const c = importController();
  return useSyncExternalStore(c.subscribe, c.getState);
}
