#!/usr/bin/env bash
# Copies the generated fixture corpus to a device's Download folder and media-scans it
# so the system file picker lists it. Usage: push-fixtures.sh <adb-serial>
set -euo pipefail
serial="$1"
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../../../../packages/fixtures/out"
export MSYS_NO_PATHCONV=1
adb -s "$serial" shell mkdir -p /sdcard/Download/selis-fixtures
# small-text.pdf belongs to scripts/measure-sharpness.ts, which pushes it itself: one more file
# here pushes the flows' fixtures off the picker's first screen ("Recent").
only_flows() { [ "$(basename "$1")" != small-text.pdf ]; }
count=0
for f in "$out"/*.pdf; do
  only_flows "$f" || continue
  count=$((count + 1))
  name="$(basename "$f")"
  adb -s "$serial" push "$(cygpath -m "$f" 2>/dev/null || echo "$f")" /sdcard/Download/selis-fixtures/ >/dev/null 2>&1
  adb -s "$serial" shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
    -d "file:///sdcard/Download/selis-fixtures/$name" >/dev/null
done
# The picker's "Recent" lists the newest first and shows about eight under its "Browse files in
# other apps" row: the fixtures flows tap there are touched last, one second apart, so they are
# on the first screen in a known order.
for name in rotated-text shared-xobjects redact-flatten encrypted scanned-greek scanned-english acroform erase mixed-sizes large-1000 greek; do
  [ -f "$out/$name.pdf" ] || continue
  adb -s "$serial" shell touch "/sdcard/Download/selis-fixtures/$name.pdf"
  adb -s "$serial" shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE     -d "file:///sdcard/Download/selis-fixtures/$name.pdf" >/dev/null
  sleep 1
done
echo "pushed $count fixtures to $serial"
