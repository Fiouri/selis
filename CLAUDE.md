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
- Rust core: `crates/selis-core` (rusqlite bundled, BLAKE3, atomic writes). IPC types via
  tauri-specta → `apps/app/src/lib/ipc/bindings.ts` (generated; never hand-edit), wrapped by the
  reliability layer `lib/ipc/reliable.ts` (ADR 0005: long-running commands take a `request_id`,
  run once per id via `RequestResults::run_once`, and are recoverable with `take_result`).
- Package manager: npm workspaces. Node 22 (`.nvmrc`), Rust 1.98.1 (`rust-toolchain.toml`).

## Forbidden

- Dependencies: **pdf-lib**, **MuPDF** (AGPL), **pdf.js** as an engine, anything **GPL/AGPL**
  (enforced by `deny.toml` for Rust; check npm licenses by hand), telemetry/analytics/crash SDKs,
  ads, remote fonts or CDNs (fonts are self-hosted; EmbedPDF font fallback stays `null`).
- Network at startup. Only `crates/selis-transfer` (P3) may open connections, and only while
  the Transfer screen is open.
- Direct filesystem/network access from the UI. The UI talks to Rust through `lib/api.ts`
  (wrapping `lib/ipc`) and reads library files via the scoped asset protocol.
- Hardcoded UI strings: every user-visible string goes through `t()` with keys in
  `apps/app/src/i18n/{el,en}.json` (ESLint `selis-i18n/no-hardcoded-strings` + parity test).
- Secrets in the repo: keystores, Apple certificates, signing keys live in CI secrets only.

## Runtime requirements

- Android System WebView **≥ 111** (ES2022, CSP `'wasm-unsafe-eval'`, Tailwind v4 CSS).
  `MainActivity.kt` shows a native "update WebView" dialog below that.
- Render quality/memory adapt to device RAM (`packages/engine/src/limits.ts`); keep the
  1000-page spike under budget on every tier when touching the viewer or engine.

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
- If a Rust command signature changes: `cargo test -p selis-app export_bindings` and commit
  `lib/ipc/bindings.ts`.

Tier 2 — end of every feature:

- `npm run tauri -- android build --debug --apk` (NDK_HOME set)
- Maestro on the emulator: `apps/app/e2e/maestro/push-fixtures.sh <serial>` then
  `apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/<flow>.yaml [runs]` for
  `import-scroll-back.yaml`, `import-background-resume.yaml`, `library-search-favorites.yaml`,
  and `import-from-intent.yaml` twice: with `PRE_RUN="…/open-with.sh cold"` and `…/open-with.sh warm`,
  both with `POST_RUN="…/open-with.sh check"` (original untouched). run.sh fails a run on
  "ANR in com.anywecon.selis" in logcat (the emulator hides ANR dialogs). Flows read the WebView
  with `androidWebViewHierarchy: devtools` (the UiAutomator snapshot lags behind the DOM).
- Playwright mobile smoke (Pixel 7 + iPhone 15, mock IPC) + 390×844 visual snapshots in
  light/dark/sepia (`visual-390`; baselines per OS, see CONTRIBUTING.md): `npm run e2e`
- Windows compile check: `npm run tauri -- build --no-bundle`
- Visual changes: inspect screenshots (Playwright `test-results/screenshots`, device `adb exec-out screencap`).

Performance gate (docs/spike-p0.md): 1000-page fixture — first page < 1 s, full scroll without
crash, WebView memory < 600 MB (`adb shell dumpsys meminfo com.anywecon.selis` + renderer).

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
