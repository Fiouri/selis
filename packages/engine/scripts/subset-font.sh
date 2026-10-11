#!/usr/bin/env bash
# Regenerates assets/SelisSans-LatinGreek.ttf, the font embedded in PDFs for
# typed text (annotations.ts): Noto Sans Regular (OFL-1.1, from
# @embedpdf/fonts-latin) cut down to Latin, Latin-1/Extended-A, Greek, Greek
# Extended and common punctuation, so each edited PDF carries ~55 KB, not 600.
# The subset is a Modified Version under the OFL, so it must not carry the
# Reserved Font Name "Noto Sans": it is renamed "Selis Sans".
# Needs Python fontTools (`pip install fonttools`).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
src="$here/../../node_modules/@embedpdf/fonts-latin/fonts/NotoSans-Regular.ttf"
out="$here/assets/SelisSans-LatinGreek.ttf"
python -m fontTools.subset "$src" \
  --unicodes="U+0020-007E,U+00A0-017F,U+0370-03FF,U+1F00-1FFF,U+2000-206F,U+20AC,U+2122,U+2190-2193,U+2713,U+2022" \
  --layout-features='kern,liga' --no-hinting --desubroutinize \
  --output-file="$out"
python - "$out" <<'PY'
import sys
from fontTools.ttLib import TTFont
path = sys.argv[1]
font = TTFont(path)
names = {1: "Selis Sans", 2: "Regular", 3: "Selis Sans Regular (subset of Noto Sans)",
         4: "Selis Sans Regular", 6: "SelisSans-Regular", 16: "Selis Sans", 17: "Regular"}
table = font["name"]
for record in list(table.names):
    if record.nameID in names:
        record.string = names[record.nameID]
font.save(path)
PY
