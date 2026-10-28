#!/usr/bin/env bash
# Hooks for export-word.yaml (run.sh PRE_RUN / POST_RUN), P7c / ADR 0035.
#
#   PRE_RUN="apps/app/e2e/maestro/export.sh pre" POST_RUN="apps/app/e2e/maestro/export.sh check" \
#     apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/export-word.yaml
#
# pre:   clear Selis (its share folder goes with it).
# check: cache/share holds two Word files (named after the documents' titles); pulled and read on the host
#        (export-check.ts): erase.docx has every word pdf.js reads from erase.pdf, in order, and
#        the picture; scanned-english.docx ≥ 90 % of the words the scan shows (OCR). The library
#        PDFs are untouched (no new version). Debug build (run-as).
set -euo pipefail
mode="${1:?usage: export.sh pre|check <serial>}"
serial="${2:?usage: export.sh pre|check <serial>}"
export MSYS_NO_PATHCONV=1

app=com.anywecon.selis
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
state="$root/.tmp/maestro-export"
win() { cygpath -m "$1" 2>/dev/null || echo "$1"; }
sh_app() { adb -s "$serial" shell run-as "$app" sh -c "'$1'" | tr -d '\r'; }

case "$mode" in
  pre)
    mkdir -p "$state"
    rm -f "$state"/*.docx
    adb -s "$serial" shell pm clear "$app" >/dev/null
    ;;
  check)
    status=0
    rm -f "$state"/*.docx
    names="$(sh_app 'ls cache/share' | grep '\.docx$' || true)"
    count="$(printf '%s
' "$names" | grep -c . || true)"
    if [ "$count" != 2 ]; then
      echo "expected two Word files in cache/share, found $count"
      status=1
    else
      i=0
      while IFS= read -r f; do
        i=$((i + 1))
        adb -s "$serial" exec-out run-as "$app" cat "cache/share/$f" > "$state/export-$i.docx"
      done <<< "$names"
      (cd "$here" && node export-check.ts "$(win "$state/export-1.docx")" "$(win "$state/export-2.docx")") || status=1
    fi
    versions="$(sh_app 'ls library/' | grep -c '\.pdf$' || true)"
    [ "$versions" = 2 ] || { echo "expected the two imported PDFs only, found $versions"; status=1; }
    [ "$status" = 0 ] && echo "export: Word files with the text in order, the picture, and the scan's words"
    exit "$status"
    ;;
  *)
    echo "unknown mode $mode"
    exit 2
    ;;
esac
