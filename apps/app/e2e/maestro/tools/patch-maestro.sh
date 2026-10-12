#!/usr/bin/env bash
# Builds a patched copy of the Maestro CLI for devices whose WebView rejects
# Maestro's DevTools WebSocket (WebView 15x, e.g. the Galaxy S23): see
# MaestroHostPatch.java. The installed Maestro is not modified.
#
#   apps/app/e2e/maestro/tools/patch-maestro.sh [dest=F:/DevCache/maestro-selis]
#   MAESTRO=F:/DevCache/maestro-selis/bin/maestro apps/app/e2e/maestro/run.sh <serial> <flow>
#
# Re-run after upgrading Maestro; it fails if the patched call is not found.
set -euo pipefail
src="${MAESTRO_HOME:-$HOME/.maestro/maestro}"
dest="${1:-F:/DevCache/maestro-selis}"
here="$(cd "$(dirname "$0")" && pwd)"
class=maestro/android/chromedevtools/DadbChromeDevToolsClient.class
bytebuddy="$(ls "$src"/lib/byte-buddy-*.jar | head -1)"

rm -rf "$dest"
cp -r "$src" "$dest"
work="$dest/.patch"
mkdir -p "$work"
(cd "$work" && unzip -q -o "$dest/lib/maestro-client.jar" "$class")
java -cp "$bytebuddy" "$here/MaestroHostPatch.java" "$work/$class" "$work/$class.patched"
mv "$work/$class.patched" "$work/$class"
(cd "$work" && jar uf "$dest/lib/maestro-client.jar" "$class")
rm -rf "$work"
echo "patched Maestro at $dest (MAESTRO=$dest/bin/maestro)"
