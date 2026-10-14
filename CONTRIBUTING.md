# Contributing to Selis

Thanks for helping! Selis is mobile-first (Android → iOS → desktop), private by design and
licensed under Apache-2.0. By contributing you agree that your contributions are licensed under
the same terms.

## Before you start

- Read [docs/SPEC.md](docs/SPEC.md) and the ADRs in [docs/adr/](docs/adr/).
- For anything bigger than a bug fix, open an issue first so we can agree on the approach.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules

- **Privacy:** no telemetry, analytics, ads, crash-reporting SDKs, remote fonts or CDNs. No
  network access outside the transfer feature.
- **Licenses:** only permissive dependencies (Apache-2.0, MIT, BSD, ISC, Zlib, OFL for fonts).
  No GPL/AGPL. `cargo deny check` enforces this for Rust.
- **Never overwrite a user's original file.** Writes go through `selis_core::atomic_write`.
- **i18n:** no hardcoded UI text. Add keys to both `apps/app/src/i18n/en.json` and `el.json`
  (ICU message format). The linter and tests fail otherwise.
- **Accessibility:** 44×44 pt touch targets, WCAG 2.2 AA contrast, labels for icon buttons.
- **Boundaries:** only `packages/engine` uses EmbedPDF; the UI calls Rust only through the
  generated bindings in `apps/app/src/lib/ipc/` (via `lib/api.ts`).

## Development

The unit tests check the PDFs the engine writes with [qpdf](https://qpdf.readthedocs.io/)
(`qpdf --check`): install it first (`apt install qpdf`, `brew install qpdf`, `scoop install qpdf`).

```sh
npm ci
npm run fixtures
npm run verify:tier1        # tsc, eslint, vitest, rustfmt, clippy, cargo test, cargo deny
npm run e2e                 # Playwright mobile smoke (mock backend); 390×844 visual snapshots on Linux
```

### Visual snapshots

`apps/app/e2e/visual.spec.ts` compares every screen at the reference phone size (390×844) in
light, dark and sepia with the approved design (`docs/design/p1-ui-brief.md`). English is the primary set
(`<screen>-<theme>-…png`) and Greek the second (`<screen>-el-<theme>-…png`). There is one baseline
set, `e2e/visual.spec.ts-snapshots/*-linux.png`, rendered by CI (ubuntu-24.04), and the comparison
is exact (ADR 0019); the `visual-390` project only runs on Linux. After a UI change CI fails on the
screens that changed (or have no baseline yet): download the `playwright-report` artifact,
inspect `test-results/**/*-actual.png`, and commit each as the matching `*-linux.png`.

Android: `npm run tauri -- android dev`. See the README for prerequisites.

### Android end-to-end (Maestro)

Flows live in `apps/app/e2e/maestro/` and run through `run.sh` (ANR check, animations off for the
run). On devices with Android System WebView 15x (e.g. a Galaxy S23), Maestro 2.11 cannot read the
WebView's DOM; build the patched CLI once with `tools/maestro-patch/build.sh` and run with
`MAESTRO=F:/DevCache/maestro-selis/bin/maestro` (see [tools/maestro-patch/README.md](tools/maestro-patch/README.md)).

If you change a Tauri command, regenerate the bindings with
`cargo test -p selis-app export_bindings` and commit `apps/app/src/lib/ipc/bindings.ts`.
Long-running commands take a `request_id` and run through `RequestResults::run_once`
(docs/adr/0005-ipc-reliability.md).

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `perf:`, `docs:` …).
- Keep PRs focused; include screenshots for UI changes (phone first).
- CI must be green.
