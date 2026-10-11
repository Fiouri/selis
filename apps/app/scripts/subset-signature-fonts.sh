#!/usr/bin/env bash
# Regenerates the typed-signature fonts in src/features/sign/fonts: three OFL-1.1
# handwriting families from google/fonts that cover Greek (Google Fonts
# metadata, category Handwriting + subset greek): Mansalva, Mynerve, Playpen Sans
# (variable, instanced at weight 400). Each is cut down to Latin, Latin-1,
# Latin Extended-A, Greek and Greek Extended and saved as WOFF2. No Reserved
# Font Name in their OFL notices, so the subsets keep their names. They are
# only drawn in the WebView (the signature is placed as an image), never
# embedded in a PDF. Needs Python fontTools + brotli and network access.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/src/features/sign/fonts"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
base="https://raw.githubusercontent.com/google/fonts/main/ofl"
unicodes="U+0020-007E,U+00A0-017F,U+0370-03FF,U+1F00-1FFF,U+2010-2027,U+20AC"

curl -sfL "$base/mansalva/Mansalva-Regular.ttf" -o "$work/mansalva.ttf"
curl -sfL "$base/mynerve/Mynerve-Regular.ttf" -o "$work/mynerve.ttf"
curl -sfL "$base/playpensans/PlaypenSans%5Bwght%5D.ttf" -o "$work/playpen-var.ttf"
for name in mansalva mynerve playpensans; do
  curl -sfL "$base/$name/OFL.txt" -o "$out/$name-OFL.txt"
done
python -m fontTools.varLib.instancer "$work/playpen-var.ttf" wght=400 -o "$work/playpensans.ttf"

for name in mansalva mynerve playpensans; do
  python -m fontTools.subset "$work/$name.ttf" --unicodes="$unicodes" \
    --layout-features='kern,liga,calt' --no-hinting --flavor=woff2 \
    --output-file="$out/$name.woff2"
done
ls -la "$out"
