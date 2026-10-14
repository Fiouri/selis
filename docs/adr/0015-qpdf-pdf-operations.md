# ADR 0015 — PDF file operations on qpdf (P4a)

- Status: accepted
- Date: 2026-10-14

## Context

P4 asks for password protection (AES-256), removing a password, lossless compression,
linearization ("fast web view") and repair. PDFium (the viewer engine, ADR 0002) reads encrypted
files but cannot encrypt, linearize or rebuild a damaged file. MuPDF is AGPL (forbidden).
Pure-Rust options are young or partial: `flpdf` 0.10 (MIT/Apache, "modeled on qpdf", weeks old),
`lopdf` 0.45 (MIT; no linearization, repair is not a goal). qpdf (Apache-2.0) is the reference
implementation for exactly these operations and is what the test oracle already uses.

## Decision

`crates/selis-pdfops` wraps **qpdf 12.4** through the `qpdf` crate 0.3.7 (MIT/Apache) with the
`vendored` feature: qpdf's C++ sources, zlib and libjpeg are compiled by `cc` into the app;
**native crypto only** (qpdf's own AES/SHA-2/RC4, no OpenSSL or GnuTLS). Exact pin `=0.3.7`.

- **Operations, file to file**: Protect = AES-256 (revision 6) only, open password + optional
  owner password and permissions (print, copy text, changes); restrictions require an owner
  password different from the open password. Remove = needs the open password. Compress =
  object streams, streams decoded at the "generalized" level and re-encoded with Flate (images
  untouched: lossless), unreferenced objects dropped; **no version if not smaller**. Linearize
  (no version if already linearized) writes **without object streams**: with them qpdf 12.4
  writes wrong outline hint tables (`qpdf --check` warns; the 1000-page fixture after Compress,
  regression test), so a linearized file can be a little larger. Repair = qpdf's recovery, then a rewrite; no version if
  the file reads without a warning and passes `qpdf --check`.
- **Every operation is a new version**: `selis-core` hands out the current version's file and a
  path in the work folder (`begin_tool_run`); the output becomes the next version through the
  working-copy path of `save_version` (fsync, rename, one transaction) or is deleted
  (`abandon_tool_run`). Refused with unsaved edits or if the document changed meanwhile.
  Protect also drops the document's thumbnail (no picture of page 1 outlives the protection).
- **Passwords** cross the IPC once, become `selis_pdfops::Password` (`Zeroizing<String>`, a
  `Debug` that prints nothing), and are dropped after the call; never stored, logged or kept in
  the request results. qpdf copies them internally (the wrapper's `String`/`CString`, C++
  `std::string`): those copies are freed but not wiped — accepted, qpdf offers no API for it.
- **Memory**: qpdf reads objects lazily and streams the output, but holds each stream it writes
  in memory first (to write its length). A 2.2 GB file of 550 pages stays at ~20 MB RSS; a file
  whose single stream is 2.2 GB needed 5.4 GB (and linearizing it fails: qpdf's hint tables are
  32-bit). Files with any stream over **512 MiB** (declared `/Length`) are refused up front
  (`tooLarge`), so no operation can get the app killed. Measurements: docs/spike-p4.md.
- **Viewer**: a document with an open password asks for it (unlock sheet; the password lives in
  that viewer session only). Editing such a document is not supported in v1 (a toast says
  "Remove the password to edit."). Compress/Linearize/Repair on it say "Remove the password
  first".

### Build

- Desktop (Windows, macOS, Linux): the crate ships pre-generated bindings; needs a C++ compiler.
- Android: no pre-generated bindings, so `bindgen` runs (libclang from the host's LLVM, found by
  `clang-sys`). It must see the NDK's headers: `scripts/tauri.ts` (the `npm run tauri` wrapper)
  sets `CLANG_PATH` to the NDK's clang when `NDK_HOME` is set. qpdf links the NDK's **static
  libc++** (`CXXSTDLIB_<target>=c++_static`, `.cargo/config.toml`) plus `-lc++abi`
  (selis-pdfops' build script), so the APK keeps a single `.so` (no `libc++_shared.so`).
- iOS: bindgen with Xcode's clang (CI only, no Mac here).
- 32-bit Android ABIs: offsets beyond 2 GB fail cleanly in qpdf (`long` seek), 64-bit ABIs and
  desktops are unaffected.

## Consequences

- APK size: +1.5 MB per ABI (arm64 release with LTO: APK 23.3 → 24.8 MB, `.so` 20.5 → 21.9 MB).
- Licenses (NOTICE): qpdf Apache-2.0 (with its public-domain Rijndael and sphlib's MIT-style
  SHA-2), zlib License, IJG License ("based in part on the work of the Independent JPEG
  Group"). `cargo deny` sees the crates as MIT/Apache; the C/C++ licenses are tracked by hand.
- Verification: Rust tests (round trip keeps every page content stream BLAKE3-identical, wrong
  password writes nothing, restrictions, legacy RC4 removal, compress once, linearize once,
  repair of a broken xref, the stream limit); every output passes `qpdf --check`. On devices
  `tools.yaml` + `tools.sh check` (qpdf CLI and pdf.js on every version pulled from the device).
- Tests: on Windows a child process inherits the handles open at that moment and qpdf opens
  the file it writes exclusively, so the qpdf tests run one at a time (the app spawns no
  processes while a tool runs).
- Not covered: editing encrypted documents, removing an owner-only protection, image
  recompression (lossy) — not in v1.
