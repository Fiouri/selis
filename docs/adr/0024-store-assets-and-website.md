# ADR 0024 — Store listings, screenshots and website from the repository

- Status: accepted
- Date: 2026-10-14

## Context

Mobile 1.0 needs listings on Google Play, the App Store and F-Droid (English first, Greek
second — SPEC P5), screenshots, a feature graphic, a privacy policy URL and a website with
download links. Play's limits (checked 2026-10-14): title ≤ 30, short description ≤ 80, full
description ≤ 4000 characters, "What's new" ≤ 500; icon 512 × 512, feature graphic 1024 × 500,
phone screenshots with sides at most 2:1. App Store: name and subtitle ≤ 30, promotional text
≤ 170, keywords ≤ 100. F-Droid reads `fastlane/metadata/android/` from the repository.

## Decision

- **Texts in the repository**, fastlane layout: `fastlane/metadata/android/{en-US,el-GR}/`
  (title, short and full description, `changelogs/<versionCode>.txt`, images) for Play and
  F-Droid; `fastlane/metadata/ios/{en-US,el}/` (deliver layout) for the App Store. English is the
  original, Greek in the app's own (informal) voice; no promotional words Play's metadata policy
  forbids in titles.
- **Graphics from the app's own artwork** (`tools/store/render-graphics.ts`, Chromium through
  Playwright): Play icon (full-bleed, Play masks it), feature graphic per language, the
  website's social image and WebP screenshots — reproducible, no image editor.
- **Screenshots from the real app** (`apps/app/e2e/maestro/store-screenshots.sh`, Maestro on the
  AVD): six screens (library, viewer, annotate, sign, transfer, scan) × en/el × light/dark, with
  invented sample documents (`packages/fixtures/src/samples.ts`), a 1080 × 1920 screen and a
  clean status bar (System UI demo mode). The flow taps the labels of the target language read
  from `apps/app/src/i18n`. Light sets go to `phoneScreenshots/`, all sets to
  `docs/store/screenshots/`.
- **Website** (`website/`, no framework, no JavaScript): English at `/`, Greek at `/el/`;
  landing, features, privacy (rendered from `docs/PRIVACY.md` / `PRIVACY.el.md`), download
  (APKs of the newest GitHub release with SHA-256, the signing certificate once it exists).
  Inter self-hosted from `@fontsource-variable/inter`, the app's `tokens.css` for colours and
  dark mode, no cookies, no trackers, no remote fonts or CDNs. Store badges are the stores'
  official artwork, self-hosted, and shown only once the app is live in that store (Google Play
  and Apple badge rules); until then "Coming soon". Apple's badge is added with the App Store
  listing.
- **Deploy and gate:** `pages.yml` builds on pull requests, deploys on main and on published
  releases (GitHub Pages), and fails unless Lighthouse 13.5 scores ≥ 95 in performance,
  accessibility, best practices and SEO on all eight pages (mobile settings).
- **Privacy policy** gains an effective date, the developer, a Photos section, iOS permissions
  and a contact section; the Greek translation says the English text prevails.

## Consequences

- A UI change that alters a key screen means re-running the screenshot script (≈ 10 minutes per
  language and theme on the AVD).
- App Store screenshots (6.9" iPhone, 13" iPad) cannot come from the AVD; they are an owner /
  CI task before the first App Store submission (`docs/store/app-store-privacy.md`).
- Play's per-ABI versionCodes (ADR 0020) need a changelog file per code on F-Droid; the release
  checklist covers it.
