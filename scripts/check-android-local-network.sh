#!/usr/bin/env bash
# Android 17 (API 37) puts local-network access (mDNS, LAN sockets) behind the
# ACCESS_LOCAL_NETWORK permission for apps that target it. Selis transfers find
# the other device on the same Wi-Fi (ADR 0010), so raising targetSdk to 37
# without declaring it would silently break same-network transfers.
#
# Fails when app/build.gradle.kts targets API >= 37 and AndroidManifest.xml does
# not declare android.permission.ACCESS_LOCAL_NETWORK.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
gradle="$root/apps/app/src-tauri/gen/android/app/build.gradle.kts"
manifest="$root/apps/app/src-tauri/gen/android/app/src/main/AndroidManifest.xml"

target="$(grep -Eo 'targetSdk *= *[0-9]+' "$gradle" | grep -Eo '[0-9]+' | head -1)"
[ -n "$target" ] || { echo "targetSdk not found in $gradle" >&2; exit 2; }

if [ "$target" -ge 37 ] && ! grep -q 'android.permission.ACCESS_LOCAL_NETWORK' "$manifest"; then
  echo "FAIL: targetSdk $target needs <uses-permission android:name=\"android.permission.ACCESS_LOCAL_NETWORK\"/> (and a runtime request before opening the transfer endpoint)" >&2
  exit 1
fi
echo "OK: targetSdk $target, local-network permission rule satisfied"
