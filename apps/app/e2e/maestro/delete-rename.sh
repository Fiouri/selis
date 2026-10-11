#!/usr/bin/env bash
# POST_RUN hook for delete-rename.yaml (run.sh):
#
#   POST_RUN="apps/app/e2e/maestro/delete-rename.sh check" \
#     apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/delete-rename.yaml 5
#
# check: after the flow, app data holds exactly one library copy (the kept,
#        renamed document; the deleted one's copy is gone) and at most one
#        thumbnail; both originals in Download/ are byte-identical to the
#        generated fixtures (Selis never writes to them, delete included).
# Needs a debuggable build (run-as). Prerequisite: ./push-fixtures.sh <serial>.
set -euo pipefail
mode="${1:?usage: delete-rename.sh check <serial>}"
serial="${2:?usage: delete-rename.sh check <serial>}"
[ "$mode" = check ] || { echo "unknown mode $mode"; exit 2; }
export MSYS_NO_PATHCONV=1

app=com.anywecon.selis
here="$(cd "$(dirname "$0")" && pwd)"
fixtures="$here/../../../../packages/fixtures/out"

count() {
  adb -s "$serial" shell run-as "$app" sh -c "'ls $1 2>/dev/null | wc -l'" | tr -d '\r '
}

pdfs="$(count 'library/*.pdf')"
thumbs="$(count 'thumbs/*')"
if [ "$pdfs" != 1 ]; then
  echo "expected 1 library copy, found $pdfs"
  exit 1
fi
if [ "$thumbs" -gt 1 ]; then
  echo "expected at most 1 thumbnail, found $thumbs"
  exit 1
fi

for file in greek.pdf mixed-sizes.pdf; do
  want="$(sha256sum "$fixtures/$file" | cut -d' ' -f1)"
  got="$(adb -s "$serial" shell sha256sum "/sdcard/Download/selis-fixtures/$file" | cut -d' ' -f1 | tr -d '\r')"
  if [ "$want" != "$got" ]; then
    echo "original $file changed: $got != $want"
    exit 1
  fi
done
echo "library: $pdfs copy, $thumbs thumbnail; originals untouched"
