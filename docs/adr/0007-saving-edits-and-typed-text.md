# ADR 0007 — Saving edits (working copy → versions) and typed text as embedded-font stamps

- Status: accepted
- Date: 2026-10-11

## Context

P2 edits documents in the PDF engine (EmbedPDF / PDFium WASM in a Web Worker). Every save must
become a new version in `selis-core` (BLAKE3, temp → fsync → rename), originals are never
overwritten, edits must survive a crash, and all writes go through the IPC reliability layer
(ADR 0005). Three constraints shaped the design:

1. **The bytes live in the WebView.** Only the engine can write the edited PDF (`saveAsCopy`).
   On Android, Tauri's IPC cannot carry a request body (the custom protocol is unused there);
   binary arguments are serialized to JSON as number arrays (≈ 4 bytes of JSON per byte). One
   message with a 50 MB PDF would cost ~200 MB of strings on the way, against the 600 MB gate.
2. **A version per keystroke is useless.** Retention keeps 10 versions / 200 MB per document;
   autosaving every few seconds as a version would push real history out within a minute.
3. **PDFium's FreeText appearance knows only the standard-14 fonts**, which have no Greek. A
   Greek FreeText annotation rendered almost nothing (measured: 206 vs 2440 dark pixels for the
   same box in Latin; `packages/engine/src/annotations.node.test.ts`).

## Decision

**Upload in base64 chunks.** The UI sends the engine's bytes as 3 MiB chunks, base64-encoded
(`lib/save.ts`; native `Uint8Array.toBase64` where available, else `FileReader`), to
`upload_chunk(upload_id, offset, data)`. A chunk is keyed by its offset, so a repeat after a lost
reply is not written twice (short call with retry). Uploads live under `work/uploads/` and are
deleted on startup (the sender is gone).

**Working copy, then version.**

- *Autosave* (3 s after the last edit, and when the app goes to the background):
  `commit_working_copy` turns the upload into `work/<document id>.pdf` (fsync + rename) and records
  the version it is based on (`working_copies.base_blake3`). Not a version.
- *Save* (leaving annotate mode with "Done", X or system back, and closing the document):
  `save_version` (long call, request id) hashes the working copy, moves it to
  `library/<blake3>.pdf`, inserts the next `versions` row, points the document at it (linked
  documents keep their external original and read their newest version) and applies retention.
  Identical content is not stored again. A working copy based on an outdated version is refused
  (`conflict`).
- *Crash recovery*: on open, a working copy based on the current version is offered back
  ("Recover" makes it an `auto` version; "Discard" deletes it; dismissing keeps it for next time).
  One whose base is outdated is dropped.
- The `documents_blake3_imported` unique index becomes a plain index: after edits, two documents
  may legitimately hold the same content.

**Undo/redo** is our own command stack per open document (`features/annotate/session.ts`), not
EmbedPDF's history plugin: we use the headless engine, and every edit has an exact inverse
(add ↔ remove by `/NM`, replace ↔ replace).

**Typed text is a Stamp annotation whose appearance holds real text objects** in an embedded
Latin + Greek font: "Selis Sans", a subset of Noto Sans Regular (OFL-1.1, renamed because the
OFL reserves the name "Noto Sans" for unmodified versions; `packages/engine/scripts/subset-font.sh`),
~55 KB, embedded once per document. `/Contents` carries the plain text for reviewers' comment
lists, `/NM` starts with `selis-text-`, and the style (size, color) is kept in a private `/SelisText`
key so Selis can read it back. Every other kind uses the standard subtypes (Highlight, Underline,
StrikeOut, Ink, Square, Circle, Line, Text) with PDFium-generated appearance streams.

## Consequences

- Saving a large document costs one extra copy of it in the WebView (the engine's output buffer)
  plus one 4 MiB string at a time; never the whole file as JSON.
- A crash loses at most the last 3 s of edits; nothing is ever written over a version or an
  original.
- Typed text renders the same in every reader (Chrome's PDFium viewer checked; pypdf strict
  parse checked), but other editors treat it as a stamp: they can move or delete it, not edit
  its text. Acceptable for v1; a FreeText with a custom appearance stream can replace it later
  without changing stored documents' readability.
- `@embedpdf/engines` internals used here (`cache.getContext`, `convertDevicePointToPagePoint`,
  `setPageAnnoRect`) are pinned by Node tests against the version in `package.json`.
