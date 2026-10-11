# ADR 0006 — "Open with" / share import, and Android back through the UI

- Status: accepted
- Date: 2026-10-11

## Context

P1 makes Selis a target for "Open with" and share on Android and iOS. A document handed over
by another app must be imported as a copy (never written back), through the same reliable path
as the picker (ADR 0005), on a cold start and on a warm start.

Tauri 2.12 already parses VIEW / SEND intents (tao → `RunEvent::Opened`), but it drops the
sender's file name, does not filter by scheme, and panics on some malformed intents. We also
found that opening the viewer from such an intent broke Android back: Chromium skips history
entries pushed without a user gesture, so after a cold "Open with" `WebView.canGoBack()` was
false and back closed the app instead of returning to the library.

## Decision

**Import.**

- Android: a small Kotlin plugin in the app module (`OpenWithPlugin.kt`, registered from
  `commands/open_with.rs`) collects `content://` URIs from ACTION_VIEW, ACTION_SEND and
  ACTION_SEND_MULTIPLE (launch intent and `onNewIntent`), with their `DISPLAY_NAME`. Intents
  re-delivered from Recents are ignored (their URI grant is gone). No storage permission: the
  sender grants read access with the intent.
- iOS: `CFBundleDocumentTypes` for `com.adobe.pdf` with `LSSupportsOpeningDocumentsInPlace = NO`
  (iOS copies the file into the app's Inbox); `RunEvent::Opened` file URLs go to the same queue.
  "Share" to Selis works through these document types; a Share Extension is not part of P1.
- Rust keeps an `OpenQueue`. The UI reads it (`pending_opens`, read-only, retryable) on startup
  and whenever the app is back in front, imports each item through the import state machine and
  `import_document` (request id, ADR 0005), then calls `dismiss_open`. One document opens the
  viewer; several stay in the library with a summary.

**Back.** `MainActivity` asks the UI first (`window.__selisBack()`, `state/navigation.ts`). The UI
closes an overlay, leaves the viewer or the tab (with `history.back()`, which the Chromium
intervention does not affect) and returns true, or returns false at the root, and only then
does the system back run (Tauri's handler, which leaves the app). An unanswered call falls back
to the system back after 600 ms. Sheets and the search field are history entries
(`useOverlay`), so back closes them first.

## Consequences

- `gen/android` carries two of our files (`MainActivity.kt`, `OpenWithPlugin.kt`) and the intent
  filters in `AndroidManifest.xml`; keep them when regenerating (ADR 0001).
- Maestro covers both starts: `e2e/maestro/import-from-intent.yaml` with `open-with.sh cold|warm`
  (run.sh `PRE_RUN`) and `open-with.sh check` (`POST_RUN`, the original stays byte-identical).
- iOS "Open in" is built in CI only and stays unverified until TestFlight.
