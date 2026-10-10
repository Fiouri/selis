import { useSyncExternalStore } from "react";
import { ApiError, api, LostResponseError } from "../../lib/api";
import { warmUpEngine } from "../../lib/engine";
import { pickPdf } from "../../lib/files";
import { IMPORT_TIMEOUT_MS, ImportController, ImportTimeoutError } from "./importController";
import type { ImportState } from "./importMachine";

/** Mock-build-only knobs for Playwright (never read by the Tauri build). */
type TestHooks = { importTimeoutMs?: number };

function testHooks(): TestHooks {
  if (!__SELIS_MOCK_IPC__) return {};
  return (window as unknown as { __selisTest?: TestHooks }).__selisTest ?? {};
}

let controller: ImportController | null = null;

/** The app-wide import controller (one import at a time). */
export function importController(): ImportController {
  controller ??= new ImportController({
    pick: pickPdf,
    importDocument: api.importDocument,
    isTimeoutError: (error) =>
      error instanceof ImportTimeoutError || (error instanceof ApiError && error.code === "timeout"),
    isLostResponse: (error) => error instanceof LostResponseError,
    warmUp: warmUpEngine,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id),
    get timeoutMs() {
      return testHooks().importTimeoutMs ?? IMPORT_TIMEOUT_MS;
    },
  });
  return controller;
}

export function useImportState(): ImportState {
  const c = importController();
  return useSyncExternalStore(c.subscribe, c.getState);
}
