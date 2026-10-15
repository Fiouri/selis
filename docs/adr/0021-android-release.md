# ADR 0021 — Android release: unsigned builds, signing from secrets, store checks, reproducible

- Status: accepted
- Date: 2026-10-14

## Context

Mobile 1.0 ships on Google Play (AAB), GitHub Releases / Obtainium (APKs) and F-Droid (built
from source; it can publish our own signed APK when its build is byte-identical). Requirements
checked on 2026-10-14:

- Google Play target API: new apps and updates must target Android 16 (API 36) from
  2026-08-31 (<https://support.google.com/googleplay/android-developer/answer/11926878>).
- 16 KB pages: apps targeting Android 15+ must support 16 KB pages on 64-bit devices; updates
  that do not cannot be released from 2027-02-01. LOAD segments aligned to 16 KB, a GNU_RELRO
  segment ending on a 16 KB boundary (otherwise the linker of a 16 KB device crashes the app),
  uncompressed libraries 16 KB zip-aligned (<https://developer.android.com/guide/practices/page-sizes>).
- Play App Signing: upload and custom app signing keys RSA ≥ 2048; new apps are enrolled in
  Google-generated keys unless the developer provides one
  (<https://support.google.com/googleplay/android-developer/answer/9842756>).
- F-Droid reproducible builds: the upstream APK must equal F-Droid's unsigned build except for
  the signature, which apksigcopier copies; apksigner from build-tools ≥ 35 writes signatures
  apksigcopier cannot verify yet, sign with build-tools 34
  (<https://f-droid.org/docs/Reproducible_Builds/>). No proprietary libraries
  (<https://f-droid.org/docs/Inclusion_Policy/>).

Measured on the existing builds: the Rust library's LOAD segments were 16 KB aligned (the
`max-page-size` flag in `.cargo/config.toml`), but its GNU_RELRO ended at 0x47a2000 — 4 KB, not
16 KB aligned: the shipped library would have crashed on 16 KB-page devices.

## Decision

- **Build unsigned, sign afterwards.** `release-android.yml` builds the AAB (all ABIs), the four
  per-ABI APKs and a universal APK with the Tauri CLI on a clean runner (no build cache), then
  signs them with `scripts/android-sign.sh`: APKs with apksigner 34 (v2 + v3; minSdk 26 needs no
  v1), the AAB with jarsigner — the upload key if `ANDROID_UPLOAD_*` secrets exist, else the
  release key. Keystores come from base64 secrets into the runner's temp dir and are deleted at
  the end of the step; passwords go through the environment. Without secrets the job finishes
  unsigned with a notice. Owner steps: `scripts/android-keystore.md` (one app signing key on
  every channel plus a Play upload key, ADR 0025).
- **Store checks on every artifact** (`scripts/check-android-release.sh`): `zipalign -c -P 16`,
  LOAD alignment 2**14 and GNU_RELRO end on 16 KB for arm64-v8a and x86_64, targetSdk and
  compileSdk ≥ 36, versionCode/versionName as ADR 0020 derives them, the existing
  `check-release-apk.sh` (not debuggable, no WebView debugging, no `measure` build, no
  `debug.selis.*`), and for signed builds apksigner v2 + v3 / jarsigner. CI runs the same
  checks on the arm64 store-like APK of every PR.
- **RELRO fix:** `-z common-page-size=16384` next to `max-page-size` for every Android target
  (`.cargo/config.toml`).
- **No proprietary dependencies** (`tools/release/check-dependencies.ts`, CI): no Play Services,
  Firebase, ML Kit, Play Core / Billing, ads, analytics or crash-reporting SDK in npm, Gradle or
  Cargo; shipped npm packages permissively licensed (Rust: cargo-deny). The release workflow
  also runs F-Droid's own `fdroid scanner` on the APKs.
- **Reproducible:** a second job builds the arm64 APK from the same commit the way the F-Droid
  recipe does (one ABI per build), in another directory with another `CARGO_HOME`, and compares
  it byte for byte with the first job's (diffoscope report on failure); for signed releases it
  runs `apksigcopier compare`, F-Droid's check. The first attempt differed: absolute
  `$CARGO_HOME` paths of registry crates in panic messages (+17 KB in the `.so`).
  `scripts/reproducible-env.sh` (sourced before every release build, also in the F-Droid
  recipe) remaps `$CARGO_HOME`, the checkout and the NDK (`--remap-path-prefix` through a
  cfg-target rustflags entry in `$CARGO_HOME/config.toml`, which Cargo joins with the
  project's per-triple 16 KB flags; `-ffile-prefix-map` for C/C++). The scan WebAssembly module
  is built with the same remapping (`scripts/build-scan-wasm.ts`). Since then the two builds
  are byte-identical (run 38651844267).
- **Sizes** per artifact and Play's per-ABI download size (`bundletool get-size total`) go to
  the job summary and `sizes.md` in the artifact, with SHA-256 sums.

## Consequences

- Signing never happens on a developer machine or in Gradle; `build.gradle.kts` has no signing
  config, so debug builds and F-Droid's build are unaffected.
- The AAB is checked through bundletool (`PAGE_ALIGNMENT_16K`, manifest), the APKs directly.
- F-Droid readiness gaps and decisions (prebuilt WebAssembly in npm packages, the n0 relay
  anti-feature question) are in `docs/store/fdroid/README.md`.
