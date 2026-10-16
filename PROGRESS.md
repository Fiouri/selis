**Current:** v1.0.0-rc.1 — tagged; draft pre-release built, signed and verified (run 38876355215)
**Next step:** owner: review and publish the draft pre-release; upload selis-1.0.0-rc.1.aab to Play Internal testing by hand
**Last session:** 2026-10-16 — pre-RC cleanup (#61: store images en-only + CI guard, AAB on the release, zip 9.0.3), #58 merged, #57/#59 closed; Maestro 18/18 on AVD 36, main CI + release run green

## P5b (2026-10-15)

Done (PRs #49–#53): one app signing key + upload key (docs, checks), iOS export compliance YES
without France (+ French ANSSI draft), IzzyOnDroid submission text, F-Droid estimate, name check;
control borders ≥ 3:1 with an automated contrast test; Android 14+ transfers as user-initiated
data transfer jobs (FGS only below 14); TalkBack fixes from the S23 walkthrough; "Scan a photo";
Android store screenshots with scan review; App Store screenshots from the iOS simulator in CI;
GitHub Pages site live.

Verified: Tier 1 + Playwright (en/el) + visual baselines in CI; Maestro suite (22 flows incl.
transfer-background) on the AVD and the S23; Pages deploy.

Open risks / owner: see docs/release/1.0-rc.md "Open before 1.0" (mid-range device, off-LAN
transfer, TestFlight, human TalkBack pass, FGS path below Android 14).

## P5c (2026-10-16)

Done: English first for upgrades (schema 7: stored "system" → "en" once), README features and
English screenshots, English store defaults, repo description/topics; IzzyOnDroid dropped (AI
policy), v1.0 on Play + GitHub Releases with stable asset names and Obtainium setup, F-Droid AI
position recorded, AI-assistance note on README and website; transfers below Android 14 (foreground
service) verified on an API 33 Play image with an updated Google WebView, WebView minimum 111
documented; first signed CI run fixed (AAB check without jarsigner -strict).

Verified: Tier 1 (377 vitest, Rust, deny), CI; Maestro 20 flows + upgrade-locale on AVD 36 and
S23, transfer flows + upgrade-locale on API 33.

Open: social preview upload (no API); see docs/release/1.0-rc.md "Open before 1.0".

## v1.0.0-rc.1 (2026-10-16)

Done: store images English-only (el-GR/App Store el fall back to en-US; CI guard
`scripts/check-store-images.sh`; ADR 0024 amendment); AAB attached to the GitHub release
(ADR 0023 amendment); `zip` 9.0.3 (9.0.2 yanked, cargo deny red on main); Dependabot #58 merged,
#59 closed (bindgen syn 2/3 lock, serde_json/uuid ignored), #57 closed (gradle-wrapper frozen
until v1.0); annotated tag `v1.0.0-rc.1` on fb4a4f7.

Verified: CI on #61/#58/main green (incl. iOS screenshots en-only on 3 devices); Maestro 18 flows
on AVD 36 with #58, 5 flows (incl. pack) on main; release run: AAB signed with the upload key
(SHA-256 d7dee4ae…9d0762), APKs with the app key = SELIS_APK_CERT_SHA256 (2b9682e1…af1598),
asset names `selis-1.0.0-rc.1-<abi>.apk`, SBOMs (npm 72, Rust 714 components), SHA256SUMS
checked locally, reproducible arm64 APK byte-identical + apksigcopier OK. versionCode 10000010
(AAB/universal), per ABI 10000011–14. No TestFlight (Apple secrets not set).

Open: the release is a draft until the owner publishes it; Play upload manual.

