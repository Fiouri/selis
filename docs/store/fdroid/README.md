# F-Droid readiness

Status 2026-10-14: not submitted. What is in place, what F-Droid will ask, and the decisions
that are the owner's. Sources: Inclusion Policy <https://f-droid.org/docs/Inclusion_Policy/>,
Anti-Features <https://f-droid.org/docs/Anti-Features/>, Reproducible Builds
<https://f-droid.org/docs/Reproducible_Builds/>, Build Metadata Reference
<https://f-droid.org/docs/Build_Metadata_Reference/>.

## In place

- **No proprietary code:** no Google Play Services, Firebase, ML Kit, Play Core / Billing, ads,
  analytics or crash reporting (`tools/release/check-dependencies.ts` in CI on npm, Gradle and
  Cargo; `fdroid scanner` on the release APKs in `release-android.yml`). QR codes are read with
  jsQR, scans with our own Rust → WebAssembly module, OCR with Tesseract — all on the device.
  Android libraries: AndroidX and Material Components (Apache-2.0).
- **Licences:** Apache-2.0 app; dependencies permissive (cargo-deny, npm allow list); fonts OFL;
  Tesseract models (tessdata_fast) Apache-2.0.
- **No network unless the user transfers**, no account, no tracking (docs/PRIVACY.md).
- **Reproducible build, our signature:** `release-android.yml` builds the arm64 APK a second
  time the way the recipe does, from another directory and `CARGO_HOME`, and requires a
  byte-identical unsigned APK; for signed releases it runs `apksigcopier compare` (ADR 0021).
- **Metadata draft:** `com.anywecon.selis.yml` (three ABI builds per version, versionCodes from
  ADR 0020, update checks on release tags only). Title, descriptions, changelogs and screenshots
  come from `fastlane/metadata/android/` in the repo, which F-Droid reads.

## How a release reaches F-Droid with our signature (apksigcopier)

1. We tag `vX.Y.Z`; `release.yml` attaches signed per-ABI APKs to the GitHub release.
2. F-Droid's checkupdates sees the tag and adds three builds (`VercodeOperation`).
3. Its build server builds each ABI from the tag (`build:` in the YAML) into an unsigned APK.
4. `fdroid publish` downloads our APK (`binary:`), runs apksigcopier: copies our v2/v3
   signature block onto its unsigned APK and verifies it with apksigner. Success means the two
   are identical except for the signature, and F-Droid publishes **our** APK; the certificate
   must match `AllowedAPKSigningKeys`. On mismatch that version is not published.
5. Users can then move between GitHub/Obtainium and F-Droid installs without reinstalling.

We sign with apksigner from build-tools 34 because signatures written by 35+ cannot be verified
by apksigcopier yet (F-Droid docs).

## Gaps F-Droid reviewers will raise

| Gap | Why | Options |
| --- | --- | --- |
| Prebuilt WebAssembly from npm: PDFium (`@embedpdf/pdfium`, the PDF engine) and Tesseract (`tesseract.js-core`) | Inclusion Policy: everything is built from source; prebuilt binaries are removed (`scandelete`) | (a) build both from source in the recipe (emsdk srclib; PDFium's EmbedPDF build scripts, tesseract.js-core's Docker build) and check the output equals the npm files — SPEC risk "F-Droid και prebuilt WASM"; (b) ask the reviewers first (some npm-based apps are accepted with documented upstream sources) |
| Native build tools from npm (esbuild, Rollup, Lightning CSS / Tailwind oxide) | Prebuilt executables used at build time | Usually accepted as build tools; if not, build from source or use their WASM builds |
| `gradle-wrapper.jar` | F-Droid uses its own Gradle | Removed in the recipe (`rm:`); the build goes through the Tauri CLI |
| Tesseract models (`packages/ocr/tessdata/*.gz`) | Binary data in the repo | Apache-2.0 data from tesseract-ocr/tessdata_fast, SHA-256 checked by `scripts/copy-ocr-assets.ts`; the recipe can download and check them instead |

## Decisions for the owner

1. **Signing key and fingerprint.** F-Droid publishes our APK only if its certificate SHA-256
   is in `AllowedAPKSigningKeys`. It comes from `scripts/android-keystore.md` step 1 (one key on
   every channel, option A, keeps Play installs compatible too).
2. **Anti-feature for the n0 relay.** By default a transfer that cannot connect directly goes
   through a public relay run by n0 (the iroh developers), and n0's DNS/pkarr service is used to
   find the other device. The relay and lookup software is open source (iroh-relay, MIT /
   Apache-2.0) and self-hostable; Settings › Transfer has "Local network only" and a custom
   relay URL; nothing is sent until the user opens Transfer; contents are end-to-end encrypted;
   n0 sees IP addresses and public keys during a transfer.
   - **NonFreeNet** ("promotes or depends entirely on a proprietary network service"): the
     service is not proprietary and not required (LAN works without it).
   - **TetheredNet** ("depends on a service that is hard to replace, with no simple option to
     point it at an alternative"): there is such an option (custom relay).
   - **Tracking** ("user or activity data is tracked or leaked by default"): no activity is
     reported; the relay sees connection metadata only while the user transfers.
   - Options: **(a) no anti-feature, explain the relay in the description and in PRIVACY.md**
     (recommended: matches the definitions); (b) declare NonFreeNet voluntarily (users who filter
     anti-features will not see Selis); (c) F-Droid build defaults to "Local network only"
     (needs a build flavor; transfers across networks then need the user to enable the relay).
3. **Prebuilt WebAssembly** (table above): build from source in the recipe (days of work,
   emsdk) or ask the F-Droid reviewers before submitting. Recommended: ask first, with the
   upstream build sources linked.
4. **Submission** (after a tagged release): fork fdroiddata on GitLab, add
   `metadata/com.anywecon.selis.yml`, run `fdroid lint`/`fdroid build` in their CI, open the merge
   request. Needs a GitLab account (free).
