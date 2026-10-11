#!/usr/bin/env bash
# Hooks for import-from-intent.yaml (run.sh PRE_RUN / POST_RUN): "Open with" a PDF
# from the Files app, on a cold or a warm start of Selis.
#
#   PRE_RUN="apps/app/e2e/maestro/open-with.sh cold" \
#   POST_RUN="apps/app/e2e/maestro/open-with.sh check" \
#     apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/import-from-intent.yaml 20
#
# cold:  clear Selis (process gone), open Files in the fixtures folder.
# warm:  clear Selis, start it, wait until it is up, then open Files on top of it.
# check: the original in Download/ must be byte-identical to the generated fixture
#        (Selis imports a copy and never writes to the sender's file).
# Prerequisite: ./push-fixtures.sh <serial>.
set -euo pipefail
mode="${1:?usage: open-with.sh cold|warm|check <serial>}"
serial="${2:?usage: open-with.sh cold|warm|check <serial>}"
export MSYS_NO_PATHCONV=1

app=com.anywecon.selis
file=greek.pdf
here="$(cd "$(dirname "$0")" && pwd)"
local_file="$here/../../../../packages/fixtures/out/$file"
folder="content://com.android.externalstorage.documents/document/primary%3ADownload%2Fselis-fixtures"

open_files() {
  adb -s "$serial" shell am force-stop com.google.android.documentsui
  adb -s "$serial" shell am start -a android.intent.action.VIEW -t vnd.android.document/directory \
    -d "$folder" com.google.android.documentsui >/dev/null
  sleep 2
}

case "$mode" in
  cold)
    adb -s "$serial" shell pm clear "$app" >/dev/null
    open_files
    ;;
  warm)
    adb -s "$serial" shell pm clear "$app" >/dev/null
    adb -s "$serial" shell am start -W -n "$app/.MainActivity" >/dev/null
    # The WebView paints after the activity reports "started"; give the 3 GB AVD time.
    sleep 8
    adb -s "$serial" shell pidof "$app" >/dev/null || { echo "selis is not running"; exit 1; }
    open_files
    ;;
  check)
    want="$(sha256sum "$local_file" | cut -d' ' -f1)"
    got="$(adb -s "$serial" shell sha256sum "/sdcard/Download/selis-fixtures/$file" | cut -d' ' -f1 | tr -d '\r')"
    if [ "$want" != "$got" ]; then
      echo "original changed: $got != $want"
      exit 1
    fi
    echo "original untouched ($got)"
    ;;
  *)
    echo "unknown mode $mode"
    exit 2
    ;;
esac
