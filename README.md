<p align="center">
  <img src="apps/app/assets/icon.svg" width="96" height="96" alt="Selis logo">
</p>

<h1 align="center">Selis</h1>

<p align="center">A free, open-source PDF editor for Android, iOS, Windows, macOS and Linux — your documents never leave your device.</p>

<p align="center"><strong>No ads · No tracking · No account · No cloud</strong></p>

<!--
  Store badges (App Store, Google Play, F-Droid, Obtainium, GitHub Releases, winget,
  Microsoft Store) and the Exodus Privacy badge go here once real listings exist.
  Official artwork lives in docs/badges/. Do not add placeholder links.
-->

> **Status:** early development (P0 — foundation). Not yet released anywhere.

## Features

Available now (P0):

- Import PDFs into an on-device library — the original file is never modified.
- Fast viewer for large documents (1000+ pages): virtualized scrolling and pinch-zoom.
- Greek and English, light / dark / sepia themes.

Planned (see [docs/SPEC.md](docs/SPEC.md)): annotations, signatures, forms, page tools,
redaction, OCR, scanning, and device-to-device transfer without an account.

## Privacy

Selis collects nothing. There is no account, no analytics, no crash reporting and no network
access at startup. Your library lives in the app's private storage on your device.

## Build from source

Requirements: Node 22 (`.nvmrc`), Rust 1.98.1 (`rust-toolchain.toml`), and the
[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform
(Windows: MSVC build tools + Windows SDK). Android: Android Studio, JDK 17, NDK 27 (`NDK_HOME`).

```sh
npm ci
npm run fixtures                         # generate the test PDF corpus
npm run tauri -- dev                     # desktop
npm run tauri -- android dev             # Android emulator or USB device
npm run tauri -- android build --debug --apk
```

Run the UI in a browser with an in-memory backend (no Rust needed):

```sh
npm run dev:mock -w @selis/app
```

Checks: `npm run verify:tier1` (TypeScript, ESLint, Vitest, rustfmt, Clippy, cargo test, cargo-deny).

## Repository layout

| Path | What |
| --- | --- |
| `apps/app` | The Tauri app: React UI (`src/`) and Rust shell (`src-tauri/`) |
| `crates/selis-core` | Library index (SQLite), versions, atomic file store, BLAKE3 |
| `crates/selis-transfer` | Peer-to-peer transfer (planned, P3) |
| `packages/engine` | PDF engine wrapper (EmbedPDF / PDFium WASM in a Web Worker) |
| `packages/ui` | Design tokens and UI primitives |
| `packages/fixtures` | Synthetic PDF test corpus generator |
| `docs/` | Spec, architecture decisions (ADRs), spike reports |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
Security issues: please follow [SECURITY.md](SECURITY.md).

## Translations

Selis ships in Greek and English. Strings live in `apps/app/src/i18n/*.json` (ICU message
format). New languages are welcome once the UI stabilizes.

## License

Selis is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for third-party
components.
