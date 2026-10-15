**Current:** P5b pre-RC fixes — merged except #53 (Scan a photo + store/App Store screenshots), CI green on it
**Next step:** owner: keystore + secrets (scripts/android-keystore.md), Apple API key, then the go for the v1.0.0-rc.1 tag
**Last session:** 2026-10-15 — P5b: signing/compliance docs, contrast ≥ 3:1, UIDT transfers, TalkBack fixes, Scan a photo, screenshots; Maestro AVD + S23 green, CI green

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
