# ADR 0020 — Versioning: one source, derived store numbers

- Status: accepted
- Date: 2026-10-14

## Context

The version lived in six places (root and app `package.json`, the Cargo workspace,
`tauri.conf.json`, the generated Android properties, the iOS `Info.plist`), all `0.1.0`. Tauri
derives Android's versionCode as `major × 1 000 000 + minor × 1 000 + patch` and iOS's
CFBundleVersion from the version string. The SPEC planned `major·10000 + minor·100 + patch`.
Neither orders a release candidate before its release (`1.0.0-rc.1` and `1.0.0` get the same
code, and Google Play only accepts a higher versionCode), neither leaves room for per-ABI APKs
(F-Droid and GitHub ship one APK per ABI, each needs its own code), and App Store Connect rejects
a pre-release suffix in CFBundleShortVersionString.

## Decision

- **Source of truth:** `version` in the root `package.json`, SemVer restricted to `X.Y.Z` and
  `X.Y.Z-rc.N` (minor, patch ≤ 99; N 1–98). `node tools/release/version.ts set <version>` writes
  it and every derived value; `check` (CI, every PR; the release workflow also passes the tag)
  fails when one is out of step or `CHANGELOG.md` has no section for it.
- **Derived:** `apps/app/package.json`, `package-lock.json` (root, app), the Cargo workspace
  version and `tauri.conf.json` `version` carry the same string (Android versionName, desktop).
- **Build number:** `build = ((major × 100 + minor) × 100 + patch) × 100 + stage`, stage = N for
  `-rc.N`, 99 for the release. `1.0.0-rc.1` → 1 000 001, `1.0.0` → 1 000 099.
- **Android versionCode:** `build × 10 + ABI digit` — 0 for the AAB and the universal APK
  (`tauri.conf.json` `bundle.android.versionCode`), 1 arm64-v8a, 2 armeabi-v7a, 3 x86_64, 4 x86
  (`app/build.gradle.kts` adds the digit per ABI flavor). `1.0.0-rc.1` → 10 000 010…14; the largest
  possible code (209.99.99) stays below Play's 2 100 000 000.
- **iOS:** CFBundleShortVersionString = `X.Y.Z`; CFBundleVersion = `build`
  (`bundle.iOS.bundleVersion`). The iOS release build passes `version.ts ios-config` to
  `tauri ios build --config` so an rc uploads as `1.0.0 (1000001)`.
- **Changelog:** `CHANGELOG.md`, Keep a Changelog 1.1.0, one section per version; the store
  "What's new" texts are short summaries of it (`fastlane/metadata/android/<locale>/changelogs/
  <versionCode>.txt`). release-please (SPEC) is not used: the changelog is curated by hand,
  release PRs set the version with `version.ts set`.
- **First version:** `1.0.0-rc.1`; tags are `v<version>` and are pushed only by the owner.

Replaces the SPEC's "versionCode = major·10000 + minor·100 + patch" (updated there).

## Consequences

- An rc of the next patch always sorts after the previous release, so internal-testing builds
  on Play keep going up.
- A tenth rc digit or a third ABI digit would need a new scheme: a breaking change for Play, so
  the limits are checked by `version.ts`.
- Tauri's own derivation is not used on any platform: if the generated project is ever
  regenerated, the gradle per-ABI block (`abiVersionDigits`) must be put back (CI's release-APK
  check fails on a wrong versionCode).
