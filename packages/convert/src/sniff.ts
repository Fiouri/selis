import JSZip from "jszip";
import type { SourceKind } from "./kind";

/**
 * The kind of a file without a usable name (an Android content URI often has none), from its
 * bytes: an Office Open XML package by its main part, anything else that is text as plain text.
 */
export async function sniffKind(bytes: Uint8Array): Promise<SourceKind | null> {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    try {
      const zip = await JSZip.loadAsync(bytes);
      if (zip.file("word/document.xml")) return "docx";
      if (zip.file("xl/workbook.xml")) return "xlsx";
    } catch {
      return null;
    }
    return null;
  }
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head).trimStart().toLowerCase();
  if (text.startsWith("<!doctype html") || text.startsWith("<html")) return "html";
  return "txt";
}
