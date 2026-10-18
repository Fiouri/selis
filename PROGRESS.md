**Current:** P7a Scan 2.0 — done (PRs #64, #65, #66); on main after #66 merges, not tagged
**Next step:** owner: check the scan screens by hand (list in the P7a section), then say "go" for v1.0.0-rc.2 (Play Internal testing, S23)
**Last session:** 2026-10-18 — Scan 2.0: auto-capture, Enhance, batch review/edit, touch-up, ID card; Tier 1 + Playwright en/el + CI green; Maestro 24 flows + upgrade-locale on AVD 36

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

## P7a — Scan 2.0 (2026-10-18)

Done (PRs #64 core, #65 app, #66 device fix + flows; ADR 0032, ADR 0016 amended): automatic
capture (0.6 s steady, < 2 % corner drift, sharpness ≥ 800 calibrated on the scan-sample corpus;
progress ring, haptic, "Auto" switch saved as `scanAuto`, default on; re-arms only after the
page is gone 1 s or moved 25 %), hints Hold steady / Move closer / More light (torch); Enhance
filter (default): background σ −84…−95 % on the generated photos, text contrast up; batch with a
thumbnail strip, review (open a page: corners, filter, rotate, touch-up eraser with undo, retake
in place, delete; long-press drag), memory cap 120/240/480 MB by tier; ID card mode (A4, both
sides 85.6 × 54 mm). WASM: SIMD 179 262 → 212 954 B, base 172 778 → 201 167 B; JS 372 → 380 KB
gzip (budget 1.5 MB).

Verified: Tier 1 (vitest, cargo test incl. corpus replay, clippy -D warnings incl. wasm32,
deny); Playwright en + el, new scan visual baselines from CI reviewed; Maestro on AVD 36:
scan-auto, scan-batch (9-page PDF read back in order 3,x,2,4,5r,6,8,9,x), scan-idcard
(210 × 297 mm, sides 85.60 × 54.00 mm) and the other 21 flows; upgrade-locale. The S23 was not
used (Play build).

Open: device haptic and auto-capture feel on a real phone (S23 via Play Internal); iOS has no
haptic; automatic Keep after an automatic capture is not done (the Adjust step stays).

