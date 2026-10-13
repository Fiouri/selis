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
- English and Greek (English by default; Greek in Settings → Language), light / dark / sepia themes.

Planned (see [docs/SPEC.md](docs/SPEC.md)): OCR, scanning and `.selispack` export.

## Transfer (device to device, no account)

Send documents straight to your other device:

1. **Send** tab: choose documents (optionally with their version history) → a QR code and a
   `selis://transfer/…` link appear (valid once, for 10 minutes).
2. On the other device, **Receive** tab: scan the code (or paste the link; the system camera app
   can open the link too).
3. Both screens show the same 6-digit code. The sender confirms only if it matches.
4. The documents arrive verified (BLAKE3) in the other library, labelled "received". An
   interrupted transfer resumes where it stopped, even after the app was closed.

After a transfer you can **save the device**: next time it is one tap (no QR code) while the
other device has its Receive tab open. **Move whole library** (Send tab) sends everything —
documents with versions, tags, favorites, signatures and settings — to a new phone; documents it
already has are skipped, so running it again changes nothing.

Devices connect directly when they can (same Wi‑Fi, or across networks), otherwise through an
encrypted relay. Settings › Transfer: **Local network only** (no relay, no address lookup) or your
own **relay**. Nothing touches the network until you open the Transfer screen. Details:
[docs/PRIVACY.md](docs/PRIVACY.md), protocol: [ADR 0010](docs/adr/0010-transfer-protocol.md).

Developers: `cargo run -p selis-transfer --example selis-peer -- send <file.pdf>` (or
`receive <link>`) is a terminal peer for testing against the app.

## Privacy

Selis collects nothing. There is no account, no analytics, no crash reporting and no network
access at startup. Your library lives in the app's private storage on your device. The network is
used only by Transfer, while you use it: see [docs/PRIVACY.md](docs/PRIVACY.md).

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
| `crates/selis-transfer` | Peer-to-peer transfer (iroh): tickets, handshake, gated blobs, resume; `selis-peer` dev CLI |
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
