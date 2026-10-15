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
