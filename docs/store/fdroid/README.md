# F-Droid readiness

Status 2026-10-15: not submitted. **Owner decisions (ADR 0025):** no self-declared anti-feature;
the F-Droid-client launch channel is **IzzyOnDroid** (`../izzyondroid.md`, developer-signed
reproducible APK); the main F-Droid repository with PDFium and Tesseract built from source is a
later spike (estimate below). Sources: Inclusion Policy <https://f-droid.org/docs/Inclusion_Policy/>,
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

## Decisions (owner, 2026-10-15)

1. **Signing:** one app signing key on every channel (`scripts/android-keystore.md`); its
   certificate SHA-256 goes into `AllowedAPKSigningKeys`.
2. **No self-declared NonFreeNet** (nor TetheredNet / Tracking): the relay and lookup software is
   open source and self-hostable, LAN transfers need neither, and nothing is reported. Instead the
   description states the n0 relay fallback, "Local network only" and the self-hosted relay
   option (`fastlane/metadata/android/*/full_description.txt`, the privacy policy). If F-Droid's
   reviewers still ask for NonFreeNet, the commented block in the YAML is ready.
3. **Launch channel:** IzzyOnDroid (`../izzyondroid.md`; note its AI policy there). The YAML here
   stays a draft for the main repository.
4. **Main F-Droid:** later; the WebAssembly-from-source effort is estimated below.

## Spike estimate: main F-Droid with WebAssembly built from source

Inclusion Policy: everything built from source; prebuilt binaries are removed with
`scandelete`. Our prebuilt WebAssembly comes from npm:

| Module | npm package (pinned) | Upstream build | Work |
| --- | --- | --- | --- |
| PDFium (PDF engine) | `@embedpdf/pdfium` 2.15.1 (MIT; `packages/pdfium` of embedpdf/embed-pdf-viewer) | PDFium checkout (gclient, depot_tools, ~GBs of sources) built with emscripten by EmbedPDF's scripts, plus their C wrapper and JS glue | **4–6 days**: reproduce EmbedPDF's build in a pinned emsdk container, make it run offline from F-Droid srclibs (PDFium + its third-party deps), check our engine tests pass with the self-built `.wasm` (byte-identical output is unlikely; functional equality is what F-Droid needs) |
| Tesseract (OCR) | `tesseract.js-core` 7.0.0 (Apache-2.0) | Tesseract + Leptonica (+ zlib, libpng, libjpeg …) with emscripten through the project's Docker build; four variants (simd / non-simd, lstm-only) of which we ship two | **2–3 days**: pinned emsdk, build the two variants we ship, OCR accuracy check (`ocr.sh check`, ≥ 95 %) |
| F-Droid recipe and review | — | `sudo:` installs, srclibs for emsdk / PDFium / Tesseract, `scandelete` of `node_modules` WASM, replacing them before `vite build` | **2–3 days** plus review rounds (typically weeks of calendar time) |
| Upkeep | — | Every EmbedPDF / tesseract.js upgrade rebuilds and rechecks | **0.5–1 day per upgrade** |

Total: **about 8–12 working days** of engineering, plus the build-server limits (PDFium's
checkout and compile time and disk are the main risk; if they exceed F-Droid's build-server
limits, PDFium has to be split into a prebuilt-by-F-Droid srclib or the main repo stays out of
reach). Native build tools from npm (esbuild, Rollup, Lightning CSS / Tailwind oxide) are
usually accepted; if not, their WASM builds replace them (+1 day). Pinned image idea:
`emscripten/emsdk:<version used by each upstream>` (EmbedPDF and tesseract.js-core pin
different emsdk versions; both must be read from their build scripts at spike time).

## Submission (main repository, after the spike)

Fork fdroiddata on GitLab, add `metadata/com.anywecon.selis.yml`, run `fdroid lint` / `fdroid
build` in their CI, open the merge request. Needs a GitLab account (free).
