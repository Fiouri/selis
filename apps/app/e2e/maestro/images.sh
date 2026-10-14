#!/usr/bin/env bash
# Hooks for images.yaml (run.sh PRE_RUN / POST_RUN), P4b (ADR 0017).
#
#   PRE_RUN="apps/app/e2e/maestro/images.sh pre" POST_RUN="apps/app/e2e/maestro/images.sh check" \
#     apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/images.yaml
#
# pre:   20 phone-like photos (12 MP, ~4 MB, EXIF/GPS/XMP/IPTC, orientation 1–8; made once in
#        .tmp/maestro-images) pushed to Pictures/SelisTest and indexed; Selis cleared; the
#        app's RSS sampled (dumpsys meminfo, ~1/s, at most 15 min).
# check: the RSS before and the peak while the PDF was made (images-rss: the "TIMED create"
#        step); the one library document: 20 pages, qpdf --check, no photo metadata
#        (images-check.ts); the exported page image waits in cache/share; the stage is empty;
#        the photos are removed from the device.
# Needs a debuggable build (run-as), qpdf on the host.
set -euo pipefail
mode="${1:?usage: images.sh pre|check <serial>}"
serial="${2:?usage: images.sh pre|check <serial>}"
export MSYS_NO_PATHCONV=1

app=com.anywecon.selis
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
state="$root/.tmp/maestro-images/$serial"
photos="$root/.tmp/maestro-images/photos"
remote=/sdcard/Pictures/SelisTest
sh_app() { adb -s "$serial" shell run-as "$app" sh -c "'$1'" | tr -d '\r'; }
win() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
scan() {
  adb -s "$serial" shell content call --uri content://media/external/file --method scan_volume --arg external_primary >/dev/null 2>&1 || true
}

case "$mode" in
  pre)
    mkdir -p "$state"
    [ -f "$state/sampler.pid" ] && kill "$(cat "$state/sampler.pid")" 2>/dev/null || true
    [ -d "$photos" ] || (cd "$here" && node make-photos.ts "$(win "$photos")" 20)
    adb -s "$serial" shell rm -rf "$remote"
    adb -s "$serial" shell mkdir -p "$remote"
    for f in "$photos"/*.jpg; do adb -s "$serial" push "$(win "$f")" "$remote/" >/dev/null 2>&1; done
    scan
    adb -s "$serial" shell pm clear "$app" >/dev/null
    : > "$state/rss.log"
    (
      end=$((SECONDS + 900))
      while [ "$SECONDS" -lt "$end" ]; do
        kb="$(adb -s "$serial" shell dumpsys meminfo "$app" 2>/dev/null | tr -d '\r' | sed -n 's/.*TOTAL RSS:[[:space:]]*\([0-9]*\).*/\1/p' | head -1)"
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
    (cd "$here" && node tools-rss.ts "$(win "$state/rss.log")" "$(win "$root/.tmp/maestro/.maestro/tests")" "Selis images to PDF" "TIMED create") || status=1
    files="$(sh_app 'ls library/' | grep '\.pdf$' || true)"
    count="$(printf '%s\n' "$files" | grep -c . || true)"
    if [ "$count" != 1 ]; then
      echo "expected one library document, found $count"
      status=1
    else
      adb -s "$serial" exec-out run-as "$app" cat "library/$files" > "$state/photos.pdf"
      (cd "$here" && node images-check.ts "$(win "$state/photos.pdf")" 20) || status=1
    fi
    png="$(sh_app 'ls cache/share 2>/dev/null' | grep -c 'p[0-9]*\.png$' || true)"
    [ "$png" -ge 1 ] || { echo "no exported page image in cache/share"; status=1; }
    left="$(sh_app 'ls work/stage 2>/dev/null' | grep -c . || true)"
    [ "$left" = 0 ] || { echo "the stage still holds $left file(s)"; status=1; }
    adb -s "$serial" shell rm -rf "$remote"
    scan
    [ "$status" = 0 ] && echo "images: one 20-page PDF, no metadata, stage empty"
    exit "$status"
    ;;
  *)
    echo "unknown mode $mode"
    exit 2
    ;;
esac
