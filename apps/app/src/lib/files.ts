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

/**
 * Opens the system picker for a document to convert to PDF (ADR 0035). Resolves to a source
 * for `api.stageSource` and the file's name, or null if the user cancelled.
 */
export async function pickConvertible(): Promise<{ source: string; name: string } | null> {
  if (isTauri()) {
    const outcome = await api.pickDocument();
    if (outcome.status !== "picked") return null;
    const source = outcome.source;
    // The path's or URI's last segment; a SAF URI may carry no name ("…/document/msf:12"),
    // and then the conversion recognises the file by its content.
    const last = decodeURIComponent(source).split("/").at(-1) ?? "";
    const name = last.includes(".") ? last.slice(last.lastIndexOf(":") + 1) : "document";
    return { source, name };
  }
  const file = await pickWithInput(CONVERTIBLE_ACCEPT);
  if (!file) return null;
  const { registerMockFile } = await import("./mock-ipc");
  return { source: registerMockFile(file), name: file.name };
}

const CONVERTIBLE_ACCEPT = ".docx,.xlsx,.csv,.txt,.md,.markdown,.html,.htm";

function pickWithInput(accept = "application/pdf,.pdf"): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
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
