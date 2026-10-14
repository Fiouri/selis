# ADR 0019 — Visual snapshots: one Linux baseline set, exact comparison

- Status: accepted
- Date: 2026-10-14

## Context

`visual-390` (Playwright, `apps/app/e2e/visual.spec.ts`) kept two baseline sets, `*-win32.png`
(local runs) and `*-linux.png` (CI, ubuntu-24.04), compared with `maxDiffPixelRatio: 0.002`
(0.004 for a few shots) and `updateSnapshots: "missing"` everywhere.

Stale Linux baselines passed CI: `library-empty-*-linux` lacked the "Images to PDF" (P4b) and
"Scan a document" (P4c) buttons for weeks. Cause, reproduced with Playwright's comparator on the
stale and the current image: 0.002 of a 390 × 844 shot is 658 pixels, and pixelmatch does not
count pixels it classifies as anti-aliasing — most of the pixels of text and thin icons — so two
whole new buttons counted 564 pixels and passed. `maxDiffPixels: 0` fails the same comparison
(564–1796 pixels depending on the threshold). A missing baseline also passed in CI ("missing"
writes it), which is how an unreviewed render could become a baseline. Each UI change had to be
approved twice (win32 locally, Linux from CI), and the second set was the one that went stale.

## Decision

- **One baseline set: Linux, produced by CI.** The `visual-390` project exists only on Linux
  (`playwright.config.ts`); win32 baselines are dropped. CI is the required check, so a visual
  regression cannot merge; local Windows runs keep the functional projects (Pixel 7, iPhone 15,
  camera). Rendering differs between OSes (fonts, anti-aliasing), so win32 baselines checked
  nothing CI does not, and doubled the review.
- **Exact comparison:** `toHaveScreenshot` default `maxDiffPixels: 0` (Chromium on the same OS
  renders the same pixels; checked by two CI runs on fresh baselines) and no per-shot
  tolerances. Animations stay disabled and the caret hidden.
- **No silent baselines in CI:** `updateSnapshots: "none"` when `CI` is set: a missing baseline
  fails, and its render is in the `playwright-report` artifact (`test-results/…-actual.png`) to
  inspect and commit. Locally (Linux) "missing" still writes them.
- **Proof:** a temporary 4 px shift of one component (the library's Import button) made CI fail
  on the screens that show it; the shift was reverted (PR "chore: P4 follow-ups").

## Consequences

- Updating baselines: change the UI, push, download the failing shots' `*-actual.png` from the CI
  artifact, inspect them, commit them as `*-linux.png` (CONTRIBUTING.md).
- A screen that cannot render deterministically must be fixed (wait for its content, freeze
  its data) rather than given a tolerance.
- Visual review needs CI (about 20 minutes a round); a Linux machine with Playwright 1.64 and the
  same fonts can render locally, but CI's renders are the reference.
