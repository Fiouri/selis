# ADR 0030 — English first everywhere: settings migration, README, stores, repository

- Status: accepted
- Date: 2026-10-15

## Context

English became the default UI language in #31 (docs/SPEC.md, 2026-10-12): a fresh install opens
in English whatever the device language, and Greek is chosen in Settings › Language. Before #31
the language setting defaulted to **"system"** ("Same as the device"). An install that stored
"system" then (picking it in Settings) still opens in Greek on a Greek phone after the update,
and the boot mirror in `localStorage` paints its first frame from that old value. The review also found the repository and store material Greek-leaning in
places (README without screenshots, store default language not written down, an empty GitHub
description and no topics).

## Decision

- **Settings migration:** database schema 7 (`crates/selis-core/migrations/0007_english_first.sql`)
  turns a stored locale `"system"` into `"en"` once, on the upgrade; `"el"` and `"en"` are kept. A
  `"system"` chosen after the upgrade stays (the migration never runs again). The boot mirror
  (`selis.boot-settings`) gains a version (`v: 2`); a mirror without it reads `"system"` as `"en"`,
  so the first frame agrees with the database. Tests: `db::tests` (v6 → v7, once only),
  `state/settings.test.ts`, and the Maestro upgrade flow `upgrade-locale.yaml` (a Greek-locale
  device, the previous build with "Same as the device", then this build: English).
- **README:** an English screenshots section (the en-US light Play screenshots: library, viewer,
  annotate, sign, transfer, tools, scan) and a short, current feature list. No Greek images in
  the README.
- **Stores:** Google Play default listing language en-US, App Store primary language English
  (U.S.); Greek is an added translation in both (`docs/store/play-console.md`,
  `docs/store/ios-release.md`). The website's default stays English (`/`), Greek at `/el/`.
- **Repository:** description, homepage and topics in English, set with `gh repo edit`. The social
  preview image (`docs/store/github-social-preview.png`, 1280 × 640, English, made by
  `tools/store/render-graphics.ts`) is uploaded by hand in Settings › General › Social preview:
  GitHub has no API for it.

## Consequences

- A user who deliberately chose "Same as the device" before this release sees English once and
  picks it again; accepted for one release, in exchange for every pre-#31 install following the
  English-first rule.
- The database is backed up before the migration as for every schema change (`<db>.bak-v6`).

## Amendment 2026-10-20 — English first for new strings; Greek in a translation pass

Owner decision (P7b), applying from now on:

- **Build and test in English first.** A new user-visible string goes to `en.json` only.
  `el.json` (and any later locale) is filled in **one translation-pass PR right before each
  release candidate**, labelled `translation-pass` (or on a `translation-pass/*` branch).
- **Runtime:** a key missing from `el.json` shows the English text (i18next `fallbackLng: "en"`).
  Tested in `apps/app/src/i18n/i18n.test.ts` ("a key absent from el.json shows the English
  text", plus every key Greek does not have yet resolves to its English message).
- **Completeness check:** `node tools/i18n/check-el.ts` runs in CI. Between release candidates
  a missing Greek key is a `::warning`; in the translation pass (`SELIS_TRANSLATION_PASS=1`, set
  by CI from the label or branch) and on a release tag (`release.yml`, `--strict`) it fails. A
  key left in `el.json` after its English key is gone always fails. The app's vitest catalogue
  test follows the same rule (Greek ⊆ English always; Greek = English in the translation pass);
  placeholders are compared for the keys both have.
- **Playwright:** English is required on every change. The Greek visual set
  (`<screen>-el-<theme>.png`) and the Greek layout checks (scan header at 360 dp) run only in
  the translation pass (`apps/app/e2e/langs.ts`); their baselines stay in the repository and
  are refreshed there. Functional tests of the language setting itself (switching to Greek,
  `lang="el"`) keep running: they use long-standing keys.
- **Maestro** flows run in English (they already do); store screenshots stay English-only.

Consequence: between release candidates a Greek user of a debug or CI build can see new
features in English; release candidates and releases are complete in Greek.
