# P4 measurements

## P4a — qpdf operations (2026-10-14)

### Spike: the `qpdf` crate (vendored) on every target

| Target | Result |
| --- | --- |
| Windows x86_64 (MSVC) | builds with the crate's pre-generated bindings; protect / unprotect / compress / linearize run |
| Android aarch64 (S23) | builds (bindgen: host LLVM libclang + `CLANG_PATH` = NDK clang); static libc++ + `-lc++abi`; the four operations run on the device |
| Android x86_64 (AVD) | same; 1000-page fixture: encrypt 61 ms, decrypt 50 ms, compress 35 ms, linearize 49 ms |
| Android armv7 / i686, Linux, iOS simulator | CI (see the PR) |

Release arm64 (LTO, stripped): APK 23.3 → 24.8 MB (+1.46 MB), `libselis_app_lib.so` 20.46 →
21.92 MB. The app's `.so` needs no `libc++_shared.so` (`llvm-readelf -d`: libandroid, libdl, liblog, libm,
libc only).

### Large files (host, release, `examples/pdfops.rs`; peak working set polled every 100 ms)

| Input | Protect | Remove password | Linearize | Compress | Repair |
| --- | --- | --- | --- | --- | --- |
| 2.2 GB, 550 pages (one 4 MB image each) | 66.7 s, **21 MB** | 11.3 s, 22 MB | 119.4 s, 20 MB | 41.4 s, 20 MB (not smaller: random data) | 38.9 s, 20 MB (nothing to repair) |
| 2.2 GB, one page with one 2.2 GB image | 74.3 s, **5.4 GB** | 35.6 s, 5.4 GB | fails (qpdf: 32-bit hint table) | — | — |

qpdf streams the file but holds each stream it writes in memory, so memory follows the largest
stream, not the file. Since then files with a stream over 512 MiB are refused before anything
runs (`tooLarge`): the second file is refused instantly; the first is unaffected (20 MB).

### On the devices (debug build, `tools.yaml` + `tools.sh check`)

Protect `greek.pdf`, reopen it with the password (a wrong one first), editing refused, remove the
password (a wrong one first); then compress, optimise and repair the 1000-page fixture. Every
version pulled from the device passes the host's `qpdf --check` (qpdf 12.4.2) and opens in pdf.js
(the protected one with its password); the page content streams of every version of `greek.pdf`
are BLAKE3-identical to the original; the work folder is empty.

| Device | RSS around Compress (1000 pages; `dumpsys meminfo` TOTAL RSS, ~0.7 s samples) |
| --- | --- |
| Galaxy S23 | 462 → 471 MB (+9 MB); final run 460 → 477 MB (+17 MB) |
| AVD `selis-midrange-api36` | 313 → 318 MB (+5 MB) |

Found on the S23 by this check: the fixture, compressed (object streams) and then linearized,
made `qpdf --check` warn about the outline hint table — qpdf 12.4 itself does the same from its
command line. Linearize now writes without object streams (ADR 0015); a Rust regression test
(100 pages with an outline, checked by the qpdf CLI) covers it.

## P4b — images to PDF, page as image (2026-10-14)

`images.yaml` + `images.sh` (debug builds): 20 phone-like photos (4000×3000, textured, ~4.3 MB
each, 85.8 MB in all; EXIF orientation 1–8, camera make/model/date, GPS, XMP, IPTC, a comment)
pushed to Pictures/SelisTest and picked in the system photo picker (`com.google.android.photopicker`,
no storage permission) ten at a time; "Fit image"; then page 1 saved as PNG (150 dpi).

| Device | RSS around "Create PDF" (`dumpsys meminfo`, ~0.7 s samples) | PDF |
| --- | --- | --- |
| Galaxy S23 | 383 → 470 MB (+86 MB); a second run 377 → 563 MB (+186 MB) | 20 pages, 85.8 MB: the JPEG data as it was (no re-encoding) |
| AVD `selis-midrange-api36` (3 GB) | 312 → 385 MB (+73 MB); a second run 318 → 385 MB (+67 MB) | same |

Every PDF passes `qpdf --check`, and none of the planted metadata (EXIF, GPS, XMP, IPTC, the
comment, maker strings) is in it, raw or inflated (`images-check.ts`); the stage is empty after.
The peak follows the photos' total size (PDFium holds the JPEG data, then the saved PDF goes up in
3 MB chunks), not their pixel count: nothing is decoded except the 240 px grid thumbnails.

Found on the devices: the asset protocol scope did not include the staged photos
(`work/stage/*.img`), so the grid had no thumbnails and "Create PDF" failed — the mock (blob URLs)
could not show it. The two photo picker versions differ: the S23's marks a selected photo
"Selected Photo taken on …", the AVD's does not (`pick-ten-photos.yaml` handles both).

## P4c — document scan (2026-10-14)

### Spike: OpenCV.js (minimal) vs Rust + imageproc → WebAssembly (ADR 0016)

The same algorithm on both (Canny → dilate → outer contours → convex hull → four corners), run in
the Selis WebView over DevTools (debug build): detection on 30 synthetic 240×320 frames (200
timed runs), and straighten + black-and-white of a 3000×4000 photo (3 runs, output 8 MP).
Harness: `.tmp/p4c/bench` (not committed).

| | OpenCV.js 4.12 (core + imgproc, SIMD, `DYNAMIC_EXECUTION=0`) | Rust + imageproc 0.27 (SIMD, opt-level 3) |
| --- | --- | --- |
| Size | 5.06 MB JS with the module inlined (1.28 MB gzip) | 133 KB `.wasm` |
| Load (eval + compile) | 629 ms S23, 865 ms AVD | a few ms |
| Detection, median / p95 | 1.5 / 1.6 ms S23; 2.5 / 5.8 ms AVD | 6.8 / 7.0 ms S23; 12.1 / 14.2 ms AVD |
| Straighten + B&W, median | 168 ms S23; 304 ms AVD | 452 ms S23; 867 ms AVD |
| Pages found | 30 / 30 | 30 / 30 |

OpenCV.js as published needs `'unsafe-eval'` (embind); 4.12 needs patches to build with current
Emscripten. Rust with opt-level `s` was 10× slower (55 ms per frame on the host): the scan module
has its own `wasm` profile at opt-level 3. Chosen: Rust (size, start-up, CSP, build).

### Stored sample photos (`packages/fixtures/scan`, `crates/selis-scan/src/samples.rs`)

Six generated photos (letters, tables, a receipt; wood, granite, fabric and a light-grey desk
that barely differs from the paper; perspective up to a steep 40°-like angle; uneven light;
blur; noise; JPEG 85) and one capture of the AVD's virtual-scene camera (a TV among furniture).
After sub-pixel refinement every outline is within 0.8 px of the ground truth (1 % of the
diagonal allowed) and every straightened page is level within 0.1° (0.3° allowed).

### On the devices (`scan.yaml` + `scan.sh`, debug builds)

Five pages, one camera session before each: live detection runs at its cap of 15 frames a second.

| Device | Detections / s | Detection median / p95 | Longest UI frame gap | Frames over 200 ms | Keep (straighten + encode) | Still |
| --- | --- | --- | --- | --- | --- | --- |
| AVD (virtual scene) | 14.8–15.2 | 6.4–7.0 / 15–21 ms | 33–50 ms | 0 | 37–89 ms | 960×1280 (the emulated sensor) |
| Galaxy S23 | 14.7–15.2 | 8.4–8.7 / 8.9–10.2 ms | 34–50 ms | 0 | 367–469 ms | 2449×3266 (12 MP sensor, scaled to the 8 MP tier) |

On the AVD the live outline locks onto the TV of the virtual scene; on the S23 the camera saw the
desk, so the default outline was kept (the flow does not depend on a page being found). Found by
the device runs: the S23 maps a scaled `takePhoto` size to its nearest supported one, 3000×3000,
cutting off the sides — stills now ask for the sensor's maximum and the worker scales them down;
the scanned pages' JPEGs carry Chrome's ICC profile (APP2) and no other metadata (`scan-check.ts`).

Full Tier 2 Maestro suite with this build (18 flows incl. `scan.yaml`, and the pages drag
check): pass on the AVD and on the S23.

## P4d — OCR (2026-10-14)

`textlayer.node.test.ts` (Node, real PDFium + Tesseract, host): the scanned fixtures (two A4
pages each, 300 dpi JPEG, skewed 0.25–0.35°, noisy) read in ~3.7 s a page; pdf.js extracts
98.0 % / 96.2 % of the Greek words (misses: `ως`, `το` read as Latin `TO`, `ευφυΐα` read with a
polytonic `ῖ`) and ≥ 95 % of the English words; the pages render exactly as before.

On the devices (`ocr.yaml` + `ocr.sh`, debug builds; the Greek fixture, Greek + English, A4
rendered at 300 dpi = 2480 × 3508 px; RSS = app process + WebView renderer, `ps`, ~2/s):

| Device | Page 1 (98 words) | Page 2 (53 words) | pdf.js words p.1 / p.2 | RSS before → peak → after |
| --- | --- | --- | --- | --- |
| AVD `selis-midrange-api36` (3 GB) | 2.9 s | 1.8 s | 98.0 % / 96.2 % | 621 → 1001 MB (+380) → ~777 MB |
| Galaxy S23 | S23_P1 | S23_P2 | S23_WORDS | S23_RSS |

The AVD did not run out of memory. The peak is Tesseract's worker (image, binarisation, LSTM)
plus the engine's 300-dpi render; the worker is terminated when the job ends, the engine's
WebAssembly heap keeps its render buffer. The viewer's search then finds `Ευρωπαϊκή` (1 / 1).
