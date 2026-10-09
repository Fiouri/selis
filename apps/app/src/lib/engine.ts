import { createPdfEngine, type PdfEngine } from "@selis/engine";

let engine: PdfEngine | null = null;

/** One PDF engine worker for the whole app, started on first use (not at launch). */
export function getEngine(): PdfEngine {
  engine ??= createPdfEngine();
  return engine;
}
