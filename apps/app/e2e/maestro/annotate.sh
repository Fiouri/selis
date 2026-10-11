#!/usr/bin/env bash
# POST_RUN hook for annotate.yaml (run.sh):
#
#   POST_RUN="apps/app/e2e/maestro/annotate.sh check" \
#     apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/annotate.yaml
#
# check: app data holds three library files (the imported original + the "Done"
#        version + the recovered version), the newest carries the highlight, ink
#        and typed-text annotations, no working copy is left behind, and the
#        original in Download/ is byte-identical to the generated fixture.
# Needs a debuggable build (run-as). Prerequisite: ./push-fixtures.sh <serial>.
set -euo pipefail
mode="${1:?usage: annotate.sh check <serial>}"
serial="${2:?usage: annotate.sh check <serial>}"
[ "$mode" = check ] || { echo "unknown mode $mode"; exit 2; }
export MSYS_NO_PATHCONV=1

app=com.anywecon.selis
here="$(cd "$(dirname "$0")" && pwd)"
fixtures="$here/../../../../packages/fixtures/out"
sh_app() { adb -s "$serial" shell run-as "$app" sh -c "'$1'" | tr -d '\r'; }

pdfs="$(sh_app 'ls library/*.pdf 2>/dev/null | wc -l' | tr -d ' ')"
if [ "$pdfs" != 3 ]; then
  echo "expected 3 library files (original + 2 versions), found $pdfs"
  exit 1
fi
working="$(sh_app 'ls work/*.pdf 2>/dev/null | wc -l' | tr -d ' ')"
if [ "$working" != 0 ]; then
  echo "a working copy was left behind ($working)"
  exit 1
fi
newest="$(sh_app 'ls -t library/*.pdf | head -1')"
for subtype in /Highlight /Ink /Stamp; do
  if [ "$(sh_app "grep -c -a $subtype $newest || true")" = 0 ]; then
    echo "$newest has no $subtype annotation"
    exit 1
  fi
done
original="$(sha256sum "$fixtures/greek.pdf" | cut -d' ' -f1)"
oldest="$(sh_app 'ls -tr library/*.pdf | head -1')"
v1="$(sh_app "sha256sum $oldest" | cut -d' ' -f1)"
if [ "$v1" != "$original" ]; then
  echo "version 1 ($oldest) is not the imported original"
  exit 1
fi
got="$(adb -s "$serial" shell sha256sum /sdcard/Download/selis-fixtures/greek.pdf | cut -d' ' -f1 | tr -d '\r')"
if [ "$got" != "$original" ]; then
  echo "original greek.pdf changed: $got != $original"
  exit 1
fi
echo "library: original + 2 versions ($newest has highlight, ink, text); no working copy; original untouched"
