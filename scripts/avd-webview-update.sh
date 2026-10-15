#!/usr/bin/env bash
# Updates Android System WebView on an older AVD with the one from a newer AVD (ADR 0031).
#
#   scripts/avd-webview-update.sh <from-serial> <to-serial>
#
# Google Play system images below API 34 ship WebView 109, under Selis's minimum (111), and
# updating it through the Play Store needs a Google account on the emulator. The WebView of a
# newer image (com.google.android.webview and the TrichromeLibrary it needs) is signed with the
# same Google key, so it installs over the old one as an ordinary update: Android refuses it if
# the signature differs. Both emulators must be x86_64. The update lives in the target AVD's
# data partition (a wipe brings 109 back).
set -euo pipefail
from="${1:?usage: avd-webview-update.sh <from-serial> <to-serial>}"
to="${2:?usage: avd-webview-update.sh <from-serial> <to-serial>}"
export MSYS_NO_PATHCONV=1

root="$(cd "$(dirname "$0")/.." && pwd)"
# adb.exe on Windows wants Windows paths on the host side.
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) root="$(cygpath -m "$root")" ;; esac
work="$root/.tmp/avd-webview"
mkdir -p "$work"

webview="$(adb -s "$from" shell pm path com.google.android.webview | sed -n 's/^package://p' | tr -d '\r' | head -1)"
[ -n "$webview" ] || { echo "no com.google.android.webview on $from" >&2; exit 1; }
library="$(adb -s "$from" shell dumpsys package com.google.android.webview | tr -d '\r' |
  awk '/usesStaticLibraries:/ { s = 1; next } s && /TrichromeLibrary.apk/ { gsub(/^ +/, ""); print; exit }')"
version="$(adb -s "$from" shell dumpsys package com.google.android.webview | tr -d '\r' | sed -n 's/^ *versionName=//p' | head -1)"
echo "WebView $version from $from"

adb -s "$from" pull "$webview" "$work/WebViewGoogle.apk" > /dev/null
if [ -n "$library" ]; then
  adb -s "$from" pull "$library" "$work/TrichromeLibrary.apk" > /dev/null
  adb -s "$to" install "$work/TrichromeLibrary.apk" > /dev/null
fi
adb -s "$to" install -r "$work/WebViewGoogle.apk" > /dev/null
rm -rf "$work"
adb -s "$to" shell dumpsys webviewupdate | tr -d '\r' | grep "Current WebView package"
