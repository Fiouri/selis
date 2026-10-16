# ADR 0023 — Release on tag: draft GitHub release with checksums and SBOMs

- Status: accepted; amended 2026-10-16 (AAB attached to the release)
- Date: 2026-10-14

## Context

SPEC (Supply chain): releases carry SHA-256 checksums, a CycloneDX SBOM and signed artifacts.
Mobile 1.0 ships Android APKs on GitHub (Obtainium, F-Droid's reproducible-build check reads
them) and iOS through TestFlight / the App Store. Desktop releases wait for P6.

## Decision

- `release.yml` runs on a pushed tag `v*`, which only the owner pushes. It checks that the tag
  equals `v<version>` and the CHANGELOG has the section (ADR 0020), then calls
  `release-android.yml` and `release-ios.yml` (reusable workflows, secrets inherited) and builds
  the SBOMs.
- **SBOMs, CycloneDX:** npm — `npm sbom --omit dev --package-lock-only` (built into npm 10, the
  packages that ship in the app); Rust — `cargo-cyclonedx` 0.5.9 on the app crate for all
  targets without build-only dependencies (everything the app links: the core, transfer and PDF crates and their dependencies; the scan module is WebAssembly built from `crates/selis-scan`).
- **Draft release:** signed per-ABI and universal APKs, both SBOMs and `SHA256SUMS`, notes from
  the version's CHANGELOG section (`version.ts notes`), marked pre-release for `-rc.N`. It stays a
  draft: the owner reads it and publishes. If the signing secrets were missing, the draft holds
  the unsigned APKs and says not to publish it. The AAB goes to Play, not to GitHub (amended
  below).
- Play upload (fastlane supply in the SPEC) is not automated yet: there is no Play account; the
  AAB is in the run's artifact for the first manual upload.

## Consequences

- Rerunning a release means deleting the draft and re-pushing the tag (owner).
- `contents: write` is granted to the one job that creates the draft.

## Amendment (2026-10-16): the AAB is attached too

Owner decision for v1.0.0-rc.1: the draft also carries the AAB (`selis-<version>.aab`, signed with
the Play upload key, ADR 0025) and lists it in `SHA256SUMS`, so the bundle uploaded to Play by
hand is the one whose checksum the release publishes. The notes say it is the Play bundle and does
not install on a phone; Obtainium's asset filter matches `.apk` names only. Play upload stays
manual.
