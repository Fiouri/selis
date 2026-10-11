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
    that promise with no exit, so it waited forever.
  - *Not specific to the dialog plugin:* after the picker moved into our own `pick_pdf` command,
    the same loss hit that command's reply too.
  - *Upstream status — fixed in the current Tauri line, so no issue was opened.* Minimal repro: a
    fresh `create-tauri-app` (vanilla-ts) plus `tauri-plugin-dialog`, one button calling `open()`,
    and a Maestro flow that cold-starts, picks a PDF and waits for the promise
    (`clearState` → tap → pick → wait 15 s). 20 cold starts each on `selis-midrange-api36`:

    | Versions | `open()` never settled |
    | --- | --- |
    | **tauri 2.11.6**, tauri-runtime-wry 2.11.4, **wry 0.55.1**, tauri-plugin-dialog 2.7.3 (our pins) | **6/20 (30 %)** |
    | **tauri 2.12.2**, tauri-runtime-wry 2.12.1, **wry 0.57.0**, tauri-plugin-dialog 2.8.1 (current) | **0/20** |

    In every failed run the file was picked and the page became visible again, but the promise was
    still pending 20+ s later. Not bisected. Likely candidates are wry 0.56.0's Android lifecycle
    changes ([wry#1720](https://github.com/tauri-apps/wry/pull/1720), `WryActivity` → tao 0.36
    `onResume`) and [wry#1715](https://github.com/tauri-apps/wry/pull/1715) (REQUEST_HANDLER
    mutex).
  - **Root cause fixed upstream in Tauri 2.12 (wry 0.57).** Selis moved to the 2.12 line on
    2026-10-10 (tauri 2.12.3, wry 0.57.0; ADR 0001). Results after the move, on
    `selis-midrange-api36`, through `run.sh` (ANR check):
    - `import-background-resume.yaml` **20/20** and `import-scroll-back.yaml` **20/20**.
    - **0** `take_result` recoveries (`[selis:ipc] … recovered`) and 0 ANRs over the 40 runs.
    - One extra scroll-back failure is not counted: `ConnectException` while the adb server
      restarted under a parallel S23 measurement. The clean rerun was 20/20.

    The IPC reliability layer (ADR 0005) stays as defense in depth.
  - *Fix, first version (2026-10-10, `0500b32`)* — import-only. The picker ran from Rust with a
    one-off outcome store (`take_pick_result`). The import became an explicit state machine
    (idle → picking → importing → done | error | cancelled) where every busy state has an exit. A
    picker cancel returns to idle; Android rejects with "File picker cancelled", which was shown as
    an error before. `import_document` got a 30 s deadline that cancels the copy: the temp file
    is discarded (`atomic_write`, temp + rename), so no partial file is left, and the UI offers a
    retry (el/en toast). Maestro import flow went from 17/20 to **20/20**; the recovery path ran
    in 2 of 3 verification runs.
  - *Fix, generalized (2026-10-10)* — **IPC reliability layer** for every command
    (docs/adr/0005-ipc-reliability.md):
    - Long-running commands (`import_document`, `pick_pdf`, future save/transfer) take a
      client request id.
    - Rust stores each final result (`RequestResults`: TTL 5 min, at most 64 entries) and runs
      the command at most once per id. A duplicate returns the stored result and never repeats
      a write.
    - `take_result(id) → Pending | Done | Unknown` lets the UI fetch a result whose reply was
      lost. It is asked on resume (`visibilitychange`) and on a per-call deadline.
    - Short commands get a 10 s timeout; read-only ones also get one retry.
    - The one-off `take_pick_result` path was removed.
    - Maestro gained `import-background-resume.yaml`: pick → home → relaunch mid-import.
      Result on `selis-midrange-api36`, every run through `run.sh` (ANR check):
      - `import-background-resume.yaml` **20/20**; `import-scroll-back.yaml` **20/20**; 0 ANRs.
      - No reply was lost in these 40 runs (no `[selis:ipc] … recovered` line), so the recovery
        path was not exercised by them.
      - The store was exercised in the real WebView over CDP instead: `take_result` returns
        unknown/done, a duplicate `import_document` with the same id returns the stored result
        without running again (even with another `source`), and an id reused for `pick_pdf` is
        rejected.
      - An earlier 20× attempt went 18/20. Run 12 was a cold start of 8.6 s (normally ~1.1 s);
        run 15 was an ANR caught by the new guard. Its trace shows the emulator's GPU pipe
        stalled (`eglMakeCurrent → qemu_pipe_read`, with the launcher also in ANR). After a
        cold boot of the AVD, and with the first assert waiting up to 20 s for a slow cold
        start, the flows went 20/20.
- **ANR guard for Maestro runs.** The emulator runs with `hide_error_dialogs=1` (otherwise System UI
  ANR dialogs block the flows), which also hides *our* ANR dialogs, so a flow could pass while the
  app was "not responding". `apps/app/e2e/maestro/run.sh <serial> <flow> [runs]` checks logcat
  after every run and fails it on `ANR in com.anywecon.selis` (appId from the flow). Use it for
  all Maestro runs.

## Re-run after the Tauri 2.12 upgrade (2026-10-11)

Same spike, same devices, debug builds. On the S23, `main` on Tauri 2.11 (`cc96a3f`) was
measured again on the same day as an A/B baseline.

| | S23 2.12 | S23 2.11 (same day) | S23 in the table below | AVD 3 GB API 36, 2.12 | AVD in the table below |
| --- | --- | --- | --- | --- | --- |
| First page, cold open from the library | **324–342 ms** (10 runs, median 333) | 343–379 ms (median 348) | 339–344 ms | **404–1182 ms** (13 runs, median ~800) | 771–959 ms |
| First page right after import | 131–135 ms (3) | 94–136 ms (3) | 95–125 ms | 333–1221 ms (3) | 395–530 ms |
| Peak during scroll, app + renderer | **527–532 MB** | 513–532 MB | 493–503 MB | **328–345 MB** | 343–355 MB |
| After closing the document | 369–373 MB | 369–370 MB | 343–344 MB | 261–309 MB | 270–281 MB |
| Scroll 1000 pages / external requests | no crash, last page drawn / 0 | same | same | same | same |

**No regression from 2.12.**
- Against the original table, the S23 is +5–6 % on peak memory and up to +21 % on the post-import
  first page (≈ +20 ms). The 2.11 build measured the same day shows the same numbers, so the
  drift comes from the device state, not from Tauri. Cold open is ~4 % *faster* on 2.12.
- The AVD medians are within the earlier ranges. Its outliers (1.2 s, 2 of 16 first-page samples)
  come from the emulator; the gate stays on the physical devices.
- Peak memory still leaves ≥ 68 MB below the 600 MB gate.

## Re-run with the P1 library and viewer (2026-10-11, AVD)

AVD `selis-midrange-api36` (3 GB, low render tier), debug builds, runs interleaved with the
pre-P1 build (`fe06e99`, CI APK) in the same emulator session, because the emulator drifts
between boots (the same pre-P1 build peaked at 346–350 MB in one run of this session and
369–384 MB in the interleaved runs).

| | pre-P1 (`fe06e99`) | P1b viewer (this branch) |
| --- | --- | --- |
| First page right after import | 438–1075 ms (median ~690) | 287–946 ms (median ~770) |
| Peak during scroll, app + renderer | 369–384 MB (8 runs, median ~380) | 395–413 MB (4 runs, median ~402) |
| After closing the document | 304–311 MB | 334–346 MB |
| Scroll 1000 pages / mounted pages / external requests | no crash, 5 / 0 | no crash, 5 / 0 |

- **+22 MB (+6 %) peak**, within the 10 % budget and ≥ 187 MB below the 600 MB gate. The idle
  library is unchanged (234–239 MB in both); the extra memory appears with the document open
  (selectable text layer, larger UI bundle, page-1 thumbnail).
- Things that were tried while bisecting and kept because they are right anyway: the library
  under the viewer is not painted (`content-visibility: hidden`), thumbnails are encoded on a
  software canvas and released at once, and the text layer is built only after the page bitmap
  is drawn (it delayed the first paint by ~250 ms when it ran first).
- First page stays below 1 s in every run; the AVD's spread is as wide as before.

**S23 (2026-10-11, P1c build).** The first P1 measurement found a real regression: peak
**628–640 MB, over the 600 MB gate** (renderer +77 MB against 2.12). Every page that flew by
during the fast scroll built its text layer: PDFium text pages were loaded in the worker (the
WASM heap grows and never shrinks) and their spans laid out. The text layer is now built only
for pages that stay on screen for 600 ms.

| S23, debug | 2.12 (table above) | P1, text layer per page | P1, text layer on settled pages |
| --- | --- | --- | --- |
| First page right after import | 131–135 ms | 99–101 ms | 96–104 ms |
| Peak during scroll, app + renderer | 527–532 MB | 628–640 MB | **528–534 MB** |
| After closing the document | 369–373 MB | 460–470 MB | 410–434 MB |

AVD with the same build: peak 388–398 MB, first page 658–857 ms. Not measured on a real
mid-range phone (see "Still open").

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
