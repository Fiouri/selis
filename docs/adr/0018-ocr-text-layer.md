# ADR 0018 — OCR: tesseract.js in the WebView, an invisible text layer written by PDFium (P4d)

- Status: accepted
- Date: 2026-10-14

## Context

P4 asks for OCR → searchable PDF (docs/SPEC.md: Tesseract, Greek + English): tesseract.js
(Apache-2.0) in a dedicated Web Worker, the core WebAssembly (SIMD where supported) and the
tessdata_fast models bundled, no remote paths, CSP unchanged; word boxes turned into an
invisible text layer (render mode 3) on the existing pages through the engine, in an embedded
Greek-capable font, without rasterising the pages; per-page progress, cancel, resume with the
finished pages kept, pages that already have text skipped unless asked for; the result is a new
version. Languages Greek + English by default, overridable.

## Decision

- **Recognition — `packages/ocr`**: tesseract.js 7.0.0 with tesseract.js-core 7.0.0, LSTM only
  (`OEM.LSTM_ONLY`, the fast models have no legacy engine). The app ships, as plain files under
  `ocr/` (`scripts/copy-ocr-assets.ts`, npm pre-scripts; not committed): tesseract.js's
  `worker.min.js`, `tesseract-core-simd-lstm.{js,wasm}` and `tesseract-core-lstm.{js,wasm}`
  (no SIMD: iOS before 16.4) next to it — a core loaded with `importScripts` fetches its `.wasm`
  relative to the worker, not to itself — and `tessdata/{eng,ell}.traineddata.gz`.
  - Every path is set explicitly (tesseract.js defaults to a CDN for all three); the worker
    starts from its URL (`workerBlobURL: false`: the CSP allows `worker-src 'self'` only);
    `cacheMethod: "none"` (no IndexedDB copy of the models); the core is picked by our own SIMD
    probe (`@selis/scan`), not tesseract.js's directory mode, which would load the `.wasm.js`
    builds that inline the module as base64. tesseract.js's only run-time code generation (the
    Function constructor in webpack's globalThis fallback) is never reached; Playwright runs OCR
    under the app's CSP.
  - Models: tessdata_fast at commit 8741641 (Apache-2.0), gzipped and committed in
    `packages/ocr/tessdata` (2.7 MB); the copy script checks their SHA-256.
  - A start-up timeout (120 s) turns a broken asset into an error instead of a hang.
- **Rendering**: each page is rendered by the engine (`exportPageImage`, PNG) at 300 dpi with an
  OCR cap of A4 at 300 dpi (8.7 MP) on every device tier (the tier caps of 6–8 MP would give
  250–290 dpi); larger pages go lower, and Tesseract is told the real resolution
  (`user_defined_dpi`).
- **Layout — `layoutWords`**: words from Tesseract's line/word boxes, on the line's fitted
  baseline, font size from the line box, scaled horizontally to the word box. Text is NFKC
  (tessdata_fast's Greek writes the micro sign µ for μ, which search would never match);
  words under 10 % confidence are dropped (a searchable layer gains more from a right word read
  with doubt — `μελάνι` at 14 % — than it loses to noise near 0 %).
- **Text layer — `EmbeddedText.setTextLayer` (engine)**: one PDFium text object per word in the
  embedded Latin + Greek font (`SelisSans`, the font of the typed text, ADR 0007), render mode
  3 (invisible), placed through `convertDevicePointToPagePoint` (any `/Rotate`), tagged with the
  marked-content tag `/SelisOCR` whose `SelisWord` parameter keeps the word's layout. A new run
  replaces the page's earlier Selis layer and hands it back (undo). No space glyphs (the
  embedded font has none): readers put spaces back from the gaps between word boxes. After
  writing, EmbedPDF's cached text page of that page is dropped (otherwise search keeps reading
  the text from before).
- **Job — `features/ocr/ocrStore.ts`**: each page is one undoable command of the viewer's
  EditSession, so finished pages are autosaved with the working copy (3 s idle, ADR 0007) —
  cancel, a crash or leaving the viewer keep them — and the end of the job commits one
  version. Cancel terminates the Tesseract worker (the page being read stops at once); Resume
  starts a new one and reads the rest. Pages count as having text with ≥ 20 characters outside
  the Selis layer (or with that layer); "Include pages that already have text" reads every
  page (and replaces an earlier Selis layer). Page operations and redaction stop a running job
  first (they renumber or rewrite pages).
- **Search**: the viewer's search results are keyed by the document's page changes too, so a
  text-only change (OCR) is searched afresh.

## Consequences

- No network, no new permission, CSP unchanged. App size +8.6 MB before compression (two
  cores 2.9 MB each, worker 0.1 MB, models 2.7 MB).
- Accuracy on the scanned fixtures (`packages/fixtures`: 300 dpi JPEG pages, skewed, noisy):
  pdf.js reads 98.0 % / 96.2 % of the Greek words and ≥ 95 % of the English ones after OCR
  (Node test with the real PDFium and Tesseract; the same on devices, `ocr.yaml`). Known
  tessdata_fast misreads: `ΐ` as polytonic `ῖ`, the article `το` as Latin `TO`.
- Memory: the page goes to Tesseract as an 8-bit grey PGM rendered by PDFium straight into a
  grey bitmap (no RGBA render, no PNG encode/decode), capped at 2480 × 3508 px and 3508 px on
  the longest side; one page in flight; Tesseract's WebAssembly memory only grows, so its
  worker is recreated every 8 pages and after each document. Peak PSS of app + our WebView
  renderer while reading A4 at 300 dpi: AVD 539 MB (target ≤ 650), S23 613 MB (≤ 700);
  docs/spike-p4.md (P4d follow-up).
- Not in v1: page rotation detection (OSD needs the legacy models), languages beyond Greek and
  English, OCR from the library without opening the document.
