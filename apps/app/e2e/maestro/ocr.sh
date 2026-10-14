#!/usr/bin/env bash
# Hooks for ocr.yaml (run.sh PRE_RUN / POST_RUN), P4d (ADR 0018).
#
#   PRE_RUN="apps/app/e2e/maestro/ocr.sh pre" POST_RUN="apps/app/e2e/maestro/ocr.sh check" \
#     apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/ocr.yaml
#
# pre:   Selis cleared; the RSS of the app and its WebView renderer sampled (ps, ~2/s, at most
#        15 min; another app's WebView renderer running at the same time would count too).
# check: the per-page times the app printed (`[selis:perf] ocr page=…`); the RSS before and the
#        peak during the OCR (the "TIMED ocr" step); the library holds the original and one new
#        version; the new version passes qpdf --check and pdf.js reads ≥ 95 % of the words of
#        each page (ocr-check.ts).
# Needs a debuggable build (run-as), qpdf on the host, ./push-fixtures.sh <serial>.
set -euo pipefail
mode="${1:?usage: ocr.sh pre|check <serial>}"
serial="${2:?usage: ocr.sh pre|check <serial>}"
export MSYS_NO_PATHCONV=1

app=com.anywecon.selis
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
state="$root/.tmp/maestro-ocr/$serial"
sh_app() { adb -s "$serial" shell run-as "$app" sh -c "'$1'" | tr -d '\r'; }
win() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }

case "$mode" in
  pre)
    mkdir -p "$state"
    [ -f "$state/sampler.pid" ] && kill "$(cat "$state/sampler.pid")" 2>/dev/null || true
    adb -s "$serial" shell pm clear "$app" >/dev/null
    adb -s "$serial" shell am force-stop com.google.android.documentsui
    : > "$state/rss.log"
    (
      end=$((SECONDS + 900))
      while [ "$SECONDS" -lt "$end" ]; do
        # The app process plus the WebView renderer, where Tesseract and the engine run (RSS, KB).
        kb="$(adb -s "$serial" shell ps -A -o RSS,NAME 2>/dev/null | tr -d '\r' | awk -v app="$app" '$2 == app || $2 ~ /^com\.google\.android\.webview:sandboxed_process/ { sum += $1 } END { if (sum > 0) print sum }')"
        [ -n "$kb" ] && echo "$(date +%s%3N) $kb" >> "$state/rss.log"
        sleep 0.5
      done
    ) &
    echo $! > "$state/sampler.pid"
    ;;
  check)
    [ -f "$state/sampler.pid" ] && kill "$(cat "$state/sampler.pid")" 2>/dev/null || true
    rm -f "$state/sampler.pid"
    status=0
    adb -s "$serial" logcat -d | tr -d '\r' | grep -o '\[selis:perf\] ocr.*' || { echo "no OCR timings in logcat"; status=1; }
    (cd "$here" && node tools-rss.ts "$(win "$state/rss.log")" "$(win "$root/.tmp/maestro/.maestro/tests")" "Selis OCR" "TIMED ocr") || status=1
    files="$(sh_app 'ls -t library/' | grep '\.pdf$' || true)"
    count="$(printf '%s\n' "$files" | grep -c . || true)"
    if [ "$count" != 2 ]; then
      echo "expected the original and one new version in the library, found $count file(s)"
      status=1
    else
      newest="$(printf '%s\n' "$files" | head -1)"
      adb -s "$serial" exec-out run-as "$app" cat "library/$newest" > "$state/ocr.pdf"
      (cd "$here" && node ocr-check.ts "$(win "$state/ocr.pdf")" greek) || status=1
    fi
    [ "$status" = 0 ] && echo "ocr: new version searchable (≥ 95 % of the words on each page)"
    exit "$status"
    ;;
  *)
    echo "unknown mode $mode"
    exit 2
    ;;
esac
