# ADR 0008 — Page operations by rebuild, and merging that keeps forms fillable

- Status: accepted
- Date: 2026-10-11

## Context

P2c adds the Pages screen: rotate, delete, reorder, insert blank, duplicate, extract, merge
(insert another PDF) and split. Two constraints shaped it:

1. **EmbedPDF caches page objects per open document** (size, rotation, the page list). Changing
   the structure of an open document in place through PDFium leaves those caches stale: wrong
   sizes, wrong page count, renders of pages that moved.
2. **PDFium's page import drops the form.** `FPDF_ImportPages` / `FPDF_ImportPagesByIndex` (and
   EmbedPDF's `importPages`, `merge`, `extractPages` on top of them) copy the page objects with
   their `/Annots`, but not the catalog's `/AcroForm`. Measured on the `acroform` fixture merged
   into `mixed-sizes`: `FPDF_GetFormType` = 0 afterwards, the four widgets are orphans (no field
   in `/AcroForm /Fields`), so nothing is fillable (evidence: `docs/evidence/p2c-acroform-import-probe.txt`
   at the time of writing). The SPEC's acceptance criterion is "merging PDFs that contain AcroForm
   keeps all fields fillable"; the fallback named in the plan was pulling qpdf forward from P4.

## Decision

- **Every page operation rebuilds the document.** The worker saves the open document
  (`saveAsCopy`; these bytes are also the undo snapshot), applies the operation on a scratch copy
  opened from them, saves the result and swaps the open document for it (`replaceDocument`). The
  client's `DocHandle` gets a new page list, a bumped `structureRevision()` and tells
  `onStructureChange` listeners; render and text caches for the document are dropped. The viewer
  remounts on a structure change and resumes at the same page number.
- **Undo / redo** are EditSession commands: undo reloads the snapshot, redo applies the same
  operation again. So page operations share autosave, crash recovery and "a version on close"
  with the other editing tools (ADR 0007).
- **Forms are rebuilt after an import** (`pages.ts` `rebuildForms`) instead of using qpdf: the
  orphan widgets on the imported pages are removed and each widget of the source page is created
  again as a form field of the destination (`createPageAnnotation` with the widget's type, name,
  options, flags, rect, colors), then its value is set again (text, checked state, selection).
  PDFium then writes a proper `/AcroForm` with `/Fields`. A field name already used by the
  destination gets a suffix (`name_2`), so two merged copies of one form do not share values.
  Extract and split use the same rebuild (EmbedPDF's `extractPages` imports too).
- **Merge input is staged by Rust**: the picked file (path or `content://`, opened read-only) is
  copied to `$APPDATA/work/stage/<uuid>.pdf`, read by the WebView through the asset protocol
  (scope `$APPDATA/work/stage/*.pdf`) and removed afterwards (`unstage`); the stage is cleared on
  start. Extracted / split documents go back through the chunked upload of ADR 0007 and
  `import_upload` (a new library document; the source document does not change).

## Consequences

- Acceptance met without qpdf: after a merge the result has `/AcroForm` with all fields, values
  kept, fillable again (unit test `merging keeps forms fillable`; pypdf strict and the Chrome PDF
  viewer on the samples in the P2c PR; Maestro `pages.yaml` + `pages.sh check` on Android).
- Known losses on imported forms, accepted for P2: the field tooltip (`/TU`) is not carried (PDFium
  cannot set it on a field); push buttons and signature fields are dropped (their widgets are
  orphans and are not recreated); field actions / JavaScript and calculation order are not
  carried; a widget font PDFium cannot name is written as Helvetica. If a customer needs these,
  qpdf (P4) can take over the import step behind the same `applyPageOp` interface.
- 2026-10-12: these losses are no longer silent. Before inserting, the worker counts them in the
  picked file (`import-losses.ts`: signature fields, push buttons, field tooltips, JavaScript —
  document scripts, open / field actions, calculation order) and the pages UI lists them in a sheet
  with "Insert anyway" / "Cancel"; a file with none of them is inserted at once.
- Each operation costs a full save + reopen of the document in the worker, and holds the file
  about three times in worker memory for a moment (snapshot, result, open document). Measured on
  the 1000-page fixture (0.8 MB, PDFium WASM in Node on the dev machine): rotate 49 ms, move 10
  pages 32 ms, insert the form PDF 182 ms, extract 100 pages 31 ms. The cost follows the file's
  size more than its page count; the UI shows a busy state and disables the actions meanwhile.
