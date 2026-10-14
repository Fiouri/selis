# ADR 0023 — Release on tag: draft GitHub release with checksums and SBOMs

- Status: accepted
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
  targets without build-only dependencies (everything the app links: the transfer, PDF and scan crates and their dependencies).
- **Draft release:** signed per-ABI and universal APKs, both SBOMs and `SHA256SUMS`, notes from
  the version's CHANGELOG section (`version.ts notes`), marked pre-release for `-rc.N`. It stays a
  draft: the owner reads it and publishes. If the signing secrets were missing, the draft holds
  the unsigned APKs and says not to publish it. The AAB goes to Play, not to GitHub.
- Play upload (fastlane supply in the SPEC) is not automated yet: there is no Play account; the
  AAB is in the run's artifact for the first manual upload.

## Consequences

- Rerunning a release means deleting the draft and re-pushing the tag (owner).
- `contents: write` is granted to the one job that creates the draft.
