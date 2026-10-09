# ADR 0002 — EmbedPDF v2 (PDFium WASM) as the PDF engine

- Status: accepted
- Date: 2026-10-09

## Context

We need rendering now and, later, text, annotations, forms, redaction and page operations, under
a permissive license compatible with every app store.

- MuPDF: AGPL — would make the app AGPL and conflicts with App Store terms.
- pdf-lib: effectively unmaintained; loses AcroForm fields on merge (seen in AnyPDF).
- pdf.js: rendering only, cannot write PDFs.

## Decision

Use [EmbedPDF](https://github.com/embedpdf/embed-pdf-viewer) **v2** (2.15.1: `@embedpdf/engines`,
`@embedpdf/pdfium`, `@embedpdf/models`), headless, via its `PdfiumNative` executor running in our
own Web Worker (`packages/engine/src/worker.ts`). v3 is not production-ready; we stay on v2 and
migrate later behind the same package boundary.

`packages/engine` is the only code that imports `@embedpdf/*` (ESLint-enforced). Its typed API:

```ts
const doc = await engine.open(bytes);   // DocHandle { id, pageCount, pages, title }
await doc.renderPage(i, scale);          // ImageBitmap
await doc.renderPageImage(i, scale);     // ImageData (raw RGBA) — used by the viewer
await doc.close();
```

Rules inside the engine:

- The WASM binary is bundled with the app (Vite asset), never loaded from a CDN.
- Font fallback is disabled (`fontFallback: null`) — EmbedPDF's default would fetch fonts from
  jsDelivr.
- Renders are queued (visible pages first, newest first) and cancellable; a per-bitmap pixel
  budget bounds memory.
- The PDFium build contains no V8/XFA (no V8, FXJS or XFA symbols in `pdfium.wasm`), so PDF
  JavaScript is never executed.

`renderPageImage` exists because the spike showed that ImageBitmaps created in the worker pin
shared-memory/GPU resources in the Android WebView until GC (see docs/spike-p0.md).

## Consequences

- Engine swaps (v3, native PDFium on mobile) touch only `packages/engine`.
- F-Droid will require building the PDFium WASM from source reproducibly (open risk, P5).
