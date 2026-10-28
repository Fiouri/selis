/** What "Convert to PDF" accepts (ADR 0035). */
export type SourceKind = "docx" | "xlsx" | "csv" | "txt" | "md" | "html";

export const SOURCE_EXTENSIONS: Readonly<Record<SourceKind, readonly string[]>> = {
  docx: ["docx"],
  xlsx: ["xlsx"],
  csv: ["csv"],
  txt: ["txt", "text", "log"],
  md: ["md", "markdown"],
  html: ["html", "htm"],
};

export const SOURCE_MIME: Readonly<Record<SourceKind, readonly string[]>> = {
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  csv: ["text/csv", "text/comma-separated-values", "application/csv"],
  txt: ["text/plain"],
  md: ["text/markdown", "text/x-markdown"],
  html: ["text/html"],
};

const ZIP = [0x50, 0x4b, 0x03, 0x04];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}

/**
 * The kind from the file name, else the MIME type. Office files must be ZIP archives
 * (a renamed binary .doc/.xls is refused); text kinds must not be binary.
 */
export function detectKind(name: string, mime: string | null, bytes: Uint8Array): SourceKind | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const type = (mime ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  const kinds = Object.keys(SOURCE_EXTENSIONS) as SourceKind[];
  const kind = kinds.find((k) => SOURCE_EXTENSIONS[k].includes(ext)) ?? kinds.find((k) => SOURCE_MIME[k].includes(type)) ?? null;
  if (kind === "docx" || kind === "xlsx") return startsWith(bytes, ZIP) ? kind : null;
  if (kind && looksBinary(bytes)) return null;
  return kind;
}

/** NUL bytes in the first 8 KB (UTF-16 text is not supported either). */
function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8192);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true;
  return false;
}

/** UTF-8 (BOM or not); invalid sequences become U+FFFD instead of failing. */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
