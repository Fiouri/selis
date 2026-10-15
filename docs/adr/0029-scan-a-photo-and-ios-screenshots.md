# ADR 0029 — "Scan a photo", and App Store screenshots from the iOS simulator in CI

- Status: accepted
- Date: 2026-10-15

## Context

The App Store needs screenshots for the 6.9" iPhone, the 6.3" iPhone ("At least one screenshot
for iPhone with Dynamic Island (medium display)") and, because Selis runs on iPad, the 13" iPad
("Required if app runs on iPad"), 1–10 per size, JPEG or PNG without alpha
(<https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications>,
checked 2026-10-15). There is no Mac here; the simulator in CI is the only iOS screen. The
simulator has no camera, so Scan's review step (Adjust corners) could not be reached for a
screenshot, and a phone without a usable camera had no way into Scan either.

## Decision

- **Scan a photo** (product feature): Scan's header and its no-camera state offer to scan a
  photo already on the device. Android uses the system photo picker in single mode
  (`pick_photos` gains `max`); iOS and the web use a file input (PHPicker in WKWebView). The
  photo goes through the same Adjust step as a camera still; when the scan worker cannot decode
  a Blob (no OffscreenCanvas) it is decoded on the main thread, EXIF orientation applied.
- **Sample photo:** `tools/store/scan-sample.ts` renders `docs/store/scan-sample/{en,el}.jpg`
  with Chromium: an invented delivery note on a desk in perspective; the scan module finds its
  outline (checked with the WebAssembly module and in Playwright).
- **iOS screenshots:** `.github/workflows/ios-screenshots.yml` builds a release simulator app
  on `macos-26` and, per device (iPhone 17 Pro Max, iPhone 17 Pro, iPad Pro 13-inch (M5)) and
  language (en, el), boots a fresh simulator (light, status bar 9:41 / full), seeds the app's
  library with the sample PDFs (`crates/selis-core/examples/seed-library.rs`: the app's own
  `import_path`, titles from the file names, as a picked file gets), puts the photo into Photos,
  and drives `apps/app/e2e/maestro/ios/store-screenshots.yaml` with Maestro: library, viewer,
  annotate, sign, transfer, tools, scan review. Accessible names are used throughout, so the
  same flow fits iPhone and iPad; the one exception is PHPicker's first photo, tapped by a
  per-device position (its grid is out of process).
- **Why seeded, not picked:** the Files document picker is out of process too. On iPhone its
  cells are in the hierarchy, but synthesized taps opened a file only some of the time (a tap on
  a cell's centre lands on its name label); on iPad it is a popover with nothing in the
  hierarchy. Six CI iterations did not make it reliable; the import itself is covered by the
  Android Maestro suite and the unit tests. Output: JPEG at native pixels (sizes checked in the job), in
  the artifact as `fastlane/screenshots/<locale>/<device>-<n>.jpg`, committed after review.
- **Android** store screenshots gain the same scan review (`7-scan`) through "Scan a photo".

## Consequences

- Screenshots are reproducible from the repository; a UI change means re-running the workflow.
- The macOS job is free on a public repository but slow (simulator build + six simulator runs).
- PHPicker is system UI; a future iOS may move its first cell (fix `photo` per device in the
  workflow's matrix).
