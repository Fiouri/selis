# ADR 0025 — Release decisions: one app signing key, IzzyOnDroid first, export compliance, name, iPad

- Status: accepted (owner decisions, 2026-10-15)
- Date: 2026-10-15

## Context

P5a left five owner decisions open (ADRs 0021, 0022; `docs/store/`). The owner decided them
after review. Rules were re-checked against the current official pages on 2026-10-15 (linked in
each document).

## Decision

1. **Signing (Android).** One app signing key (RSA 4096) signs every APK we publish (GitHub
   Releases / Obtainium, IzzyOnDroid, F-Droid via apksigcopier) and is given to Google Play with
   "Provide a copy of your app signing key" (PEPK, encrypted for Google), opting out of Play's
   default Google-generated key before the first release. A separate Play upload key (RSA 4096)
   signs only the AAB. `android-sign.sh` no longer signs an AAB with the app signing key (it stays
   unsigned without the upload key), and `check-android-release.sh --signed` fails when an APK
   is not signed by the published certificate (`vars.SELIS_APK_CERT_SHA256`) or the AAB is.
   Owner steps and backups: `scripts/android-keystore.md` (Play Console Help 9842756).
2. **iOS export compliance.** `ITSAppUsesNonExemptEncryption` = YES (standard algorithms we
   carry ourselves: rustls, RustCrypto, qpdf); the App Store launch excludes France, so no
   document and no `ITSEncryptionExportComplianceCode` yet. The ANSSI declaration is drafted in
   French for later (`docs/store/ios-france-declaration.md`; online procedure since 2026-03-31).
3. **F-Droid.** No self-declared anti-feature (NonFreeNet / TetheredNet / Tracking do not match:
   the relay software is open source and self-hostable, LAN transfers need no service, nothing is
   reported). The store descriptions state the n0 relay fallback, "Local network only" and the
   self-hosted relay option. Launch channel for F-Droid clients: **IzzyOnDroid** with our signed,
   reproducible APK (`docs/store/izzyondroid.md`). The main F-Droid repository (PDFium and
   Tesseract WebAssembly built from source with a pinned emsdk image) is a later spike, estimated
   at 8–12 working days (`docs/store/fdroid/README.md`).
4. **Name.** Keep "Selis" (`docs/store/name-check.md`): US SELIS 86463675 is Lam Research's
   class-7 mark (no conflict); serial 76171221's status is unverified; "SELISE Signature" is a
   similar name in e-signatures, low-to-medium risk.
5. **iPad stays supported.** App Store Connect then requires 13-inch iPad screenshots ("Required
   if app runs on iPad"); they come from the iOS simulator in CI with the iPhone ones.

## Consequences

- Losing the app signing key ends updates for GitHub / IzzyOnDroid / F-Droid users (Play can
  rotate its copy); the backup procedure is part of the owner steps.
- **IzzyOnDroid's AI policy** ("strongly opposed to apps which are fully or in part created by
  generative AI tools … will most likely be rejected"; transparency required) conflicts with how
  Selis is written. The prepared request discloses it; the owner may fall back to GitHub
  Releases + Obtainium and the main F-Droid repository (no adopted AI rule as of 2026-10-15).
  Recorded in `docs/store/izzyondroid.md`.
- IzzyOnDroid's 30 MB per-APK limit leaves 1.9 MB of headroom on the arm64 APK (28.1 MB).
- A French App Store release needs the ANSSI attestation and a new `Info.plist` key first.
