# ADR 0013 — QR scanning in the WebView (no Google ML Kit)

- Status: accepted
- Date: 2026-10-12

## Context

The P3 brief named `tauri-plugin-barcode-scanner`. Its Android implementation (2.5.2) depends on
`com.google.android.gms:play-services-mlkit-barcode-scanning`. Google's ML Kit terms state that
"the ML Kit APIs … send metrics about the performance and utilization of the APIs in your app to
Google" and may contact Google servers for model updates, and that the app must disclose this.
Selis forbids telemetry SDKs and promises that nothing is collected (docs/SPEC.md,
docs/PRIVACY.md); it also must not open connections outside `selis-transfer`. Scanning would
also fail on devices without Google Play services.

## Decision

Scan in the WebView: `getUserMedia` (back camera) + **jsQR 1.4.0** (Apache-2.0, pure JS, no
network) decoding a centred square of each frame six times a second
(`features/transfer/qrScanner.ts`). The camera starts only when the user taps "Scan QR code" and
stops when a code is read, the user stops it, the screen closes or the app goes to the background.

- Android: wry 0.57's `WebChromeClient.onPermissionRequest` asks for `CAMERA` at runtime
  (declared in the manifest, `android.hardware.camera` not required). Denied → the viewfinder
  says so and "Paste link" remains.
- iOS: WKWebView `getUserMedia` (iOS 14.3+), `NSCameraUsageDescription` in Info.plist.
- Desktop: same code (P6).
- The system camera app can also read the code: the `selis://transfer/…` link opens Selis'
  Receive tab (deep link).

## Consequences

- No Google dependency, no extra native code, the same scanner everywhere, and it is testable:
  Playwright feeds Chromium a fake camera filming the fixture QR code (`transfer-camera.spec.ts`).
- jsQR is unmaintained since 2021 but small and stable; QR codes on a screen at arm's length
  decode reliably. If needed it can move into a Web Worker or be replaced by zxing-cpp (WASM,
  self-hosted).
- iOS WKWebView camera behaviour is verified in CI build only (no Mac).
