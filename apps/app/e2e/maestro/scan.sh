#!/usr/bin/env bash
# Hooks for scan.yaml, scan-auto.yaml, scan-batch.yaml and scan-idcard.yaml (run.sh PRE_RUN /
# POST_RUN), P4c (ADR 0016) and Scan 2.0 (ADR 0032).
#
#   PRE_RUN="apps/app/e2e/maestro/scan.sh pre" POST_RUN="apps/app/e2e/maestro/scan.sh check" \
#     apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/scan.yaml
#   … scan-auto.yaml:   PRE_RUN="… pre"        POST_RUN="… check-auto"
#   … scan-batch.yaml:  PRE_RUN="… pre-batch"  POST_RUN="… check-batch"
#   … scan-idcard.yaml: PRE_RUN="… pre"        POST_RUN="… check-idcard"
#
# pre:          Selis cleared (empty library, camera permission not yet granted).
# pre-batch:    the same, and ten numbered page photos (make-scan-pages.ts: page k has k bars)
#               pushed to Pictures/SelisScan, page 1 the newest (first in the photo picker).
# check:        the one library document: 5 pages, qpdf --check, pdf.js, no photo metadata
#               (scan-check.ts: no metadata segment in any page JPEG); the live-detection stats
#               the app printed (`[selis:perf] scan …`, one line per camera session): on a real
#               device every session must reach 10 detections a second with no animation-frame
#               gap over 200 ms; on an emulator they are reported only.
# check-auto:   one document of 2 pages (qpdf, pdf.js, no metadata); logcat says exactly one
#               page was captured automatically (the second was the shutter).
# check-batch:  one document of 9 pages (qpdf, pdf.js, no metadata) in the order the flow left
#               them: 3, retaken (camera), 2, 4, 5 turned, 7, 8, 9, 10 (scan-batch-check.ts);
#               the photos are removed from the device.
# check-idcard: one document, one A4 page with both sides at 85.6 × 54 mm (scan-idcard-check.ts).
# Needs a debuggable build (run-as), qpdf on the host.
set -euo pipefail
mode="${1:?usage: scan.sh pre|pre-batch|check|check-auto|check-batch|check-idcard <serial>}"
serial="${2:?usage: scan.sh <mode> <serial>}"
export MSYS_NO_PATHCONV=1

app=com.anywecon.selis
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
state="$root/.tmp/maestro-scan/$serial"
photos="$root/.tmp/maestro-scan/pages"
remote=/sdcard/Pictures/SelisScan
sh_app() { adb -s "$serial" shell run-as "$app" sh -c "'$1'" | tr -d '\r'; }
win() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
media_scan() {
  adb -s "$serial" shell content call --uri content://media/external/file --method scan_volume --arg external_primary >/dev/null 2>&1 || true
}

# Pulls the one library document to $state/scan.pdf; fails when there is not exactly one.
pull_one() {
  local files count
  files="$(sh_app 'ls library/' | grep '\.pdf$' || true)"
  count="$(printf '%s\n' "$files" | grep -c . || true)"
  if [ "$count" != 1 ]; then
    echo "expected one library document, found $count"
    return 1
  fi
  adb -s "$serial" exec-out run-as "$app" cat "library/$files" > "$state/scan.pdf"
}

case "$mode" in
  pre)
    mkdir -p "$state"
    adb -s "$serial" shell pm clear "$app" >/dev/null
    adb -s "$serial" logcat -c
    ;;
  pre-batch)
    mkdir -p "$state"
    [ -f "$photos/selis-scan-page-10.jpg" ] || (cd "$here" && node make-scan-pages.ts "$(win "$photos")" 10)
    adb -s "$serial" shell rm -rf "$remote"
    adb -s "$serial" shell mkdir -p "$remote"
    # The picker lists the newest first: page 1 gets the latest time.
    for k in 01 02 03 04 05 06 07 08 09 10; do
      adb -s "$serial" push "$(win "$photos/selis-scan-page-$k.jpg")" "$remote/" >/dev/null 2>&1
      adb -s "$serial" shell touch -t "20300101$(printf '%02d' $((20 - 10#$k)))00.00" "$remote/selis-scan-page-$k.jpg"
    done
    media_scan
    adb -s "$serial" shell pm clear "$app" >/dev/null
    adb -s "$serial" logcat -c
    ;;
  check)
    status=0
    if pull_one; then
      (cd "$here" && node scan-check.ts "$(win "$state/scan.pdf")" 5) || status=1
    else
      status=1
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
  check-auto)
    status=0
    if pull_one; then
      (cd "$here" && node scan-check.ts "$(win "$state/scan.pdf")" 2) || status=1
    else
      status=1
    fi
    adb -s "$serial" logcat -d | tr -d '\r' | grep -o '\[selis:perf\] scan.*' > "$state/perf.log" || true
    autos="$(grep -c 'scan auto-capture' "$state/perf.log" || true)"
    grep 'scan fps=' "$state/perf.log" || true
    [ "$autos" = 1 ] || { echo "expected one automatic capture, logcat has $autos"; status=1; }
    [ "$status" = 0 ] && echo "scan-auto: one 2-page PDF, one automatic capture"
    exit "$status"
    ;;
  check-batch)
    status=0
    if pull_one; then
      (cd "$here" && node scan-check.ts "$(win "$state/scan.pdf")" 9) || status=1
      (cd "$here" && node scan-batch-check.ts "$(win "$state/scan.pdf")" "3,x,2,4,5r,6,8,9,x") || status=1
    else
      status=1
    fi
    adb -s "$serial" shell rm -rf "$remote"
    media_scan
    [ "$status" = 0 ] && echo "scan-batch: one 9-page PDF in the expected order"
    exit "$status"
    ;;
  check-idcard)
    status=0
    if pull_one; then
      (cd "$here" && node scan-check.ts "$(win "$state/scan.pdf")" 1) || status=1
      (cd "$here" && node scan-idcard-check.ts "$(win "$state/scan.pdf")") || status=1
    else
      status=1
    fi
    [ "$status" = 0 ] && echo "scan-idcard: one A4 page with both sides at ID-1 size"
    exit "$status"
    ;;
  *)
    echo "unknown mode $mode"
    exit 2
    ;;
esac
