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
engine.setLimits(renderLimitsFor(totalRamBytes)); // per-device tier (see below)
await engine.warmUp();                   // optional: load/compile WASM ahead of open
const doc = await engine.open(bytes);   // DocHandle { id, pageCount, pages, title }
await doc.renderPage(i, scale);          // ImageBitmap
await doc.renderPageImage(i, scale);     // ImageData (raw RGBA) — used by the viewer
await doc.close();
```

Rules inside the engine:

- The WASM binary is bundled with the app (Vite asset), never loaded from a CDN.
- Font fallback is disabled (`fontFallback: null`) — EmbedPDF's default would fetch fonts from
  jsDelivr.
- Renders are queued (visible pages first, in request order) and cancellable.
- Render limits come from device RAM (`limits.ts`): max render scale 2 / 1.5 / 1.25 for
  > 8 / 6–8 / < 6 GB, a per-bitmap pixel budget, and an LRU cache of rendered pages bounded by
  count and bytes. Rendered pixels travel as transferred RGBA buffers.
- The PDFium build contains no V8/XFA (no V8, FXJS or XFA symbols in `pdfium.wasm`), so PDF
  JavaScript is never executed.

`renderPageImage` exists because the spike showed that ImageBitmaps created in the worker pin
shared-memory/GPU resources in the Android WebView until GC (see docs/spike-p0.md).

## Consequences

- Engine swaps (v3, native PDFium on mobile) touch only `packages/engine`.
- F-Droid will require building the PDFium WASM from source reproducibly (open risk, P5).
- P1 viewer features run in the same worker: thumbnails (encoded there), outline, streaming
  full-text search, text runs for the selection layer, view rotation and night mode.
- Night mode keeps images as they are. EmbedPDF does not expose page objects, so
  `pdfium-objects.ts` reads the PDFium document pointer from EmbedPDF's internal cache and
  queries image bounds directly. This is tied to the pinned EmbedPDF version and covered by
  `pdfium.node.test.ts`; if the internals change, night mode degrades to inverting images too.

## Amendment 2026-10-27 — sharp pages at every zoom (tiles instead of a lower resolution)

**Problem (tester report, rc.3):** page text looked soft until zoomed. The viewer rendered at
`min(devicePixelRatio, maxRenderScale)` with a per-tier cap of 2 / 1.5 / 1.25: on the 3 GB AVD
(DPR 2.625) a fit-width page was drawn at 1.25 / 2.625 = 48 % of the screen's pixels and
upscaled by the compositor; on the S23 (DPR 3, mid tier) at 50 %. Above the tier's bitmap cap
(`maxBitmapPixels`) zooming made it worse again (`clampScale` lowered the resolution). The page
boxes also sat at fractional CSS positions, so even a full-resolution bitmap was resampled.

**Decision:**

- **Every page is drawn at CSS size × devicePixelRatio**, in whole device pixels, at every
  zoom: `renderPlan()` (`packages/engine/src/tiles.ts`) turns the box's CSS width into a
  device-pixel width; the box takes exactly that size (`deviceWidth / dpr`) and the viewer
  snaps its position to the device-pixel grid (`snapToDevice`), so the canvas maps 1:1 and the
  compositor never resamples it. `maxRenderScale` is gone from `RenderLimits`.
- **Tiles instead of a lower resolution.** When the full-resolution page would exceed the tier
  cap (`maxBitmapPixels`, unchanged: 16 / 8 / 6 MP) or two viewports of pixels (which would make
  a single re-render slow), the page gets a **base** bitmap of half a viewport of pixels (about
  the fit-width resolution: the quick low-res pass) and full-resolution **tiles** over the
  visible area (`TileLayer.tsx`). The worker takes a tile as a pixel rect of the whole-page
  bitmap (`RenderOptions.rect`). Measured on the AVD, these details decide whether tiles land in
  time and how much they cost while scrolling:
  - Tiles are 256 px, so the grid hugs the screen: 512 px tiles rendered up to 2.4 viewports
    of pixels after a zoom, depending on how the grid fell.
  - They are drawn into 512 px **cell** canvases from a small pool (each canvas is a compositor
    layer, and a new backing store is a costly allocation in the WebView).
  - Only the visible tiles are requested, nearest the centre first, once scrolling has paused
    for 50 ms: rendering during a fling competes with it for the CPU, and the base shows
    meanwhile.
  - Cells are kept 256 px around the view and cancelled when they leave.
  - Progress reaches React once per frame, never while scrolling.
  - The worker yields between jobs through a `MessageChannel`, not `setTimeout(0)`: chained
    timeouts are clamped (≥ 4 ms, more in the WebView), which left it idle ~10 ms between 1.5 ms
    tile renders and made a zoom take 850 ms to sharpen.

  Memory stays bounded by the tier: the base is ≤ the old clamped bitmap, and the cells cover
  the visible area plus a margin.
- **Pixel-identical tiles.** EmbedPDF's matrix render (`FPDF_RenderPageBitmapWithMatrix`)
  rounds glyph baselines differently per bitmap size and offset: tiles rendered that way
  shifted whole text lines by a pixel against each other (SSIM 0.94–0.98 against the same area
  of the whole page). Pages and tiles are therefore rendered with
  `FPDF_RenderPageBitmap` / `FPDF_FFLDraw` at a whole-pixel offset into the full-size page
  (`render-area.ts`), reaching the PDFium page through EmbedPDF's internal document cache like
  `pdfium-objects.ts` already does; a tile is then the same pixels as the page rendered whole
  (SSIM ≥ 0.998, `tiles.node.test.ts`, every rotation). If EmbedPDF's internals change shape
  the worker falls back to EmbedPDF's own render (tested).
- **Low-res pass, then full resolution within 300 ms.** During a pinch the content is scaled
  by a CSS transform (cleared when the fingers lift, no `will-change` left behind); after a
  zoom or a scroll the old bitmap stays up CSS-scaled until the new one is drawn. The viewer
  measures, locally, the time from the last scroll / zoom event until every visible page is at
  full resolution (`sharpness.ts`, `[selis:perf] sharp-after-stop` in logcat,
  `window.__selisSharpness` for `scripts/measure-sharpness.ts`). No `image-rendering` override
  is set anywhere (the default smooth filter only applies to the transient CSS-scaled passes).

**Consequences:**

- Fit-width bitmaps are (DPR / old cap)² larger: ×4.4 on the 3 GB AVD, ×4 on the S23 profile.
  The LRU page cache is bounded in bytes, so on low tiers it holds fewer pages instead of growing.
- The mounted canvases still grow. On the AVD the 1000-page scroll peaks at 440–470 MB of app +
  renderer PSS, against 371–425 MB before. That is +50–70 MB, still ≥ 130 MB under the 600 MB gate.
- Scrolling at fit-width is as smooth as before. At 100 % the full-resolution tiles drawn after
  each stop cost 1–4 fps on the AVD.
- Every visible page shows CSS px × DPR device pixels:
  - SSIM 0.998–1.000 against a PDFium render of the 9 pt `small-text` fixture, against 0.62–0.85
    before.
  - Full resolution 70–210 ms after a zoom, ≤ 125 ms after a scroll.
- Measured numbers are in docs/spike-p0.md ("Sharp pages at every zoom").
- Thumbnails (no viewport) keep the old single bitmap within their own budget.
