# ADR 0016 — Document scan: page detection in Rust compiled to WebAssembly (P4c)

- Status: accepted; amended 2026-10-18 (Scan 2.0, ADR 0032)
- Date: 2026-10-14

## Context

P4 asks for a camera scan: live page outline on low-resolution frames in a Web Worker, a
full-resolution still, manual corner adjustment, perspective correction, filters (original,
grey, black-and-white adaptive threshold), a multi-page queue and a PDF made by the engine.
The camera stays in the WebView (ADR 0013: `getUserMedia`, no Google ML Kit, no native camera
plugin). Two ways to do the image processing were to be spiked and chosen by latency on the
Galaxy S23 and the AVD and by bundle size: (a) a minimal OpenCV.js build (imgproc only),
(b) Rust compiled to WebAssembly with `imageproc`. Everything bundled, no CDN, CSP unchanged.

## Spike (2026-10-14, `docs/spike-p4.md`)

Both run the same algorithm (Canny → dilate → outer contours → convex hull → Douglas–Peucker
to four corners) on the same 30 synthetic 240×320 frames, and straighten + black-and-white a
3000×4000 photo, inside the Selis WebView (debug build, over DevTools):

| | OpenCV.js 4.12 (core + imgproc, SIMD) | Rust + imageproc 0.27 (SIMD, opt-level 3) |
| --- | --- | --- |
| Size | 5.06 MB single-file JS (1.28 MB gzip) | 133 KB `.wasm` (180 KB with refinement) |
| Load + compile in the WebView | 629 ms (S23), 865 ms (AVD) | a few ms |
| Detection, median per frame | 1.5 ms (S23), 2.5 ms (AVD) | 6.8 ms (S23), 12.1 ms (AVD) |
| Straighten + B&W, 12 MP → 8 MP | 168 ms (S23), 304 ms (AVD) | 452 ms (S23), 867 ms (AVD) |
| Found / 30 | 30 | 30 |
| Under the app's CSP | no: embind generates JavaScript at run time (the Function constructor, which needs `'unsafe-eval'`); works only rebuilt with `-sDYNAMIC_EXECUTION=0` | yes (`'wasm-unsafe-eval'` only) |
| Build | emsdk + OpenCV sources; 4.12 needs patches for current Emscripten (C++17 for embind, a removed `DEMANGLE_SUPPORT` flag); a 5 MB artefact to vendor | `cargo build --target wasm32-unknown-unknown`, pinned toolchain, crates under `cargo deny` |

Both are far inside the budget (≥ 10 fps needs < 100 ms per frame; a still is processed once,
off the UI thread). Size, start-up, CSP and the build decide: **(b)**.

## Decision

- **`crates/selis-scan`** (Rust, `imageproc` 0.27 without default features, `image` 0.25):
  `detect` (live frames, ~320 px long side), `find_page` (a still: `detect` on a small copy,
  then `refine` at full size — each side re-fitted to the nearest strong edge along its normal,
  sub-pixel, robust line fit), `straighten` (homography, bilinear), filters (`Grey`: levels
  stretched 1–99 %; `BlackWhite`: adaptive mean threshold over 1/40 of the page plus anything
  well below the global Otsu level, so filled areas stay black).
  - Detection keeps an outline only if every side lies on edge pixels for ≥ 70 % of its middle
    80 %; candidates come from the convex hull and from the contour itself (all 4-vertex
    subsets of a 5–10-vertex simplification), from thickened and thin edges, so clutter
    touching the page (a TV stand, the edge of a table) does not bend the outline.
  - `imageproc`'s closed Douglas–Peucker drops the closing side; the crate splits the outline
    into two open halves between far-apart points instead (as OpenCV's `approxPolyDP`).
- **WebAssembly ABI**: a few C-ABI exports over linear memory (`src/wasm.rs`, the only module
  allowed `unsafe`); no wasm-bindgen. `imageproc` depends on `rand` → `getrandom`, whose
  `wasm_js` backend links three wasm-bindgen imports; nothing calls them (no start function,
  no random numbers in the scan code) and the loader binds them to functions that throw.
  `scripts/build-scan-wasm.ts` fails the build if any other import appears.
- **Two builds**: with WebAssembly SIMD (Android WebView ≥ 111, iOS 16.4+, desktops) and
  without (iOS 15–16.3); `simdSupported()` validates a one-instruction SIMD module and picks.
  Built by npm pre-scripts (`build:scan` before tests, dev and builds; cargo, about a second
  when nothing changed); the `.wasm` files are not committed. `profile.wasm` (opt-level 3:
  10× faster than `s` here) and a target folder per variant.
- **`packages/scan`**: the worker (module + the current still; decode and encode with
  `OffscreenCanvas` where workers have it, otherwise pixels cross to the main thread), a
  promise client, geometry helpers. One worker per scan session, terminated on close (linear
  memory only grows).
- **Camera** (`lib/camera.ts`, shared with the QR scanner): back camera ~1920×1080 for the
  preview; the still through the Image Capture API (`takePhoto` at the largest sensor size
  that fits the device tier's `maxBitmapPixels`), else the video frame. Torch through the
  `torch` constraint when the track reports it. Live detection: one frame at a time,
  ≤ 15 fps, outline eased between frames; stats (`[selis:perf] scan …`) printed locally.
- **Pages**: straightened at most A4 at 300 dpi (and the tier cap), JPEG 0.9 (PNG for black
  and white), queued in memory, then one PDF through the engine's `ImagePdfBuilder` (ADR 0017,
  "Fit image") and `import_upload`: a new library document, opened in the viewer.
- **Permission denied**: Android opens the app's settings (`open_app_settings`,
  `AppSettingsPlugin.kt`); the camera restarts when the app returns. Everywhere: "Choose photos
  instead" (Images → PDF).

## Consequences

- No new permission (CAMERA is already declared for QR, not required as a feature), no network,
  no Google dependency; ~350 KB of WebAssembly in the bundle for both variants.
- Rust dependencies added (all MIT/Apache, `cargo deny` clean): `imageproc`, `image` (no codecs
  in the app build), `nalgebra`, `rand`, `getrandom` and their small dependencies.
- Test photos: `packages/fixtures/scan` (six generated by `examples/make-samples.rs` — page
  layouts on wood, granite, fabric, light grey, with perspective, uneven light, blur, noise,
  JPEG — and one capture of the Android emulator's virtual scene). Each must be found within
  1 % of the diagonal and straightened with ≤ 0.3° skew (`src/samples.rs`).
- Playwright fakes the camera with a canvas stream (Chromium only: Playwright's WebKit has no
  MediaStream); iOS camera behaviour is verified by the CI build only (no Mac).
- Not in v1: automatic capture when the outline is steady, shadow removal beyond the B&W
  filter, pages that fill the whole frame (their edges are outside it — the default outline is
  the frame inset by 8 %).

## Amendment (2026-10-18): Scan 2.0 (ADR 0032)

- **ABI**: `scan_detect` became `scan_live` (outline plus sharpness, mean luma, the outline's
  share of the frame and the automatic-capture verdict; the grey frame and the tracker live in
  the module between frames) with `scan_auto_reset`; `scan_straighten` became `scan_render`
  (outline, filter, touch-up strokes, quarter turns). Filter code 3 is Enhance, the new default.
- **Automatic capture** when the outline is steady for 0.6 s and the frame is sharp, hints, the
  "Auto" setting; **batch review** (reopen, rotate, touch up, retake, delete, drag to reorder;
  the photo stays with each page); **ID card** mode (two sides at ID-1 size on one A4 page).
- The "Not in v1" items above: automatic capture and shadow removal for colour pages are done;
  pages that fill the whole frame are still not detected.
- WebAssembly: ~412 KB for both variants (was ~350 KB).
