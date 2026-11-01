# Selis — rules for Claude Code

Source of truth: `docs/SPEC.md`. Decisions: `docs/adr/`. When code and spec disagree, stop and ask.

## Priority: mobile-first

**Android → iOS → desktop.** Every UI change is designed and verified on a phone first
(PhoneShell, emulator + physical device). iOS builds in CI only (no Mac). Desktop targets must
compile in CI but get no UI polish until P6.

## Stack (pinned — see lockfiles)

- Tauri **2.12.x** (crate `tauri` 2.12.3, wry 0.57, CLI 2.12.2, `@tauri-apps/api` 2.12.3,
  plugin-dialog 2.8.2, plugin-fs 2.7.0). The line moves as one change: crates, CLI and
  `@tauri-apps/*` together (ADR 0001); never `cargo update` single Tauri crates across a minor.
  `jni` stays equal to wry's (0.21.1).
- React 19 + TypeScript 6 (strict) + Vite 8, Tailwind v4, Zustand, TanStack Query, i18next + ICU.
- PDF engine: EmbedPDF **v2** (PDFium WASM) inside `packages/engine` only, in a Web Worker.
- PDF file operations: `crates/selis-pdfops` on **qpdf 12.4** (`qpdf` crate `=0.3.7`, vendored,
  native crypto; ADR 0015). Android builds need LLVM's libclang on the host (bindgen) and go
  through `npm run tauri` (`scripts/tauri.ts` points bindgen at the NDK clang); static libc++.
- Rust core: `crates/selis-core` (rusqlite bundled, BLAKE3, atomic writes). IPC types via
  tauri-specta → `apps/app/src/lib/ipc/bindings.ts` (generated; never hand-edit), wrapped by the
  reliability layer `lib/ipc/reliable.ts` (ADR 0005: long-running commands take a `request_id`,
  run once per id via `RequestResults::run_once`, and are recoverable with `take_result`).
- Package manager: npm workspaces. Node 22 (`.nvmrc`), Rust 1.98.1 (`rust-toolchain.toml`).

## Forbidden

- Dependencies: **pdf-lib**, **MuPDF** (AGPL), **pdf.js** as an engine (only the test oracle `packages/fixtures/src/oracle.ts` may use it, to check produced files), anything **GPL/AGPL**
  (enforced by `deny.toml` for Rust; check npm licenses by hand), telemetry/analytics/crash SDKs,
  ads, remote fonts or CDNs (fonts are self-hosted; EmbedPDF font fallback stays `null`).
- Network at startup. Only `crates/selis-transfer` (P3) may open connections, and only while
  the Transfer screen is open.
- Direct filesystem/network access from the UI. The UI talks to Rust through `lib/api.ts`
  (wrapping `lib/ipc`) and reads library files via the scoped asset protocol.
- Hardcoded UI strings: every user-visible string goes through `t()` with keys in
  `apps/app/src/i18n/en.json` (ESLint `selis-i18n/no-hardcoded-strings`). English first (ADR 0030
  amendment): new keys go to en.json only; el.json is filled in the `translation-pass` PR before
  each release candidate (missing Greek keys warn in CI until then, fail there and on tags;
  Greek Playwright/visual sets run only there).
- Secrets in the repo: keystores, Apple certificates, signing keys live in CI secrets only.

## Runtime requirements

- Android System WebView **≥ 111** (ES2022, CSP `'wasm-unsafe-eval'`, Tailwind v4 CSS).
  `MainActivity.kt` shows a native "update WebView" dialog below that (ADR 0031). Below Android 14
  (foreground-service transfers) test on the AVD `selis-api33x5-play` after
  `scripts/avd-webview-update.sh emulator-5554 <its serial>` (its image ships WebView 109).
- Render quality/memory adapt to device RAM (`packages/engine/src/limits.ts`); keep the
  1000-page spike under budget on every tier when touching the viewer or engine.
- Saving (ADR 0007): engine bytes → `upload_chunk` (base64) → working copy (autosave, 3 s) →
  `save_version` (a version). Never send a whole PDF in one IPC message.

## Never overwrite originals

Imports copy the picked file into app data (`$APPDATA/library/<blake3>.pdf`); the source is
opened read-only (Android SAF descriptor mode `r`). Every write uses `selis_core::atomic_write`
(temp → fsync → rename). Saving back to an original requires an explicit "Save to original"
action (not in P0).

## Boundaries

- `src-tauri/src/commands/` are thin: validate → call `selis-core` → typed result.
- Only `packages/engine` imports `@embedpdf/*` (ESLint-enforced in the app).
- Capabilities are least-privilege (`capabilities/mobile.json`, `desktop.json`); every app
  command is deny-by-default (`build.rs` app manifest) and must be granted explicitly.
- New architectural decisions get an ADR in `docs/adr/`.
- UI follows the approved phone brief `docs/design/p1-ui-brief.md` (exact sizes, copy, states).

## Releases

- Version: one source, the root `package.json` `version` (`X.Y.Z` / `X.Y.Z-rc.N`); change it only
  with `node tools/release/version.ts set <v>` (derives app/lock/Cargo/tauri.conf, Android
  versionCode, iOS build; ADR 0020) and add its `CHANGELOG.md` section. CI runs `version.ts check`.
- Android release artifacts: `.github/workflows/release-android.yml` (ADR 0021) — unsigned
  builds, `scripts/check-android-release.sh` (16 KB LOAD + RELRO, zipalign -P 16, SDK levels,
  versionCode, no debug code), signing from secrets only (`scripts/android-keystore.md`),
  reproducible second build. No tags are pushed without the owner's go.
- Release signing happens **only in CI** (GitHub secrets → `scripts/android-sign.sh`; ADR 0021
  amendment 1). No Gradle `signingConfig`, no local release-signing script, no `Signing.psm1`,
  and no signing password in `gradle.properties`, `keystore.properties` or environment variables.
  `F:\keys` holds the keystores only for one-off owner tasks (key generation, PEPK export, the
  upload certificate, GitHub secrets); never for builds. Claude never reads it.
- Store, F-Droid and name-check drafts: `docs/store/`. Listings in `fastlane/metadata/`; store
  screenshots (English only; other locales use en-US) with `apps/app/e2e/maestro/store-screenshots.sh <serial> en light|dark` on the AVD
  (release `measure` build; 7 screens, the last one Scan's Adjust step from the sample photo
  `docs/store/scan-sample/`, made by `node tools/store/scan-sample.ts`); App Store screenshots from
  the iOS simulator in CI (`ios-screenshots.yml`, Maestro flow `apps/app/e2e/maestro/ios/`, 6.9" +
  6.3" iPhone and 13" iPad, en → `fastlane/screenshots/en-US/`; ADR 0029; CI guard `scripts/check-store-images.sh`); graphics with
  `node tools/store/render-graphics.ts`; website in `website/` (`node website/build.ts`,
  Lighthouse ≥ 95 in `pages.yml`; ADR 0024).
- RC QA on release builds: `apps/app/e2e/maestro/release-suite.sh <serial>` (run-as checks are
  debug-only); results in `docs/release/`.

## Git workflow

Every change goes branch → PR → `gh pr merge --auto --squash`; never push to `main` directly.
`main` is protected (PR required, the 4 CI jobs required, branch up to date, no admin bypass),
so the PR merges itself once CI is green and the head branch is deleted. Commit messages stay
Conventional Commits.

## Verification

Tier 1 — every change (`npm run verify:tier1` runs all of it):

- `npm run typecheck` (tsc --noEmit on every workspace)
- `npm run lint` (eslint, 0 warnings)
- `npm test` (vitest: engine with real PDFium WASM, fixtures, ui tokens, app)
- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test --workspace`, `cargo deny check`
- Transfer diagnostics (debug builds): `adb shell setprop debug.selis.rust_log
  warn,iroh=debug,iroh_blobs=debug,selis_transfer=trace`, restart the app, read
  `adb shell run-as com.anywecon.selis cat cache/logs/rust.log`; the dev peer takes `RUST_LOG`.
- If a Rust command signature changes: `cargo test -p selis-app export_bindings` and commit
  `lib/ipc/bindings.ts`.

Tier 2 — end of every feature:

- `npm run tauri -- android build --debug --apk` (NDK_HOME set)
- Maestro on the emulator: `apps/app/e2e/maestro/push-fixtures.sh <serial>` then
  `apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/<flow>.yaml [runs]` for
  `import-scroll-back.yaml`, `import-background-resume.yaml`, `library-search-favorites.yaml`,
  `viewer-search.yaml`, `settings-theme.yaml`,
  and `import-from-intent.yaml` twice: with `PRE_RUN="…/open-with.sh cold"` and `…/open-with.sh warm`,
  both with `POST_RUN="…/open-with.sh check"` (original untouched), and `delete-rename.yaml` with
  `POST_RUN="…/delete-rename.sh check"` (deleted copy gone from app data, originals untouched), and
  `annotate.yaml` with `POST_RUN="…/annotate.sh check"` (original + 2 versions, annotations in the
  newest, crash-recovered working copy promoted, original untouched). And `sign-forms.yaml` with
  `POST_RUN="…/sign-forms.sh check"` (form filled and signed: original + 2 versions, AcroForm kept,
  one saved signature, original untouched). And `pages.yaml` with `POST_RUN="…/pages.sh check"`
  (original + version + extracted page, both carrying the inserted form, stage empty, originals
  untouched), then `pages.sh drag <serial>` with the grid open (long-press reorder by adb
  `draganddrop`; inspect `.tmp/p2c/drag-*.png`). And `erase.yaml` with `POST_RUN="…/erase.sh check"`
  (ADR 0033: rectangle over a line of `erase.pdf`, the signed warning, delete object; the
  database lists the import + two `erase` versions, the original's file byte-identical to the
  fixture, the newest read by pdf.js without the line and the diagonal, page 2 unchanged; AVD
  coordinates). And `redact.yaml` with `POST_RUN="…/redact.sh check"`
  (earlier versions deleted from the sheet: only the redacted version left; read by pdf.js: redacted
  lines not extracted and their glyph codes nowhere in the file, each box on its own line, no marks
  left; original untouched). `pages.yaml` inserts the form through the "Insert anyway" sheet. And `transfer.yaml` with
  `PRE_RUN="…/transfer.sh pre"` and `POST_RUN="…/transfer.sh post"` (cold start opens no socket; the
  host dev peer sends a fixture through a `selis://` link; it lands in the library; leaving the
  Transfer screen leaves no socket; needs `cargo build --release -p selis-transfer --example selis-peer`).
  And `transfer-recover.yaml` with `PRE_RUN="…/transfer.sh pre-recover"` and
  `POST_RUN="…/transfer.sh post-recover"` (debug build: the peer drops out mid-transfer; the paused
  card gives the reason, counts failed resumes, then "Get a new code"; an offered code expires after
  60 s via `debug.selis.ticket_lifetime` and "New code" replaces it; nothing left, no socket).
  And `transfer-background.yaml` with `PRE_RUN="…/transfer.sh pre-background"` and
  `POST_RUN="…/transfer.sh post-background"` (debug build, ADR 0027: a receive paced to 1 MiB/s by
  `debug.selis.receive_kbps`; the app goes Home for 60 s; ≥ 55 s away with the user-initiated
  transfer job running and ≥ 30 MB sent meanwhile; the file lands intact; no job, notification
  or socket left).
  And `pack.yaml` with `PRE_RUN="…/pack.sh pre"` and `POST_RUN="…/pack.sh check"` (.selispack: plain
  pack by "Open with" from Files, protected pack by the picker after a wrong passphrase, tampered
  pack refused; library holds exactly the three fixtures, no leftovers, packs untouched; a plain
  pack saved from the Send tab waits in `cache/share` and is gone after a restart).
  And `tools.yaml` with `PRE_RUN="…/tools.sh pre"` and `POST_RUN="…/tools.sh check"` (P4a: protect,
  reopen with the password, editing off, remove it (wrong first); compress / optimise / repair the
  1000-page fixture; every version pulled from the device passes the host's `qpdf --check` and
  pdf.js, page content streams kept, work folder empty; prints the RSS around the compress).
  And `images.yaml` with `PRE_RUN="…/images.sh pre"` and `POST_RUN="…/images.sh check"` (P4b: 20
  phone-like photos with EXIF/GPS pushed and picked in the system photo picker, ten at a time
  (`pick-ten-photos.yaml` handles both picker versions); one 20-page PDF that passes qpdf and has
  no photo metadata; a page saved as PNG through the share sheet; stage empty; prints the RSS
  around "Create PDF"). And `scan.yaml` with `PRE_RUN="…/scan.sh pre"` and
  `POST_RUN="…/scan.sh check"` (P4c: five pages through the camera — the AVD's virtual scene,
  the S23's real camera — with each filter, one 5-page PDF that passes qpdf and pdf.js; prints
  the live-detection stats and, on a real device, fails under 10 fps or on a UI frame gap over
  200 ms). Scan 2.0 (ADR 0032): `scan-auto.yaml` (`PRE_RUN="…/scan.sh pre"`,
  `POST_RUN="…/scan.sh check-auto"`: the steady virtual scene is captured with no shutter, not
  again after Keep; one automatic capture in logcat), `scan-batch.yaml` (`…/scan.sh pre-batch`,
  `…/scan.sh check-batch`: ten numbered page photos through "Scan a photo", then reorder, turn,
  remove, retake → a 9-page PDF read back in the right order) and `scan-idcard.yaml`
  (`…/scan.sh pre`, `…/scan.sh check-idcard`: one A4 page, both sides 85.6 × 54 mm ± 1). Flows
  that use the camera manually switch Auto off first (`scan-auto-off.yaml`). The scan module is Rust → WebAssembly (`crates/selis-scan`, ADR 0016), built by
  `npm run build:scan` (npm pre-scripts; needs `rustup target add wasm32-unknown-unknown`).
  And `ocr.yaml` with `PRE_RUN="…/ocr.sh pre"` and `POST_RUN="…/ocr.sh check"` (P4d: the scanned
  Greek fixture made searchable; per-page times from logcat, PSS (and RSS) of app + our WebView renderer around
  the OCR; the new version passes qpdf and pdf.js reads ≥ 95 % of the words of each page; the
  viewer's search finds an accented Greek word). OCR assets (tesseract.js worker, cores,
  tessdata_fast) are copied into `apps/app/public/ocr/` by `scripts/copy-ocr-assets.ts`.
  And `upgrade-locale.yaml` with `OLD_APK=<previous debug build> NEW_APK=<this debug build>`,
  `PRE_RUN="…/upgrade-locale.sh pre"` and `POST_RUN="…/upgrade-locale.sh post"` (ADR 0030: the
  previous build on a Greek-locale app with "Same as the device" is updated; it opens in English;
  the database is at schema 7 with locale "en"; the app's locale is reset).
  And `convert-docx.yaml` with `PRE_RUN="…/convert.sh pre"` and `POST_RUN="…/convert.sh check"`
  (ADR 0035:
  - a Word file opened "with" Selis is previewed and saved, and a second one picked through
    "Convert to PDF" is cancelled;
  - the library holds one PDF: ≥ 98 % of the words and LibreOffice's page count ± 1;
  - the originals are untouched and the stage is empty.)
  And `export-word.yaml` with `PRE_RUN="…/export.sh pre"` and `POST_RUN="…/export.sh check"`:
  - `erase.pdf` exported as Word: every word in order, and its pictures;
  - the scanned English fixture exported as Word through OCR: ≥ 90 % of its words.
  The corpus files come from `npm run convert-corpus -w @selis/fixtures`.
  run.sh fails a run on
  "ANR in com.anywecon.selis" in logcat (the emulator hides ANR dialogs). Flows read the WebView
  with `androidWebViewHierarchy: devtools` (the UiAutomator snapshot lags behind the DOM). Maestro
  2.11 sends the DevTools socket name as the WebSocket Host, which WebView 15x (the S23) rejects, so
  run the S23 with a patched copy: `tools/maestro-patch/build.sh` once (pinned upstream release,
  SHA-256 checked; see its README), then `MAESTRO=F:/DevCache/maestro-selis/bin/maestro run.sh …`.
- Playwright mobile smoke (Pixel 7 + iPhone 15, mock IPC): `npm run e2e`. The 390×844 visual
  snapshots (`visual-390`, light/dark/sepia, en + el) run on Linux only — CI is their check, with
  one Linux baseline set and exact comparison (ADR 0019; update flow in CONTRIBUTING.md).
- Windows compile check: `npm run tauri -- build --no-bundle`
- Visual changes: inspect screenshots (Playwright `test-results/screenshots`, device `adb exec-out screencap`).

Transfer measurements (P3, docs/spike-p3.md): `node scripts/measure-transfer.ts --serial <s>
--scenario recv|send|resume|expired|reuse|cold|seed|move|trusted|pack [--serial2 <s>] [--relay]
[--clear] [--clear2]` drives the app over the WebView DevTools (debug or `measure` build) against the
host dev peer (or a second device) and prints route, MB/s, RSS delta, hashes; `pack` is the
.selispack round trip (plain and protected, rerun no-op, tamper refused). Passphrase pack timing
(50 documents, 300 MB, release `measure` build): `pack-measure.yaml` with `PRE_RUN="…/pack.sh
measure-pre"` and `POST_RUN="…/pack.sh measure-times"` (docs/spike-p3.md).

Performance gate (docs/spike-p0.md): 1000-page fixture — first page < 1 s, full scroll without
crash, WebView memory < 600 MB (`adb shell dumpsys meminfo com.anywecon.selis` + renderer).
On a real device: `scripts/measure-device.sh` (builds, installs, measures, cleans up, appends to
docs/spike-p0.md). Device policy (docs/SPEC.md): phases close on the Galaxy S23 + AVD
`selis-midrange-api36`; a real mid-range device measurement is a mandatory P5 (release) gate. Its `measure` cargo feature (WebView debugging on) is for that script only; CI fails if
the store-like release APK is debuggable or contains it (`scripts/check-release-apk.sh`).

## Windows dev notes

- **Scratch files go to `F:\Projects\Selis\.tmp`** (git-ignored): APKs, logs, screenshots,
  UI dumps, spike JSON. Never write them to `%TEMP%` / `C:` (the C: drive fills up).
  Maestro/adb copy APKs into the temp dir: run them with `TMP`/`TEMP` and
  `JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=...` pointing at `.tmp`, and `maestro test --debug-output .tmp/maestro`.
- Android SDK, `~/.gradle`, `~/.android/avd` and the npm cache live on `F:\DevCache`
  (the old paths are junctions). Mid-range proxy AVD: `selis-midrange-api36` (3 GB, 1080×2340).

- TLS-intercepting proxy: `NODE_TLS_REJECT_UNAUTHORIZED=0` for npm/CLI,
  `GRADLE_OPTS=-Djavax.net.ssl.trustStoreType=Windows-ROOT` for Gradle.
- Needs MSVC build tools **and the Windows 10/11 SDK** (without it nothing links).
- Git Bash: use `MSYS_NO_PATHCONV=1` with `adb` and Windows-style paths (`F:/...`).
