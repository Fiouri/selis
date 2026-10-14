# Evidence

Raw results the docs cite, moved here from the git-ignored `.tmp/` so they outlive scratch
cleanups. Not part of any build or check.

- `p2c-acroform-import-probe.txt` — ADR 0008: what PDFium's page import does to `/AcroForm`.
- `measure/result-<serial>.json` — docs/spike-p0.md: raw output of `scripts/measure-device.sh`
  (new runs still write to `.tmp/measure/`).
- `p4c-bench/` — docs/spike-p4.md (P4c spike): the OpenCV.js vs Rust/imageproc benchmark that ran
  inside the Selis WebView over DevTools, and its S23 / AVD results. The OpenCV.js build (5 MB,
  emsdk + a patched OpenCV 4.12 with `-sDYNAMIC_EXECUTION=0`) and the `.wasm` builds are not
  kept; `run-device.mjs <serial> <port> <scan.wasm>` expects them next to it.
- `p4d-ocr-memory/` — docs/spike-p4.md (P4d follow-up): `ocr.sh`'s memory samples before and after
  the grey render, one line per sample: `<epoch ms> <app PSS> <renderer PSS> <app RSS> <renderer RSS>` (kB).
