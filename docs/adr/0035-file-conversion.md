# ADR 0035 — File conversion (P7c): Office and text to PDF, PDF to Word, text and images

- Status: accepted
- Date: 2026-10-27

## Context

Testers asked for "Word to PDF" and "PDF to Word" (roadmap 1.x, P7c). Selis is offline, ships
no GPL/AGPL code and opens no network connection outside the Transfer screen. A full office
suite (LibreOffice, ~200 MB, MPL with GPL parts) is not an option on a phone, and no permissive
renderer for ODT, RTF or PPTX is good enough yet.

## Decision

### To PDF: document → HTML → the platform's own print engine

1. **Read the file into HTML** in the app (lazy-loaded chunk `packages/convert`, never in the
   startup bundle):
   - DOCX: [docx-preview](https://github.com/VolodymyrBaydalka/docxjs) (Apache-2.0), rendered
     into a detached container with images inlined as `data:` URLs (`useBase64URL`), no
     alternate-content scripts, then serialised with its styles.
   - XLSX: our own reader on [jszip](https://stuk.github.io/jszip/) (dual MIT/GPLv3: we take it
     under MIT) — shared strings, inline strings, numbers, booleans, dates by number format,
     merged cells; formulas show their cached value (nothing is recalculated). Each sheet
     becomes a table paginated by rows, scaled to fit the page width.
   - CSV: RFC 4180 reader (quotes, `""`, CRLF/LF, BOM, `,` `;` or tab detected from the
     first line) → the same tables.
   - TXT: pre-wrapped text. Markdown: our own CommonMark subset (headings, paragraphs,
     emphasis, code, lists, quotes, rules, tables); links are shown as text.
   - HTML: parsed with `DOMParser` (inert), then sanitised.
2. **Sanitise:** every converter's output goes through one allow-list sanitiser: no `script`,
   `iframe`, `object`, `embed`, `link`, `meta`, `base`, forms or event handlers; `src`/`href`
   only as `data:` (images) — every `http:`, `https:`, `file:` or protocol-relative URL is
   dropped, CSS `url()` and `@import` too. Macros in DOCX/XLSX (vbaProject) are never read.
3. **Print to PDF without a dialog** (`convert_html_to_pdf`, ADR 0005 request id):
   - **Android:** an off-screen `WebView` (JavaScript off, `blockNetworkLoads`, no file or
     content access, every request answered empty by `shouldInterceptRequest`) loads the HTML,
     then `createPrintDocumentAdapter()` is driven by hand: `onStart → onLayout → onWrite` into
     a `ParcelFileDescriptor` of a file in app data, then `onFinish`. A4 portrait, 15 mm
     margins (the HTML's `@page` rule wins when present).
     **Risk:** `PrintDocumentAdapter.LayoutResultCallback` and `WriteResultCallback` have
     package-private constructors. The callbacks are therefore subclassed from a Java file in
     the package `android.print` inside the app (`PrintCallbacks.java`) — the approach the
     dialog-less HTML-to-PDF libraries on Android use. No reflection is involved, but the
     constructors are not public SDK. Android allows the call today: on the AVD (API 36, target
     SDK 36) it links and prints without a hidden-API warning in logcat. A future Android (or target SDK) could
     block it. Then `PrintCallbacks.available()` returns false on its first call, the command
     reports `unsupported`, the "Convert to PDF" entry points hide and the rest of the app keeps
     working; the Maestro flow `convert-docx` on the AVD would show it the same day.
   - **iOS (not in this change):** `WKWebView.createPDF(configuration:)` (iOS 14+) on an
     off-screen web view with JavaScript off and a `WKContentRuleList` that blocks every
     non-`data:` load, paginated with `UIPrintPageRenderer` around the web view's print
     formatter. Selis has no iOS plugin code yet (no Swift package, no Mac to run it), so the
     first change ships Android only: on iOS the command reports `unsupported` and the entry
     points hide until that plugin exists.
   - **Desktop:** not in P7c (P6 polish); the command reports "unsupported" and the entry
     points are hidden.
4. **Preview, then save:** the PDF is written to `work/convert/`, opened read-only in the
   engine and shown page by page with the label "Layout may differ from Word/Excel". "Save"
   imports it as a new library document (the normal import path: copy, BLAKE3, atomic write);
   "Cancel" deletes it. The source file is only read (SAF descriptor mode `r`), never written.

### From PDF

- **Export as Word:** PDFium text objects per page (characters, boxes, font size, weight,
  italic flag) → lines (baseline clustering) → paragraphs (line gap and indent) → headings by
  font size against the page's body size (≥ 1.6× → Heading 1, ≥ 1.25× → Heading 2), bold and
  italic runs, images in place (rendered from the page at 150 dpi, inline at their size), a
  page break per page. Written with [docx](https://docx.js.org) (MIT). Pages without a text
  layer go through OCR first (the P4d Tesseract layer, then the same path). Label: "Editable
  text, layout simplified".
- **Export as text / Markdown:** the same lines in reading order (columns detected by a gap in
  the x-histogram), Markdown with `#`/`##` for headings.
- **Export all pages as images:** "page to image" for every page (PNG or JPEG, chosen dpi
  within the tier's pixel budget) into a ZIP (jszip, stored, no compression of PNG/JPEG).
- Exported files go to the share sheet (`cache/share`, cleaned on the next start), like packs.

### Entry points

- Library: a "Convert to PDF" button in the stack above "+ Import PDF" (next to "Images to
  PDF" and "Scan") and in the empty library. It opens the system picker for `.docx .xlsx .csv
  .txt .md .html`. It is not a menu inside "+": twelve Maestro flows and the users' habit
  rely on "+" opening the PDF picker directly.
- Android "Open with" and "Share" (VIEW + SEND intent filters for the Word, Excel, CSV, plain
  text and Markdown MIME types, no new permission). The UI picks conversion by the file name.
  A content URI without a name is recognised by its bytes: an OOXML package by its main part,
  other text as plain text.
- Viewer ⋮ → "Export": Word, Text, Markdown, All pages as images.
- The entries show only where `convert_available` is true (Android with the print callbacks
  linkable).

## Consequences

- Fidelity is that of an HTML rendition: fonts fall back to the bundled ones, floating shapes,
  text boxes, charts, SmartArt, footnote placement and exact Word pagination are lost or
  approximate. The label says so, and the gate measures what matters: words (≥ 98 % survive)
  and page count (±1 of LibreOffice) on a corpus of 20 English DOCX/XLSX files in
  `packages/fixtures`.
- New dependencies (all permissive, checked by the npm licence check): docx-preview 0.4.1
  (Apache-2.0), docx 9.11.0 (MIT), jszip 3.10.2 (MIT, from its MIT/GPLv3 dual licence; its
  pako is `MIT AND Zlib`, so the licence check now accepts an AND of allowed licences).
- The gate runs in Playwright with Chromium's own print engine (`page.pdf()`, the engine of the
  Android WebView) in a context without JavaScript that refuses every request. On the device,
  `convert-docx.yaml` checks a Word file opened "with" Selis end to end.
- The print engines are the platform's own: no new native library, no network, no new
  permission; Data safety answers stay "No data collected".
- The conversion chunks load only when a conversion starts; the startup bundle is unchanged.
