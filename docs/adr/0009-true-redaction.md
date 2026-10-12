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
  /Fields`; its name stays (structure), its tooltip goes when it names a redacted word (below).

## Update 2026-10-12 — the rest of the document, and earlier versions

- **Redacted words leave the whole file, not only the page.** While applying, the worker collects
  what goes: the page text under each mark (PDFium `FPDFText_GetBoundedText`), the emptied field
  values and the removed annotations' text. After PDFium's pass, `sanitize.ts` takes those words out
  of everything else: Info entries and XMP metadata (dropped), outline titles ("█████"), named
  destinations, document JavaScript, embedded files (by name, description or content), page-label
  prefixes, JavaScript actions (open, page, field and annotation actions), form field values,
  defaults, tooltips and option labels (with their appearances, `NeedAppearances` set), other
  annotations whose text or drawn appearance names one (removed; author / subject keys dropped), and
  structure-tree `/Alt`, `/ActualText`, `/E`, `/T`; any other text string left that names one
  becomes empty. Identifiers (`/NM`, `/ID`) are not text. The whiteout stamps just written are kept
  as the user typed them.
- A string "names" a redacted term when one of the term's words (3+ letters or digits, not a short
  common word, Greek or English) appears in it as a whole word, ignoring case and accents. This
  over-matches on purpose (a note elsewhere that shares a redacted word goes too): removing too much
  from a new version beats leaving a trace.
- **Full rewrite only.** `pdf-objects.ts` (a small object reader / writer: classic and stream
  cross-references, object streams, Flate + PNG predictors) writes the result as one fresh file:
  one body, one cross-reference table, no `/Prev`, only the objects still reachable from the
  catalog and Info. Older revisions and unused objects (which may hold removed content) do not
  survive. pdf-lib and qpdf stay out of the app (ADR 0002 / CLAUDE.md); qpdf checks the result in
  tests.
- A document with a security handler (an owner password; one with a user password does not open
  in Selis yet) is written without it when redacted: its strings must be readable to be checked.
  The new version keeps the content readable to anyone, as before; only the owner's permission
  flags are gone.
- **Earlier versions.** The new version is clean, but the history (the imported original
  included) still holds the removed content. After a redacted version is saved, a sheet says so and
  offers "Delete earlier versions" (`delete_earlier_versions`: every version but the current one,
  v1 included, and their files once unreferenced; a linked document's external file never) or
  "Keep them". The confirm dialog says this is coming.
- Verified (sanitize.node.test.ts): a document that names the redacted line's words in every one of
  those places, with an unrelated neighbour next to each, is checked with pdf.js (metadata, XMP,
  outline, destinations, attachments, scripts, labels, widgets, notes), a raw + inflated byte search
  (no trace, positive control first) and `qpdf --check`; the neighbours stay. Every P2 sample
  (annotations, forms, pages, redaction) passes `qpdf --check` and renders in pdf.js in the unit
  tests; CI installs qpdf.
- Partial glyph overlap: PDFium removes whole text objects / glyphs that meet the quads, so a mark
  that clips a line removes those glyphs entirely (safer than keeping them).

## Update 2026-10-12 (P2 follow-ups)

- **The confirm dialog lists the side effects before anything happens.** The worker runs the whole
  redaction on a scratch copy (`redactionPreview`) and reports:
  - the notes elsewhere that go because they share a redacted word (quoted, up to three);
  - whether an owner password and its permissions will be dropped.

  For a linked document, the dialog also says that the original outside Selis still contains the
  text. The list is what applying will do, because it is computed by the same code.
- **Fields left without a widget leave `/AcroForm /Fields`.** A field whose only widget was under a
  mark was kept with its name and tooltip; now it goes (and so do widget kids that are on no page).
- **Deleting earlier versions** asks for an explicit destructive confirm first. Rows go in one
  transaction, and files are removed only after the commit. Only library-owned files are removed:
  a linked document's external file never is (unit test). When the library opens, a sweep removes
  any file in the library-owned folders that no row refers to: what a crash between the commit and
  the file removals would leave behind.
