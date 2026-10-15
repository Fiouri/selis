**Current:** P5c follow-ups — PRs #54 (English first), #55 (distribution), #56 (Android < 14, WebView) ready; Dependabot #14/#35 merged, #16 closed, #15 rebasing
**Next step:** owner: upload docs/store/github-social-preview.png (repo Settings › Social preview), then the go for the v1.0.0-rc.1 tag
**Last session:** 2026-10-16 — P5c: settings schema 7, README/store/repo in English, IzzyOnDroid dropped, FGS path verified on API 33; Tier 1 green, Maestro AVD 36 + S23 + API 33 green

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
