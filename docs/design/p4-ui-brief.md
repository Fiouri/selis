# Selis — P4 Power tools, phone UI brief (2026-10-14)

No new mockup (P4 prompt): every screen reuses a component or pattern that already ships, named
under "Precedent". Global rules from `p1-ui-brief.md` apply unchanged: tokens only, 44×44 minimum
targets, Lucide icons 22 px / 1.75, sheets from `components/Sheet`, rows `min-h-14` (56 px) with
a 22 px icon, en primary + el translation, light/dark/sepia, `prefers-reduced-motion` honoured,
no layout shift (fixed-height placeholders while busy).

## 0. Entry points

- **Viewer ⋮ (More sheet)**: a new row "Tools" (`Εργαλεία`, icon `Wrench`) between "Redact" and
  "Rotate view", chevron right → opens the Tools sheet for the open document.
- **Library document menu** (long-press / ⋮ on a card): a row "Tools" in the same position style
  as "Share" → the same Tools sheet, without opening the viewer.
- **Library**: the "Import PDF" FAB keeps its action (every flow and habit relies on it). A small
  secondary FAB above it (48×48, radius 16, `--surface-raised`, 1 px `--neutral-5`, icon
  `ImagePlus`, label "Images to PDF") opens the photo picker; P4c stacks "Scan" the same way. The
  empty library offers "Images to PDF" as a ghost button under "Import PDF".

## 1. Tools sheet (P4a; rows added by P4b–P4d)

Precedent: `ViewerMoreSheet` (title hidden visually, rows 56 px, chevron for rows that open a
second sheet). Title "Tools" / "Εργαλεία".

| Row | Icon | en | el | Phase | Opens |
| --- | --- | --- | --- | --- | --- |
| Protect | `LockKeyhole` | Protect with a password | Προστασία με κωδικό | P4a | Protect sheet |
| Unprotect | `LockKeyholeOpen` | Remove the password | Αφαίρεση κωδικού | P4a | Remove sheet |
| Compress | `Shrink` | Make the file smaller | Μείωση μεγέθους | P4a | runs, then result card |
| Linearize | `Gauge` | Optimise for fast web view | Βελτιστοποίηση για γρήγορη προβολή | P4a | runs, then toast |
| Repair | `Wrench` | Repair the file | Επισκευή αρχείου | P4a | runs, then toast |
| Export image | `Image` | Save page as image | Αποθήκευση σελίδας ως εικόνα | P4b | Export image sheet (viewer only; from the library: disabled, "Open the document to choose a page") |
| OCR | `ScanText` | Make text searchable | Αναζήτηση στο κείμενο (OCR) | P4d | OCR sheet |

- Rows that do not apply are not hidden (no layout shift) but disabled with a one-line reason
  under the label (13 px, `--neutral-11`): Protect on a protected file "Already protected";
  Remove on an unprotected file "No password to remove"; Compress / Optimise / Repair on a file
  that needs a password "Remove the password first" (qpdf would need the password; v1 does not
  ask for it there).
- One operation at a time: while one runs, the sheet shows a `Busy` row (spinner + "Working…" /
  "Γίνεται επεξεργασία…") in place of the rows, fixed height = the rows' height.
- Every operation makes a **new version** (the original and earlier versions stay, as for every
  edit). Success toast names it: "Saved as a new version." / "Αποθηκεύτηκε ως νέα έκδοση."
- A document with a user password opens in the viewer through the Unlock sheet (§3). Editing
  (Annotate, Sign, Pages, Redact, Fill form) is not supported on it in v1: the dock keeps its
  layout and a tap shows the toast "Remove the password to edit." instead of entering the mode.
- Pending edits become a version before the Tools sheet opens (tools work on the current
  version); a document with an unrecovered working copy is refused with "Save your edits first."

## 2. Protect / Remove password sheets (P4a)

Precedent: the `.selispack` export sheet (`PackSheets.tsx`: `PassphraseFields`, min-length and
mismatch alerts, `Busy`, primary button) and its passphrase sheet.

- **Protect**: title "Protect with a password". Fields: "Password" + "Password again" (type
  password, `autoComplete="new-password"`, 48 px high), min 8 characters as for packs ("At least 8
  characters."), at most 127 UTF-8 bytes (AES-256 R6), mismatch alert as for packs. Group "Restrict" (collapsed by default, a
  disclosure row 56 px): switches "Allow printing", "Allow copying text", "Allow changes"
  (all on by default) + "Owner password (optional)" field; restrictions need an owner password
  that differs from the open password ("Use a different owner password."). Warning line
  (`--warning-11`, 13 px): "Without the password the file cannot be opened. There is no way to
  recover it." Primary button "Protect" (disabled until valid). Encryption is always AES-256.
- **Remove password**: title "Remove the password". One field "Current password"; primary
  "Remove". Wrong password → inline alert "Wrong password." (field keeps focus, nothing saved).
- Passwords never leave the sheet except in the single command call; fields are cleared on
  close and after the call.

## 3. Unlock (viewer, P4a)

Precedent: the pack passphrase sheet ("This file is protected" + field + "Open").

- Opening a document with a user password shows, instead of the "coming soon" error, the viewer
  skeleton with a sheet: title "This document is protected" / "Το έγγραφο προστατεύεται",
  field "Password", primary "Open", secondary "Back to library". Wrong → "Wrong password.".
- The password lives only in memory for that viewer session (never stored); leaving the viewer
  forgets it. Library thumbnails of a protected document show the lock placeholder (icon
  `LockKeyhole` 32 px on `--neutral-3`), not a rendered page.

## 4. Compress result (P4a)

Precedent: the pack import result card (`Card` with title, centred count line, actions).

- Card: "Made smaller" / "Το αρχείο μίκρυνε", line "4.2 MB → 3.1 MB (−26%)" (tabular nums),
  button "Done". When the result is not smaller: "Already as small as it gets — nothing was
  changed." / "Δεν μπορεί να μικρύνει άλλο — δεν άλλαξε τίποτα." (no version is created).
- Lossless only: no image recompression in v1.

## 5. Images to PDF (P4b)

Precedent: the Transfer "Choose documents" list (rows with a checkbox) and the Pages grid
(3-column thumbnails, long-press drag to reorder).

- From the "Images to PDF" button: the system photo picker (Android photo picker / iOS
  PHPicker, multi-select, no storage permission). Then a full-screen "Images to PDF" (top bar:
  close, title, count, "Add photos"): 3-column grid of 240 px thumbnails; each tile has ✕
  (remove, 44×44) and ‹ › (move earlier / later, 44×44) — buttons rather than drag over a
  scrolling photo grid. Footer: segmented control "Page size": "Fit image" / "A4" / "Letter"
  (default Fit image), the privacy line, primary "Create PDF". Progress `Busy` "Creating the PDF…". Result: the new document opens in
  the viewer. Location and other photo metadata are never copied (stated in the screen's help
  line: "Photo details such as location are not copied.").

## 6. Save page as image (P4b)

Precedent: the pack export sheet (radio group + primary button).

- Sheet "Save page as image": radio "PNG" / "JPEG"; radio "Resolution": "Screen (96 dpi)",
  "Print (150 dpi)" (default), "High (300 dpi)" — options above the device cap are disabled with
  "Too large for this device" (cap = the adaptive render limits). Line "Page 3 · 2480 × 3508 px".
  Primary "Save" → share sheet (Android) or save dialog (desktop); toast "Page saved as an image."

## 7. Scan (P4c)

Precedent: the QR scanner screen (ADR 0013: full-bleed camera, top bar with close, permission
denied state with "Open settings" and a fallback action).

- Camera screen: full-bleed preview, live quad outline (2 px `--accent-9`, 20% fill), bottom bar
  (safe-bottom + 96 px): thumbnail of the last page (44×44, count badge), shutter 72 px circle,
  flash toggle 44×44 (only when the device has one). Top bar: close, "Scan" title, page count.
- After capture: "Adjust corners" screen — the still with 4 handles (44×44 touch targets, 20 px
  visual), magnifier while dragging; buttons "Retake" / "Keep". Filter chips (44 px, as Library
  chips): "Original", "Grey", "Black & white".
- Queue: Pages-grid style grid of scanned pages (reorder, delete), primary "Save as PDF" → new
  document in the library → viewer.
- Camera denied: same empty state as the QR scanner, actions "Open settings" and "Choose
  photos instead" (→ Images to PDF).

As built (P4c, ADR 0016): the Scan FAB (`ScanLine`, 48×48) sits above the Images FAB; the empty
library offers "Scan a document" as a ghost button above "Images to PDF". The camera screen is
always dark (like the QR viewfinder); Adjust corners and the queue follow the theme. "Open
settings" is Android only (elsewhere "Try again"). Leaving with scanned pages asks "Discard N
scanned pages?" (Discard / Keep scanning). The queue grid uses the Images-to-PDF tiles (move
earlier / later, remove), with "Add page" and "Save as PDF"; the result opens in the viewer and
a toast says "Scan saved to the library."

## 8. OCR (P4d)

Precedent: the transfer progress card (`Progress` bar, per-item line, Cancel, Resume).

- Sheet "Make text searchable": languages "Greek + English" (default) / "Greek" / "English"
  (radio), switch "Include pages that already have text" (off), primary "Start".
- Running: card in the viewer under the top bar (fixed 88 px): "Reading page 3 of 12…",
  `Progress`, "Cancel". Cancelled/interrupted: "Stopped at page 3 of 12" + "Resume" (completed
  pages are kept). Done: toast "Text is now searchable — saved as a new version."

## Accessibility

- Every icon button has an `aria-label`; switches use `role="switch"` + `aria-checked`; alerts
  `role="alert"`; progress has `aria-valuenow`/`aria-valuetext` ("Page 3 of 12").
- TalkBack: the Tools rows read "Protect with a password, button"; disabled rows read their
  reason ("Remove the password, unavailable, No password to remove").
- Snapshots (`visual-390`): Tools sheet, Protect sheet with an error, Unlock sheet, Compress
  result — en and el, light/dark/sepia (P4a); later phases add theirs.
