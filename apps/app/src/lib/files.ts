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
 * In Tauri the picker runs from Rust (`pick_pdf`) as a long-running command, so a
 * reply lost on the way back is recovered by the IPC layer (`lib/ipc/reliable.ts`).
 */
export async function pickPdf(): Promise<string | null> {
  if (isTauri()) {
    const outcome = await api.pickPdf();
    return outcome.status === "picked" ? outcome.source : null;
  }
  const file = await pickWithInput();
  if (!file) return null;
  // Loaded lazily so the mock backend never ships in the Tauri bundle's hot path.
  const { registerMockFile } = await import("./mock-ipc");
  return registerMockFile(file);
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

/** URL for a library file (document copy, thumbnail): the scoped asset protocol in Tauri. */
export function assetUrl(path: string): string {
  return isTauri() ? convertFileSrc(path) : path;
}

/** Reads a library file. Tauri serves it through the scoped asset protocol. */
export async function readDocumentBytes(path: string): Promise<ArrayBuffer> {
  const response = await fetch(assetUrl(path));
  if (!response.ok) throw new Error(`failed to read document (${response.status})`);
  return response.arrayBuffer();
}
