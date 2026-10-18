# Changelog

All notable changes to Selis are documented here. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (ADR 0020: `X.Y.Z` and `X.Y.Z-rc.N`).
The store "What's new" texts (`fastlane/metadata/android/*/changelogs/<versionCode>.txt`) are
short summaries of these sections.

## [Unreleased]

### Added

- Scan 2.0 (ADR 0032): automatic capture when the page is steady and sharp (progress ring,
  haptic, "Auto" switch, on by default; the shutter always works), hints "Hold steady",
  "Move closer", "More light needed" (turns the flash on); an Enhance filter, the new default,
  that removes shadows and uneven light in colour; batch review — open a page to change its
  corners or filter, rotate it, touch up a mark, retake or delete it, drag pages to reorder;
  ID card mode: front and back on one A4 page at 85.6 × 54 mm.

## [1.0.0-rc.1] - 2026-10-16

First release candidate of the mobile 1.0 (Android, iOS). Desktop builds come with 1.0 of the
desktop shell (P6).

### Added

- Library: import from the file picker, "Open with" and share; grid and list, sort, title
  search, favorites, tags, recents, thumbnails; rename and delete. Imports are copies — the
  original file is never written.
- Viewer: virtualised scroll for documents of 1000+ pages, pinch and double-tap zoom,
  thumbnails, outline, full-text search, text selection and copy, rotate view, night mode.
- Annotate: highlight, underline, strike-through, pen, shapes, text, sticky notes, eraser,
  undo/redo. Every save is a new version; autosave and crash recovery of the working copy.
- Forms and signatures: fill AcroForm fields, flatten; visual signatures (draw, type, picture),
  saved for reuse.
- Pages: reorder by drag, rotate, duplicate, delete, insert blank or from another PDF (form
  fields stay fillable), extract, split.
- Redaction: content under a box is removed from the file, not covered; whiteout with new text;
  delete earlier versions that still hold the redacted text.
- Transfer between devices without an account (iroh): QR code or link, 6-digit confirmation
  code, end-to-end encrypted, resumes after a drop; trusted devices; move the whole library;
  "Local network only" and a custom relay in Settings.
- `.selispack` files: export documents or the whole library to one file, optionally protected
  with a passphrase (Argon2id + XChaCha20-Poly1305), and import them.
- Tools (qpdf): protect with a password, remove a password, compress, optimise for the web,
  repair.
- Images to PDF (system photo picker, photo metadata removed) and save a page as PNG or JPEG.
- Document scan with the camera: page edge detection, perspective correction, filters, several
  pages into one PDF.
- Text recognition (OCR, Greek and English, on the device) makes scanned pages searchable.
- Settings: theme (light, dark, sepia), language (English, Greek), app lock, version retention.

### Security

- No network at startup; the network is used only while the Transfer screen is open (or a
  transfer you started is running).
- No analytics, crash reporting, advertising or account; nothing is collected
  ([PRIVACY.md](docs/PRIVACY.md)).

[Unreleased]: https://github.com/Fiouri/selis/compare/v1.0.0-rc.1...HEAD
[1.0.0-rc.1]: https://github.com/Fiouri/selis/releases/tag/v1.0.0-rc.1
