import JSZip from "jszip";

/** A ZIP of already-compressed files (PNG/JPEG): stored, not deflated again. */
export async function zipFiles(files: ReadonlyArray<{ readonly name: string; readonly data: Uint8Array }>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const file of files) zip.file(file.name, file.data, { binary: true, compression: "STORE" });
  return zip.generateAsync({ type: "uint8array", compression: "STORE", platform: "UNIX" });
}

/** `page-001.png` … with enough digits for the page count. */
export function pageFileName(index: number, count: number, extension: "png" | "jpg"): string {
  const digits = Math.max(3, String(count).length);
  return `page-${String(index + 1).padStart(digits, "0")}.${extension}`;
}
