# tessdata_fast models

`eng.traineddata.gz` and `ell.traineddata.gz`: the LSTM "fast" models from
https://github.com/tesseract-ocr/tessdata_fast at commit 87416418657359cb625c412a48b6e1d6d41c29bd
(2024-08-01), Apache License 2.0, gzipped (`gzip -9 -n`) for tesseract.js (`gzip: true`).

| File | git blob (upstream) | SHA-256 of the unzipped file |
| --- | --- | --- |
| eng.traineddata | bbef4675053b5b468cdb477053e28b1c698ba08e | 7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2 |
| ell.traineddata | ed98ae1a88d84414da316e6eeab3232f2c68639b | 4fba8a0b461038d51f1c20d043d4f2ac38c4e778f1b90830847f7bd8fa3ba726 |

`scripts/copy-ocr-assets.ts` checks these hashes when it copies the models into the app.
