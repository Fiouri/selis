# P0 spike — EmbedPDF (PDFium WASM) in the Android WebView

Date: 2026-10-09 · Build: debug APK (`tauri android build --debug --apk`, arm64 + x86_64) ·
Fixture: `packages/fixtures` → `large-1000.pdf` (1000 A4 pages, text + vector figures, 816 KB).

Gate (docs/SPEC.md, P0): first page visible **< 1 s**, scroll top → bottom **without crash**,
WebView memory **< 600 MB**.

## Result: PASS on both tested targets — with two gaps (see "Not covered")

| | Android emulator | Physical device |
| --- | --- | --- |
| Device | AVD `sdk_gphone64_x86_64`, Android 16 (API 36), **2 GB RAM** | Samsung Galaxy S23 (SM-S911B, Snapdragon 8 Gen 2, 8 GB), Android 16 (API 36) |
| WebView | 133.0.6943.137 | 153.0.8010.36 |
| First page visible | **610 ms** | **453–461 ms** (5 runs) |
| Of which: read file + open document | — | read 11 ms, open (1000 pages) 382 ms |
| Scroll top → bottom (1000 pages) | 690 steps / 30 s, no crash, last page rendered | 704 steps / 30 s, no crash, last page rendered |
| Pages mounted at once (max) | 5 | 5 |
| Peak memory during scroll, app process | 121 MB | **309 MB** |
| Peak memory during scroll, app + WebView renderer | **301 MB** | **554 MB** |
| After scroll, 20 s idle (app + renderer) | 225 MB | 393 MB |
| After closing the document (app + renderer) | 225 MB | 342 MB |
| Network requests at startup | 5, all `tauri.localhost` (app bundle) — **0 external** | 5, all `tauri.localhost` — **0 external** |

"First page visible" = from opening the viewer (after the system picker returns) until the first
page's pixels are drawn on screen (`[selis:perf] first-page` in logcat, `window.__selisFirstPageMs`).
Pages 1–3 are the first ones drawn (visible pages are rendered before buffer pages).

On the emulator the GPU runs on the host, so graphics memory is not attributed to the app process;
the S23 numbers are the meaningful ones for memory.

## How it was measured

- Fixtures pushed to `/sdcard/Download/selis-fixtures` and media-scanned
  (`apps/app/e2e/maestro/push-fixtures.sh`); import through the real system picker (SAF) with
  `adb shell input tap` on the accessibility tree.
- Driver: Chrome DevTools Protocol over `adb forward … localabstract:webview_devtools_remote_<pid>`
  (the same channel `chrome://inspect` uses).
  - **Network:** `Network.enable`, then `Page.reload` (re-runs the full startup path), all
    `Network.requestWillBeSent` URLs recorded for 4 s. Equivalent to chrome://inspect → Network.
  - **Scroll:** `scrollTop += 0.9 × viewport` every 40 ms until the end (a sustained, faster-than-
    human fling over all 1000 pages), then 1.5 s settle; asserts "Page 1000 of 1000" and that
    page 1000 is drawn.
  - **Memory:** `adb shell dumpsys meminfo com.anywecon.selis` (TOTAL PSS) sampled every 1.5 s,
    **plus** the WebView renderer, which on Android runs in a separate isolated process
    (`com.google.android.webview:sandboxed_process0…`, found via `dumpsys activity processes`).
    The app-process number alone understates WebView memory.
- Pinch-zoom on the device: two-finger touch sequence via `Input.dispatchTouchEvent`; the
  document zoomed (~3.6×, re-rendered sharp), `visualViewport.scale` stayed 1 (page zoom off).
- Back: hardware/gesture back (`input keyevent 4`) with real taps: viewer → Library,
  Recent → Library, Library (root) → leaves the app.
- Maestro `apps/app/e2e/maestro/import-scroll-back.yaml` passes on the emulator and the S23.

## What the spike changed

The first measurements failed the memory budget; three fixes brought it under:

| S23, peak during full scroll | app process | app + renderer |
| --- | --- | --- |
| Initial (ImageBitmap per render, DPR 2.625) | 601 MB | not measured |
| + render DPR capped at 2 on mobile | 543 MB | 710 MB ✗ |
| + raw RGBA transfer + recycled canvas pool | **309 MB** | **554 MB** ✓ |

1. **Raw pixels instead of ImageBitmaps.** Each `ImageBitmap` created in the worker pinned a
   shared-memory/GPU resource in the WebView until GC (`GL mtrack` 235 MB + `Other mmap` 146 MB
   after one scroll). The worker now transfers the RGBA `ArrayBuffer` (zero-copy) and the viewer
   draws it with `putImageData` into a **pool of recycled canvases** (React keys = slots, so the
   canvas backing stores are reused). `GL mtrack` after scroll: 1.5 GB (with a pool bug, fixed) →
   120 MB.
2. **Render DPR capped at 2** on mobile (S23 is 2.625): ~42% fewer pixels per page, no visible
   loss of sharpness at reading size; zoom re-renders at the new scale.
3. **Visible pages before prefetch pages** in the worker queue (the first run drew page 3 first).

Also found and fixed during the spike: native libraries were not 16 KB page-aligned (Android 15+
warning; Play requirement for targetSdk ≥ 35) → `-z max-page-size=16384` in `.cargo/config.toml`.

## Not covered (owner action)

- **Mid-range physical Android device:** the only physical device available was a flagship
  (Galaxy S23). The 2 GB emulator approximates a low-memory device but not a slow CPU/GPU.
  → On a mid-range phone: install the debug APK, run the Maestro flow and read
  `[selis:perf] first-page` from `adb logcat -s Tauri/Console` and `dumpsys meminfo` on a
  mid-range phone (e.g. Snapdragon 6-series / 4–6 GB RAM) before closing P0.
- **iPhone simulator:** the SPEC gate also lists the iPhone simulator; iOS can only be built on
  macOS (CI job `ios`), and memory/latency there is not yet measured.
- Measured on a **debug** build; release (LTO, stripped, smaller `.so`) should only improve
  memory (`.apk mmap` is ~40 MB in debug).

## Decision

The WebView + PDFium WASM architecture meets the P0 gate on the tested targets. The fallback in
docs/SPEC.md "Ρίσκα" (native PDFium via `pdfium-render` on mobile) is **not** triggered; it stays
the contingency if the mid-range or iOS measurements fail. Remaining risk: very large pages at
high zoom (one bitmap per page, capped at 8 MP on mobile → blurry beyond the cap) — tiling is
planned with the P1 viewer work.
