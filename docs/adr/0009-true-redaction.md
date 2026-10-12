# ADR 0009 — True redaction: PDFium apply, plus annotations and form values

- Status: accepted
- Date: 2026-10-11

## Context

P2d asks for true redaction: the content under a mark must be gone from the saved file (extracted
text no longer contains it), not merely covered, with a confirm dialog because it cannot be undone
in the saved version. Also whiteout with new text over it.

EmbedPDF 2.15.1 ships PDFium's redaction (`/Redact` annotations, `applyAllRedactions` →
`EPDFPage_ApplyRedactions`). Measured on the fixtures:

- Text under a mark is removed from the page content (no longer extracted), image pixels under it
  are blanked (the rest of the image is kept), and the mark's interior color is painted. ✓
- **Annotations are left alone**: a sticky note over the area keeps its `/Contents`; a text field
  keeps its `/V` and its appearance stream ("Ada Lovelace" survived). A Selis typed-text stamp
  would keep its text too.
- **Removing a widget makes PDFium drop a field value set in the same session**: set `/V` to "",
  remove the widget, save → `/V` is "Ada Lovelace" again. Set without removing → "".
- Overlay text (`/OverlayText`) is drawn by PDFium in a standard-14 font: no Greek (as ADR 0007).

## Decision

- Marks are standard `/Redact` annotations (black or white `/IC`, red border, replacement text in
  `/Contents`) placed with undo / redo in a dedicated mode (⋮ → "Απόκρυψη περιεχομένου"):
  text (follows the selected lines), area (box), whiteout (box + text), eraser.
- Applying (`redact.ts`, worker) runs on a scratch copy in two passes with a save between them:
  1. empty every form field whose widget meets a mark (text "", checkbox / radio off, choice
     unselected);
  2. remove every other annotation that meets a mark (notes, stamps, signatures, links, widgets),
     `applyAllRedactions` per page, then write each whiteout's text as a Selis text stamp in the
     embedded Latin + Greek font, sized to the box.
  The worker swaps the open document for the result (like page operations, ADR 0008); undo reloads
  the bytes from before while the document is open. The confirm dialog says the content leaves the
  new version for good and that earlier versions stay in the history (originals are never
  overwritten, so "share the new one" is the honest advice).
- **Marks never reach a saved version unapplied.** Leaving the mode (Done, ×, system back) with
  marks pending removes them first (one undoable command, a toast says so), then the session
  commits. A black box over content that is still there would look redacted and is not.

## Consequences

- Verified on the produced file with an **independent reader** (`@selis/fixtures/oracle`: pdf.js
  6.4 + its Node canvas, test-only; not an engine, so ADR 0002 stands): pdf.js no longer extracts the
  redacted lines and still extracts the rest; the redacted strings are nowhere in the bytes, raw or
  with every Flate stream inflated, neither as text (UTF-8 / UTF-16BE) nor as the glyph codes the
  content stream drew them with (positive control before applying); only the whiteout's text stamp
  is left as an annotation, within ±2 pt of its mark; pdf.js renders each black box within ±2 pt of
  its mark on the right page, the whiteout's line blank and its neighbours untouched. Marks in the
  tests are placed from the fixture's line geometry (pdf.js), and each is asserted to cover its own
  line and no other. The same oracle reads the version saved through the UI (Playwright: the boxes
  drawn on screen land within ±2 pt in the file) and the version pulled off the device (Maestro
  `redact.sh check` → `redact-check.ts`: each box covers its line and meets neither neighbour).
- 2026-10-12 — the P2d sample `redacted-greek.pdf` was described as removing the "σύννεφο" /
  "ψυχοφθόρα" lines but its generator hard-coded a whiteout box on body line 1 (and no black box on
  page 1); the redaction itself was correct (line 1 left the content stream, 31 → 29 text objects,
  the stamp exactly over it). The tests then derived the "removed" line from the result, so they
  could not catch a mark on the wrong line. Fixed by the geometry-placed marks above; the samples are
  now written by the very tests that check them (`SELIS_SAMPLES=<dir>`).
- A field met by a mark loses its widget and value but keeps its (empty) entry in `/AcroForm
  /Fields` with its name and tooltip; names are structure, not content.
- Content outside the page content and annotations is not touched: bookmarks / outline titles,
  document metadata, attachments, and named destinations can still mention redacted words. Not in
  P2 scope; a "sanitize document" step can follow (P4 with qpdf).
- Partial glyph overlap: PDFium removes whole text objects / glyphs that meet the quads, so a mark
  that clips a line removes those glyphs entirely (safer than keeping them).
