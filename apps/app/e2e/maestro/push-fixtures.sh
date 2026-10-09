#!/usr/bin/env bash
# Copies the generated fixture corpus to a device's Download folder and media-scans it
# so the system file picker lists it. Usage: push-fixtures.sh <adb-serial>
set -euo pipefail
serial="$1"
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../../../../packages/fixtures/out"
export MSYS_NO_PATHCONV=1
adb -s "$serial" shell mkdir -p /sdcard/Download/selis-fixtures
for f in "$out"/*.pdf; do
  name="$(basename "$f")"
  adb -s "$serial" push "$(cygpath -m "$f" 2>/dev/null || echo "$f")" /sdcard/Download/selis-fixtures/ >/dev/null 2>&1
  adb -s "$serial" shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
    -d "file:///sdcard/Download/selis-fixtures/$name" >/dev/null
done
echo "pushed $(ls "$out"/*.pdf | wc -l) fixtures to $serial"
