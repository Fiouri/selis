# ADR 0031 — Minimum WebView 111 and transfers below Android 14, verified on API 33

- Status: accepted
- Date: 2026-10-15

## Context

Selis's UI runs in Android System WebView. Tailwind CSS v4 targets "Chrome 111" and newer
(`color-mix()`, `@property`, cascade layers; <https://tailwindcss.com/docs/compatibility>), the
UI is built for ES2022, and the PDF engine needs CSP `'wasm-unsafe-eval'` (Chrome 97+). Since P0,
`MainActivity.kt` checks the WebView major version at startup (`MIN_WEBVIEW_MAJOR = 111`) and
shows a native "Update Android System WebView" dialog (en + el, from Android resources). ADR 0027
keeps transfers alive in the background with a user-initiated data transfer job on Android 14+
and a plain foreground service below it; the foreground-service path had run on no device: the
API 30 emulator image ships a WebView below 111, so the app could not be used there.

Google Play system images below API 34 still ship WebView 109 (checked: `android-33` rev 9 and
`android-33-ext5` rev 2, built October 2024), and updating it through the Play Store needs a
Google account on the emulator.

## Decision

- **Minimum: Android System WebView 111** (with Android 8.0 / API 26, the app's minSdk). Below
  it, the startup dialog explains it and offers Update (Close ends the app) instead of a broken
  page. Its Update button now opens the store page of the package that really provides WebView
  on the device (`WebView.getCurrentWebViewPackage()`), not a fixed package name. Documented in
  the README (Install) and here.
- **Testing below Android 14:** AVD `selis-api33x5-play` (Google Play image, API 33, extension 5).
  `scripts/avd-webview-update.sh <from> <to>` copies the Google-signed WebView and its
  TrichromeLibrary from a newer AVD (here the API 36 one, WebView 133) and installs them as an
  ordinary update: Android accepts it only because the signature is Google's, the same as the
  system WebView's. No Google account, nothing from outside the SDK's own images.
- `transfer.sh pre-background` samples the keep-alive per API level: the transfer job on 34+,
  the foreground service (`dumpsys activity services …/.TransferForegroundService`,
  `isForeground=true`) below; `post-background` requires it in ≥ 3/4 of the background samples and
  gone afterwards.

## Consequences

- Results on the API 33 AVD are in `docs/release/1.0-rc.md` (P5c).
- A device whose WebView cannot be updated (no Play, abandoned vendor) cannot run Selis; the
  dialog says so instead of a blank screen.
