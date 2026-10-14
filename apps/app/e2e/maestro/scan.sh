#!/usr/bin/env bash
# Hooks for scan.yaml (run.sh PRE_RUN / POST_RUN), P4c (ADR 0016).
#
#   PRE_RUN="apps/app/e2e/maestro/scan.sh pre" POST_RUN="apps/app/e2e/maestro/scan.sh check" \
#     apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/scan.yaml
#
# pre:   Selis cleared (empty library, camera permission not yet granted).
# check: the one library document: 5 pages, qpdf --check, pdf.js, no photo metadata
#        (images-check.ts); the live-detection stats the app printed (`[selis:perf] scan …`, one
#        line per camera session): on a real device every session must reach 10 detections a
#        second with no animation-frame gap over 200 ms; on an emulator they are reported only.
# Needs a debuggable build (run-as), qpdf on the host.
set -euo pipefail
mode="${1:?usage: scan.sh pre|check <serial>}"
serial="${2:?usage: scan.sh pre|check <serial>}"
export MSYS_NO_PATHCONV=1

app=com.anywecon.selis
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
state="$root/.tmp/maestro-scan/$serial"
sh_app() { adb -s "$serial" shell run-as "$app" sh -c "'$1'" | tr -d '\r'; }
win() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }

case "$mode" in
  pre)
    mkdir -p "$state"
    adb -s "$serial" shell pm clear "$app" >/dev/null
    ;;
  check)
    status=0
    files="$(sh_app 'ls library/' | grep '\.pdf$' || true)"
    count="$(printf '%s\n' "$files" | grep -c . || true)"
    if [ "$count" != 1 ]; then
      echo "expected one library document, found $count"
      status=1
    else
      adb -s "$serial" exec-out run-as "$app" cat "library/$files" > "$state/scan.pdf"
      (cd "$here" && node images-check.ts "$(win "$state/scan.pdf")" 5) || status=1
    fi
    adb -s "$serial" logcat -d | tr -d '\r' | grep -o '\[selis:perf\] scan.*' > "$state/perf.log" || true
    cat "$state/perf.log"
    sessions="$(grep -c 'scan fps=' "$state/perf.log" || true)"
    [ "$sessions" -ge 1 ] || { echo "no live-detection stats in logcat"; status=1; }
    if [ "$(adb -s "$serial" shell getprop ro.kernel.qemu | tr -d '\r')" != 1 ]; then
      # Sessions shorter than 2 s (the camera between Keep and the next shutter) say little
      # about the rate; all sessions count for stalls.
      bad="$(awk '/scan fps=/ {
        fps = $0; sub(/.*fps=/, "", fps); sub(/ .*/, "", fps);
        gap = $0; sub(/.*maxFrameGap=/, "", gap); sub(/ms.*/, "", gap);
        sec = $0; sub(/.*seconds=/, "", sec);
        if ((sec + 0 >= 2 && fps + 0 < 10) || gap + 0 > 200) print }' "$state/perf.log")"
      [ -z "$bad" ] || { echo "live detection under 10 fps or a frame gap over 200 ms:"; echo "$bad"; status=1; }
    fi
    [ "$status" = 0 ] && echo "scan: one 5-page PDF, qpdf ok, $sessions camera session(s) measured"
    exit "$status"
    ;;
  *)
    echo "unknown mode $mode"
    exit 2
    ;;
esac
