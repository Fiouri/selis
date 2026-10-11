#!/usr/bin/env bash
# Pages checks on Android.
#
#   POST_RUN="apps/app/e2e/maestro/pages.sh check" \
#     apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/pages.yaml
#
# check: app data holds three library files (the imported original, the version
#        written on close, the extracted page), the version and the extract carry
#        the inserted AcroForm, the stage is empty and the originals in Download/
#        are byte-identical to the generated fixtures.
# drag <serial>: with the pages grid open (nothing selected), long-presses the
#        last thumbnail of the first row and drops it before the first one with
#        `adb input draganddrop`; screenshots before/after go to .tmp/p2c.
# Needs a debuggable build (run-as). Prerequisite: ./push-fixtures.sh <serial>.
set -euo pipefail
mode="${1:?usage: pages.sh check|drag <serial>}"
serial="${2:?usage: pages.sh check|drag <serial>}"
export MSYS_NO_PATHCONV=1

app=com.anywecon.selis
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../../../.."
fixtures="$root/packages/fixtures/out"
sh_app() { adb -s "$serial" shell run-as "$app" sh -c "'$1'" | tr -d '\r'; }

case "$mode" in
  check)
    pdfs="$(sh_app 'ls library/*.pdf 2>/dev/null | wc -l' | tr -d ' ')"
    if [ "$pdfs" != 3 ]; then
      echo "expected 3 library files (original + version + extract), found $pdfs"
      exit 1
    fi
    forms="$(sh_app 'for f in library/*.pdf; do grep -l -a full_name $f; done 2>/dev/null | wc -l' | tr -d ' ')"
    if [ "$forms" != 2 ]; then
      echo "expected the version and the extract to carry the form, found $forms"
      exit 1
    fi
    staged="$(sh_app 'ls work/stage 2>/dev/null | wc -l' | tr -d ' ')"
    if [ "$staged" != 0 ]; then
      echo "staged files were left behind ($staged)"
      exit 1
    fi
    for f in mixed-sizes.pdf acroform.pdf; do
      want="$(sha256sum "$fixtures/$f" | cut -d' ' -f1)"
      got="$(adb -s "$serial" shell sha256sum "/sdcard/Download/selis-fixtures/$f" | cut -d' ' -f1 | tr -d '\r')"
      if [ "$got" != "$want" ]; then
        echo "original $f changed: $got != $want"
        exit 1
      fi
    done
    echo "library: original + version + extract (both with the form); stage empty; originals untouched"
    ;;
  drag)
    out="$root/.tmp/p2c"
    mkdir -p "$out"
    size="$(adb -s "$serial" shell wm size | tail -1 | sed 's/.*: //' | tr -d '\r')"
    w="${size%x*}"
    h="${size#*x}"
    adb -s "$serial" exec-out screencap -p > "$out/drag-before.png"
    # Grid cells: 20 px side, 3 columns; first row's thumbnails sit ~22% down.
    y=$((h * 22 / 100))
    adb -s "$serial" shell input draganddrop $((w * 82 / 100)) "$y" $((w * 6 / 100)) "$y" 1500
    sleep 3
    adb -s "$serial" exec-out screencap -p > "$out/drag-after.png"
    echo "screenshots: $out/drag-before.png, $out/drag-after.png"
    ;;
  *)
    echo "unknown mode $mode"
    exit 2
    ;;
esac
