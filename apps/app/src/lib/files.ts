/**
 * File picking and reading. In Tauri the OS picker (driven from Rust) returns a
 * path (desktop) or a content:// URI (Android SAF); Rust copies it into the library. In the mock
 * browser build a hidden <input type=file> stands in for the picker.
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "./api";
import { isTauri } from "./platform";

/**
 * Opens the system picker for one PDF and resolves to a source string for
 * `api.importDocument`, or null if the user cancelled.
 *
 * In Tauri the picker runs from Rust (`pick_pdf`), which also keeps the outcome so
 * `recoverPick` can fetch it if this call's reply never reaches the WebView.
 */
export async function pickPdf(requestId: number): Promise<string | null> {
  if (isTauri()) {
    const outcome = await api.pickPdf(requestId);
    return outcome.status === "picked" ? outcome.source : null;
  }
  const file = await pickWithInput();
  if (!file) return null;
  // Loaded lazily so the mock backend never ships in the Tauri bundle's hot path.
  const { registerMockFile } = await import("./mock-ipc");
  return registerMockFile(file);
}

/**
 * Fetches a finished picker outcome with a fresh IPC call: a source, null for
 * cancelled, or undefined if the picker has not produced one (truly lost).
 */
export async function recoverPick(requestId: number): Promise<string | null | undefined> {
  if (!isTauri()) return undefined;
  const outcome = await api.takePickResult(requestId);
  // Local diagnostics only (logcat): shows how often the upstream reply loss happens.
  console.info(`[selis:import] picker reply lost; recovered=${outcome === null ? "no" : outcome.status}`);
  if (outcome === null) return undefined;
  return outcome.status === "picked" ? outcome.source : null;
}

function pickWithInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.style.display = "none";
    input.dataset.testid = "file-input";
    const done = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => done(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

/** Reads a library file. Tauri serves it through the scoped asset protocol. */
export async function readDocumentBytes(path: string): Promise<ArrayBuffer> {
  const url = isTauri() ? convertFileSrc(path) : path;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to read document (${response.status})`);
  return response.arrayBuffer();
}
