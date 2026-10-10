# P0 spike — EmbedPDF (PDFium WASM) in the Android WebView

Date: 2026-10-09 · Build: debug APK (`tauri android build --debug --apk`, arm64 + x86_64) ·
Fixture: `packages/fixtures` → `large-1000.pdf` (1000 A4 pages, text + vector figures, 816 KB).

Gate (docs/SPEC.md, P0): first page visible **< 1 s**, scroll top → bottom **without crash**,
WebView memory **< 600 MB**.

## P0 status (2026-10-10): DONE — except one item

| P0 item | Status |
| --- | --- |
| Monorepo, Tauri 2 app (Android, iOS, Windows/macOS/Linux), strict CSP, least-privilege capabilities | done |
| `packages/engine` (EmbedPDF v2 in a Web Worker), adaptive render limits, LRU page cache | done |
| `packages/ui` tokens, PhoneShell (complete), TabletShell (basic), DesktopShell (placeholder) | done |
| i18n el/en (ICU), Settings language + theme | done |
| `selis-core` (SQLite migrations, atomic_write, BLAKE3), import/list/read via tauri-specta | done |
| Mobile viewer (import → virtualized scroll → pinch-zoom), Android back, safe areas, edge-to-edge | done |
| Fixtures corpus, CI (ubuntu / Android / iOS simulator / Windows) green, repo docs + ADRs | done |
| Spike gate on emulators (2 GB, 3 GB mid-range proxy) and Galaxy S23 | done (pass) |
| **Spike gate on a real mid-range Android device** | **open — must be measured before P1 closes** |

P1 starts only after the UI mockups exist (docs/SPEC.md, "UI/UX design system → Διαδικασία").

## Known issues

- Dependabot alert `glib` 0.18 (RUSTSEC-2024-0429, `VariantStrIter` unsoundness): Linux desktop only,
  transitive via Tauri's gtk-rs 0.18 stack, waiting for upstream — alert left open.
- **Android import could hang on "Importing…" (fixed 2026-10-10).** Seen first with Dependabot PR #13
  (material 1.14.0), but it is a latent race on `main`:
  - *Repro* (Maestro import flow, cold start each run, `selis-midrange-api36`): `main` hung in
    3/20 runs (15 %); `main` + material 1.14.0 (throwaway branch): 3/20 (15 %) — the same rate, so not a material bug.
  - *Cause.* Traced with logcat + temporary instrumentation: the picker returns `RESULT_OK`,
    `onActivityResult` fires, the dialog plugin's Kotlin `filePickerResult` runs and completes
    `invoke.resolve(...)` — but the IPC reply of `plugin:dialog|open` never reaches the WebView: the
    JS callback ids stay registered in `__TAURI_INTERNALS__.callbacks` (checked 3 s after resume),
    so `runCallback` is never called. The reply is lost inside Tauri 2.11 / wry 0.55's
    plugin → IPC → WebView path while the activity resumes (an `evaluateJavascript` issued while the
    WebView is paused is *not* lost, so it is not a simple paused-WebView eval drop). Our UI awaited
    that promise with no exit, so it waited forever. Upstream issue still to be filed.
  - *Fix* (app side, independent of the upstream bug): the picker now runs from Rust
    (`pick_pdf(requestId)`), which also stores the outcome; if the reply does not arrive within 2 s
    of the app returning to the foreground, the UI fetches it with a fresh IPC call
    (`take_pick_result`). The import flow is an explicit state machine
    (idle → picking → importing → done | error | cancelled) where every busy state has an exit; a
    picker cancel returns to idle (Android rejects with "File picker cancelled", previously shown as
    an error); `import_document` has a 30 s deadline that cancels the copy (temp file discarded —
    `atomic_write`/temp+rename means no partial file) and the UI offers a retry (el/en toast). The
    WebView no longer needs `dialog:allow-open`.
  - *Result:* Maestro import flow **20/20** on `main` with the fix. The recovery path is
    exercised in practice: in the final verification runs logcat showed
    `[selis:import] picker reply lost; recovered=picked` in 2 of 3 runs — the same reply loss also
    hits app commands, and fetching the stored outcome with a fresh call always succeeded.

## Result: PASS on every target that can run the app — real mid-range device still open

Final build (adaptive render limits, LRU page cache, engine warm-up):

| | Galaxy S23 (physical) | AVD 3 GB, 1080×2340 (API 36) | AVD 3 GB, 1080×2340 (**API 30**) | AVD 2 GB (API 36), earlier build |
| --- | --- | --- | --- | --- |
| SoC / RAM reported | Snapdragon 8 Gen 2 / 7.4 GB | x86_64, 4 vCPU / 3.1 GB | x86_64 / 3.1 GB | x86_64 / 2.0 GB |
| WebView | 153.0.8010.36 | 133.0.6943.137 | **83.0.4103.106** | 133.0.6943.137 |
| Memory tier → max render scale | mid → **1.5** | low → **1.25** | — | (fixed cap 2) |
| First page, **cold open from the library** (new process, engine not loaded) | **339–344 ms** (3 runs) | **771–959 ms** (3 runs) | **does not run** (see below) | 610 ms |
| First page, right after import through the picker (engine warmed while the picker is open) | 95–125 ms | 395–530 ms | — | — |
| Scroll top → bottom, 1000 pages | no crash, last page drawn | no crash, last page drawn | — | no crash |
| Pages mounted at once (max) | 5 | 5 | — | 5 |
| Peak memory during scroll, app + renderer | **493–503 MB** (app 291–293) | **343–355 MB** (app 143–148) | — | 301 MB |
| After closing the document | 343–344 MB | 270–281 MB | — | 225 MB |
| Network requests at startup | 0 external (5 × `tauri.localhost`) | 0 external | — | 0 external |

"First page" = from opening the viewer until the first page's pixels are on screen
(`[selis:perf] first-page` in logcat). The drawn order is page 1, 2, then the buffer page 3.

On the emulators the GPU runs on the host, so graphics memory is not attributed to the app
process; the S23 numbers are the meaningful ones for GPU memory.

### API 30 image: WebView 83 is not supported

The API 30 `google_apis` system image ships Android System WebView **83** and, without the Play
Store, cannot update it. WebView 83 cannot run the UI: no ES2021 logical assignment (`??=`), no CSP
`'wasm-unsafe-eval'` (Chromium 97+, required to compile PDFium WASM under our CSP), and Tailwind v4
needs Chromium 111+. The image also refuses other WebView providers (only
`com.google.android.webview` is allowed). Real Android 11 phones receive WebView updates through
Google Play, so this is an emulator limitation — but de-Googled or never-updated devices exist, so
the app now shows a **native dialog** ("Update Android System WebView", el/en, opens the store)
when the WebView is older than **111** instead of a blank screen (`MainActivity.kt`). The 3 GB /
1080×2340 profile was therefore measured on API 36 with the same hardware settings.

## How it was measured

- Fixtures pushed to `/sdcard/Download/selis-fixtures` and media-scanned
  (`apps/app/e2e/maestro/push-fixtures.sh`); import through the real system picker (SAF) with
  `adb shell input tap` on the accessibility tree.
- Driver: Chrome DevTools Protocol over `adb forward … localabstract:webview_devtools_remote_<pid>`
  (the channel `chrome://inspect` uses).
  - **Network:** `Network.enable`, then `Page.reload` (re-runs the full startup path), all
    `Network.requestWillBeSent` URLs recorded for 4 s — equivalent to chrome://inspect → Network.
  - **Scroll:** `scrollTop += 0.9 × viewport` every 40 ms until the end (a sustained,
    faster-than-human fling over all 1000 pages), then 1.5 s settle; asserts "Page 1000 of 1000"
    and that page 1000 is drawn.
  - **Memory:** `adb shell dumpsys meminfo com.anywecon.selis` (TOTAL PSS) sampled every 1.5 s,
    **plus** the WebView renderer, which runs in a separate isolated process
    (`com.google.android.webview:sandboxed_process0…`, found via `dumpsys activity processes`).
    The app-process number alone understates WebView memory.
- Cold open: `am force-stop`, launch, tap the document in the library, read logcat.
- Pinch-zoom on the device: two-finger touch sequence via `Input.dispatchTouchEvent`; the
  document zoomed (~3.6×) and re-rendered sharp, `visualViewport.scale` stayed 1.
- Back: hardware/gesture back (`input keyevent 4`) with real taps: viewer → Library,
  Recent → Library, Library (root) → leaves the app.
- Maestro `apps/app/e2e/maestro/import-scroll-back.yaml` passes on the emulators and the S23.

## What the spike changed

| S23, peak during full scroll (app + renderer) | |
| --- | --- |
| Initial (ImageBitmap per render, DPR 2.625) | app alone 601 MB ✗ |
| + render DPR capped at 2 | 710 MB ✗ |
| + raw RGBA transfer + recycled canvas pool | 554 MB ✓ (46 MB headroom) |
| + adaptive limits (mid tier: scale 1.5, 8 MP/bitmap) + LRU page cache | **~500 MB** ✓ |

1. **Raw pixels instead of ImageBitmaps.** Each `ImageBitmap` created in the worker pinned a
   shared-memory/GPU resource until GC. The worker transfers the RGBA `ArrayBuffer` (zero-copy)
   and the viewer draws it with `putImageData` into a **pool of recycled canvases**.
2. **Adaptive render limits by device RAM** (`packages/engine/src/limits.ts`, RAM from the
   `device_memory` command: Android `ActivityManager.MemoryInfo.totalMem`, iOS
   `NSProcessInfo.physicalMemory`, desktop `sysinfo`):

   | Reported RAM | Max render scale | Max bitmap | Page cache (LRU) |
   | --- | --- | --- | --- |
   | > 8 GB | 2.0 | 16 MP | 12 pages / 96 MB |
   | 6–8 GB | 1.5 | 8 MP | 8 pages / 48 MB |
   | < 6 GB or unknown | 1.25 | 6 MP | 4 pages / 24 MB |

   Reported RAM is below the marketed size (an "8 GB" S23 reports 7.4 GB → mid tier). Lower
   tiers trade some sharpness at reading size for memory; zoom re-renders at the zoomed scale.
3. **First-page latency.** The render window is tied to the layout it was computed for (before,
   a pre-measure layout with 0-px pages mounted ~17 pages and delayed page 1); visible pages render
   first, in request order; the engine warms up (WASM fetch + streaming compile) while the picker
   is open or in parallel with the IPC/file read.
4. **16 KB page alignment** of the native libraries (Android 15+, Play requirement for
   targetSdk ≥ 35): `-z max-page-size=16384` in `.cargo/config.toml`.

## Still open (owner action)

- **Real mid-range physical device** — not yet measured. The 3 GB emulator approximates the
  memory budget but not a slower CPU/GPU or thermal throttling; its cold-open first page
  (771–959 ms) is already close to the 1 s budget. Run the Maestro flow on e.g. a Snapdragon 6/7-
  series phone with 4–6 GB and read `[selis:perf] first-page` (logcat `Tauri/Console`) and
  `dumpsys meminfo` for the app + renderer before closing P0.
- **iPhone simulator** measurements (the iOS simulator build passes in CI; latency/memory not
  measured).
- Measured on **debug** builds; release (LTO, stripped `.so`) should only improve memory
  (`.apk mmap` is ~40 MB in debug).

## Decision

The WebView + PDFium WASM architecture meets the P0 gate on the tested targets. The fallback in
docs/SPEC.md "Ρίσκα" (native PDFium via `pdfium-render` on mobile) is **not** triggered; it remains
the contingency if the real mid-range or iOS measurements fail. Known limits: one bitmap per page
(capped per tier → blurry beyond the cap at high zoom; tiling planned with P1), and opening is
O(pages) for page sizes (~300 ms for 1000 pages on the S23).
