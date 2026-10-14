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
