#!/usr/bin/env bash
# Hooks for convert-docx.yaml (run.sh PRE_RUN / POST_RUN), P7c / ADR 0035.
#
#   PRE_RUN="apps/app/e2e/maestro/convert.sh pre" POST_RUN="apps/app/e2e/maestro/convert.sh check" \
#     apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/convert-docx.yaml
#
# pre:   push two corpus files (report-headings.docx, letter-a4.docx) to Download/selis-convert,
#        media-scan them, clear Selis and open report-headings.docx "with" Selis (VIEW intent,
#        Word MIME type, read grant): a cold start into the conversion preview.
# check: the originals in Download are byte-identical to the corpus; the library holds exactly
#        one PDF (the saved conversion; the cancelled one left nothing); pulled and read by
#        pdf.js: ≥ 98 % of the document's words and LibreOffice's page count ± 1
#        (convert-check.ts); the stage is empty. Prints the WebView's print-callback linkage
#        lines from logcat (non-SDK access, ADR 0035). Debug build (run-as).
set -euo pipefail
mode="${1:?usage: convert.sh pre|check <serial>}"
serial="${2:?usage: convert.sh pre|check <serial>}"
export MSYS_NO_PATHCONV=1

app=com.anywecon.selis
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
corpus="$root/packages/fixtures/out/convert"
remote=/sdcard/Download/selis-convert
state="$root/.tmp/maestro-convert"
mime=application/vnd.openxmlformats-officedocument.wordprocessingml.document
win() { cygpath -m "$1" 2>/dev/null || echo "$1"; }
sh_app() { adb -s "$serial" shell run-as "$app" sh -c "'$1'" | tr -d '\r'; }
scan() { adb -s "$serial" shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://$1" >/dev/null; }
media_id() {
  adb -s "$serial" shell content query --uri content://media/external/downloads --projection _id \
    --where "\"_display_name='$1'\"" | tr -d '\r' | sed -n 's/.*_id=\([0-9]*\).*/\1/p' | head -1
}

case "$mode" in
  pre)
    mkdir -p "$state"
    [ -f "$corpus/report-headings.docx" ] || (cd "$root" && npm run convert-corpus -w @selis/fixtures >/dev/null)
    adb -s "$serial" shell rm -rf "$remote"
    adb -s "$serial" shell mkdir -p "$remote"
    for f in report-headings.docx letter-a4.docx; do
      adb -s "$serial" push "$(win "$corpus/$f")" "$remote/" >/dev/null 2>&1
      scan "$remote/$f"
    done
    id=""
    for _ in $(seq 1 30); do
      id="$(media_id report-headings.docx)"
      [ -n "$id" ] && break
      sleep 1
    done
    [ -n "$id" ] || { echo "report-headings.docx not in the media store"; exit 1; }
    adb -s "$serial" shell pm clear "$app" >/dev/null
    adb -s "$serial" logcat -c
    adb -s "$serial" shell am start -a android.intent.action.VIEW -d "content://media/external/downloads/$id" \
      -t "$mime" --grant-read-uri-permission -n "$app/.MainActivity" >/dev/null
    ;;
  check)
    status=0
    for f in report-headings.docx letter-a4.docx; do
      adb -s "$serial" exec-out cat "$remote/$f" > "$state/$f.device"
      cmp -s "$state/$f.device" "$corpus/$f" || { echo "the original $f changed on the device"; status=1; }
    done
    files="$(sh_app 'ls library/' | grep '\.pdf$' || true)"
    count="$(printf '%s\n' "$files" | grep -c . || true)"
    if [ "$count" != 1 ]; then
      echo "expected one library document, found $count"
      status=1
    else
      adb -s "$serial" exec-out run-as "$app" cat "library/$files" > "$state/converted.pdf"
      (cd "$here" && node convert-check.ts "$(win "$state/converted.pdf")" report-headings) || status=1
    fi
    left="$(sh_app 'ls work/stage 2>/dev/null' | grep -c . || true)"
    [ "$left" = 0 ] || { echo "the stage still holds $left file(s)"; status=1; }
    adb -s "$serial" logcat -d | tr -d '\r' | grep -E 'SelisConvert|PrintDocumentAdapter.(Layout|Write)ResultCallback' | tail -5 || true
    adb -s "$serial" shell rm -rf "$remote"
    scan "$remote"
    [ "$status" = 0 ] && echo "convert: one PDF saved, words and pages as LibreOffice, originals untouched, stage empty"
    exit "$status"
    ;;
  *)
    echo "unknown mode $mode"
    exit 2
    ;;
esac
