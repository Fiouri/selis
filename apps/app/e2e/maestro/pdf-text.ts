/**
 * Prints the text of every page of a PDF, extracted by PDFium (WASM), for the
 * Maestro checks (redact.sh): `node pdf-text.ts <file.pdf>`.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import { init } from "@embedpdf/pdfium";

const require = createRequire(import.meta.url);
const file = process.argv[2];
if (!file) {
  console.error("usage: node pdf-text.ts <file.pdf>");
  process.exit(2);
}
const wasm = readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
const pdf = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) });
const engine = new PdfiumNative(pdf, { fontFallback: null });
const bytes = readFileSync(file);
const content = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const doc = await engine.openDocumentBuffer({ id: "check", content }).toPromise();
// EmbedPDF types this result loosely (`Task<any> | Task<string>`).
const text: unknown = await engine.extractText(doc, doc.pages.map((p) => p.index)).toPromise();
if (typeof text !== "string") throw new Error("no text from the engine");
process.stdout.write(text);
