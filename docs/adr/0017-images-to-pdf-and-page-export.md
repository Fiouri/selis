# ADR 0017 — Images to PDF and page export (P4b)

- Status: accepted
- Date: 2026-10-14

## Context

P4 asks for a PDF made from photos (JPEG passed through without re-encoding where possible,
EXIF orientation applied, all EXIF/GPS metadata stripped, page size options, multi-select from
the system photo picker, no storage permission) and for exporting a page as PNG/JPEG at a chosen
DPI within the device's memory limits. ADR 0016 is reserved for the camera scan (P4c).

## Decision

### Building the PDF (packages/engine, `images.ts`)

- In the engine worker, with PDFium (no new library): an `ImagePdfBuilder` adds one page per
  image, so each input buffer can go as soon as it is added.
- **JPEG**: embedded as it is (`FPDFImageObj_LoadJpegFileInline` through an `FPDF_FILEACCESS`
  on WASM memory; the DCT data is copied byte for byte) after removing every metadata segment —
  APP1 (EXIF with camera, date and GPS; XMP), APP3–APP13 (IPTC, maker data, MPF), COM — and
  everything after the first EOI (multi-picture files append previews and depth maps there). The
  segments decoding needs stay: APP0 (JFIF), APP2 `ICC_PROFILE`, APP14 (Adobe colour transform).
- **Orientation**: read from EXIF (both byte orders) and applied by the image's placement
  matrix (rotation / mirror for all eight values), so the pixels are untouched.
- **Other formats** (PNG, WebP, GIF, BMP, HEIC where the WebView decodes it): decoded in the
  worker with `createImageBitmap(..., { imageOrientation: "from-image" })` and embedded as a
  bitmap on white (transparency flattened; PDFium compresses it losslessly). A format the
  WebView cannot decode is left out with a count ("2 photos could not be read").
- **Page size**: "Fit image" — the image's proportions, long side 842 pt (A4 height), no margin
  (default); "A4" / "Letter" — portrait or landscape like the image, fitted inside a 24 pt margin.

### Picking

- **Android**: the system photo picker (`ActivityResultContracts.PickMultipleVisualMedia`,
  images only, up to 50) in `PhotoPickerPlugin.kt` — no `READ_MEDIA_IMAGES` or storage
  permission. Each returned content URI is copied into the stage by Rust (`stage_photo`: images
  only, ≤ 64 MB) and read by the WebView through the asset protocol, then unstaged.
- **iOS and desktop**: `<input type="file" accept="image/*" multiple>` in the WebView;
  WKWebView presents PHPicker (no photo-library permission), desktops their file dialog. No
  native code there.
- The grid shows 240 px thumbnails decoded at that size (`createImageBitmap` resize): twenty
  12-MP photos shown as they are would make the WebView decode ~1 GB of pixels.
- Order: each tile has "move earlier / later" (44 pt) and remove, instead of drag (a long-press
  drag over a scrolling grid of photos was judged too fiddly for v1; P2's page grid keeps drag).

### Page export

- `DocHandle.exportPageImage(page, { dpi, format })`: rendered by PDFium at `dpi / 72` (with
  annotations and form values) and encoded by `OffscreenCanvas.convertToBlob` (PNG, or JPEG at
  0.92) in the worker; WebKits without OffscreenCanvas in workers encode on the main thread.
- Resolutions 96 / 150 / 300 dpi; one whose pixel count exceeds the device tier's
  `maxBitmapPixels` (6 M / 8 M / 16 M, `limits.ts`) is disabled ("Too large for this device"),
  and the worker clamps anyway.
- The image goes up as an upload and out through the share sheet (Android) or the save dialog
  (desktop, cancellable) via `share_export`, named "<title> p<page>.png|jpg".

## Consequences

- No new dependency, no new permission, no network.
- Privacy: no photo metadata reaches the PDF (tested: 20 photos with EXIF/GPS/XMP/IPTC/comments,
  raw and inflated file content searched). Staged copies are deleted after reading.
- HEIC from iPhones works on iOS (WKWebView decodes it); on Android it depends on the WebView
  and is otherwise reported as unreadable.
- Not in v1: cropping or rotating a photo before adding it, image recompression to shrink large
  photos.
