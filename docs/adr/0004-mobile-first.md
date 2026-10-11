# ADR 0004 — Mobile-first delivery

- Status: accepted
- Date: 2026-10-09

## Context

Most PDF reading and signing happens on phones, and mobile WebViews are the most constrained
runtime for a WASM PDF engine. Desktop is comparatively easy once mobile works.

## Decision

Order of delivery: **Android → iOS → desktop**.

- Every phase is accepted on Android (emulator and a physical device) first; iOS is verified in
  CI (macOS runner, simulator) and TestFlight; desktop targets only need to compile in CI until P6.
- `PhoneShell` is the complete, polished layout: bottom tab bar (Library, Recent, Transfer,
  Settings), safe areas, Android edge-to-edge, hardware/gesture back navigates inside the app
  before exiting, empty states with one clear action, skeletons without layout shift.
- `TabletShell` is basic (navigation rail; document = thumbnails + page). `DesktopShell` is a
  placeholder until P6. The shell is chosen from platform + viewport width (`lib/platform.ts`).
- Back navigation uses the History API: each in-app step is a history entry and back from the
  root leaves the app. Since P1 the Android activity asks the UI first (ADR 0006), because
  Chromium skips entries pushed without a user gesture.
- Performance budgets are set and measured on Android (docs/spike-p0.md): first page < 1 s on a
  1000-page document, full scroll without crash, WebView memory < 600 MB.

## Consequences

- UI work is reviewed on phone screenshots first; desktop UX debt is accepted until P6.
- Native Android tweaks live in the committed `gen/android` (e.g. `MainActivity.kt`: insets
  bridge, no WebView zoom, no overscroll glow).
