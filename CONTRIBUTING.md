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

```sh
npm ci
npm run fixtures
npm run verify:tier1        # tsc, eslint, vitest, rustfmt, clippy, cargo test, cargo deny
npm run e2e                 # Playwright mobile smoke + 390×844 visual snapshots (mock backend)
```

### Visual snapshots

`apps/app/e2e/visual.spec.ts` compares every screen at the reference phone size (390×844) in
light, dark and sepia with the approved design (`docs/design/p1-ui-brief.md`). Baselines are per
OS (`e2e/visual.spec.ts-snapshots/*-win32.png`, `*-linux.png`, …) and a missing one is written on
the first run. CI uploads its snapshot folder in the `playwright-report` artifact: after a UI change,
download the new `*-linux.png` files from there, inspect them, and commit them. Update intended
changes locally with `npx playwright test --project=visual-390 --update-snapshots`.

Android: `npm run tauri -- android dev`. See the README for prerequisites.

If you change a Tauri command, regenerate the bindings with
`cargo test -p selis-app export_bindings` and commit `apps/app/src/lib/ipc/bindings.ts`.
Long-running commands take a `request_id` and run through `RequestResults::run_once`
(docs/adr/0005-ipc-reliability.md).

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `perf:`, `docs:` …).
- Keep PRs focused; include screenshots for UI changes (phone first).
- CI must be green.
