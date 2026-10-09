/**
 * File picking and reading. In Tauri the OS picker returns a path (desktop) or a
 * content:// URI (Android SAF); Rust copies it into the library. In the mock
 * browser build a hidden <input type=file> stands in for the picker.
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "./platform";

/** Returns a source string for `api.importDocument`, or null if cancelled. */
export async function pickPdf(): Promise<string | null> {
  if (isTauri()) {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    return typeof picked === "string" ? picked : null;
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

/** Reads a library file. Tauri serves it through the scoped asset protocol. */
export async function readDocumentBytes(path: string): Promise<ArrayBuffer> {
  const url = isTauri() ? convertFileSrc(path) : path;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to read document (${response.status})`);
  return response.arrayBuffer();
}
