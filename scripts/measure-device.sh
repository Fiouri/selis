#!/usr/bin/env bash
# Measures the performance gate (first page < 1 s, peak WebView memory < 600 MB,
# 1000-page fixture) on the first connected physical Android device that is not
# a Galaxy S23, and appends a row to docs/spike-p0.md. See measure-device.ts.
#
# Usage: scripts/measure-device.sh [--serial <adb serial>] [--runs 5]
#                                  [--skip-build] [--no-doc] [--allow-emulator]
# Exit: 0 pass, 1 gate failed, 2 error, 3 no suitable device.
#
# Wipes Selis' data on the device (pm clear) before and after; the fixture is
# deleted again and the app stays installed (release-like build, debug-signed).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$root/.tmp"
mkdir -p "$tmp/measure"
# Scratch stays on the project drive (CLAUDE.md, "Windows dev notes"): the
# Android build and adb write their temp files there, not on C:.
script="$root/scripts/measure-device.ts"
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    win_tmp="$(cygpath -w "$tmp")"
    # Paths stay unconverted below (MSYS_NO_PATHCONV, for adb): hand node a Windows path.
    script="$(cygpath -w "$script")"
    ;;
  *) win_tmp="$tmp" ;;
esac
export TMP="$win_tmp" TEMP="$win_tmp" JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=$win_tmp" MSYS_NO_PATHCONV=1
exec node "$script" "$@"
