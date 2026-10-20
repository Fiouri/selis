# ADR 0034 — Text geometry at the engine boundary (rotated pages)

- Status: accepted
- Date: 2026-10-20

## Context

P7b found that EmbedPDF reports text rects in the wrong place on pages with `/Rotate`.
`packages/engine` passes text geometry to every feature:
- the text layer (selection, "copy text", accessibility);
- search highlights;
- glyph boxes (markup and redaction selection);
- the OCR layer;
- the Erase and Redact areas taken from them.

Measured on the `rotated-text` fixture (EmbedPDF 2.15.1): the same page at `/Rotate 0`, `90`,
`180` and `270`, with a crop box that does not start at 0,0, three upright words and one turned by
its text matrix. Each source is compared, as intersection over union (IoU), with the bounding box
of the word's rendered pixels:

| Source | `/Rotate 0` | `/Rotate 90/180/270` |
| --- | --- | --- |
| `getPageTextRects` (text layer) | 0.88–0.96 | **0.00–0.01** |
| `searchInPage` (search highlights) | 0.94–0.99 | 0.92–0.99 |
| `getPageGeometry` (glyph boxes) | 0.61–0.70 | 0.59–0.78 |

- **`getPageTextRects`** maps only the rect's `(left, top)` corner (`FPDF_PageToDevice`) and keeps
  the unrotated width and height.
- **`searchInPage`** maps all four corners.
- **`getPageGeometry`** gets the position right on every rotation, but rounds it to whole points.
  Its IoU stays low on every page, `/Rotate 0` included, because loose boxes run from the font's
  ascent to its descent.

Upstream issue: https://github.com/embedpdf/embed-pdf-viewer/issues/892.

## Decision

The engine reads text geometry from PDFium itself (`text-geometry.ts`), at one place, and maps
every corner with EmbedPDF's own point conversion in floating point. This is the conversion its
search, annotations, redaction quads and our `toUserSpace` use. Every feature gets the same
corrected rects:
- **Text layer:** `pageTextBoxes` reads `FPDFText_GetRect`, the four corners mapped, plus the
  font size. The text of each box still comes from `EmbeddedText.boundedTexts`.
- **Glyphs:** `pageGlyphs` reads `FPDFText_GetLooseCharBox` per character, the four corners
  mapped, grouped by text object as before.
- **Search** keeps EmbedPDF's `searchInPage`, which is already right.
- **OCR layer:** it already placed words through the same conversion, so it is unchanged.
- **Image bounds for night mode** (`imageRectsOnPage`) also ignored `/Rotate` and the crop box.
  They now go through the same conversion as page objects.

Erase and Redact take their areas from these rects, or from the user's own drawing in the same
viewer coordinates. Both already convert to user space with the same function.

## Consequences

Verified in `textgeom.node.test.ts`, on every rotation, for the upright words and the turned one:
- **Text-layer and search rects:** IoU ≥ 0.9 with the drawn glyphs.
- **Glyph boxes:** the word's boxes hold all of its ink, run along the same axis, and their IoU
  is > 0.5. This is lower by design: a loose box covers the line height that selection and
  markup paint.
- **OCR:** a word placed on a `/Rotate 90` page is found where it was placed.
- **Redaction and erase:** from a text-layer rect, each removes exactly the chosen word (pdf.js
  extraction), keeps the other words on that page, and leaves the other pages unchanged.
- **Upstream bug still present:** a test checks that `getPageTextRects` is still wrong on a
  rotated page. When it fails, EmbedPDF has fixed the bug and the workaround can go.
