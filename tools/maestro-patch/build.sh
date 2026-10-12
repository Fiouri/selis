#!/usr/bin/env bash
# Rebuilds the patched Maestro CLI used for devices whose WebView rejects
# Maestro's DevTools WebSocket (WebView 15x, e.g. the Galaxy S23). See README.md.
#
#   tools/maestro-patch/build.sh [dest=F:/DevCache/maestro-selis]
#   MAESTRO=F:/DevCache/maestro-selis/bin/maestro apps/app/e2e/maestro/run.sh <serial> <flow>
#
# Downloads the pinned upstream release (checked against its SHA-256), unpacks
# it into <dest>, applies MaestroHostPatch.java to the one class the fix touches
# (the bytecode form of maestro-ws-host.patch) and writes <dest>/PATCHED. The
# installed Maestro (~/.maestro) is never touched. Needs curl, unzip and a JDK
# (java + jar, 17+). Scratch goes to the repository's .tmp/maestro-patch.
set -euo pipefail

MAESTRO_TAG="cli-2.11.0"
MAESTRO_ZIP_SHA256="5384593cb4e7a106489e75a821d157dd43f4e438df6bc308b72e82c685e1283a"
URL="https://github.com/mobile-dev-inc/Maestro/releases/download/${MAESTRO_TAG}/maestro.zip"
CLASS="maestro/android/chromedevtools/DadbChromeDevToolsClient.class"

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
dest="${1:-F:/DevCache/maestro-selis}"
scratch="$root/.tmp/maestro-patch"
zip="$scratch/maestro-${MAESTRO_TAG}.zip"
mkdir -p "$scratch"

sha256() { sha256sum "$1" | cut -d' ' -f1; }

if [ ! -f "$zip" ] || [ "$(sha256 "$zip")" != "$MAESTRO_ZIP_SHA256" ]; then
  echo "downloading $URL"
  curl -fsSL --retry 3 -o "$zip.part" "$URL"
  mv "$zip.part" "$zip"
fi
got="$(sha256 "$zip")"
if [ "$got" != "$MAESTRO_ZIP_SHA256" ]; then
  echo "checksum mismatch for $zip: $got (expected $MAESTRO_ZIP_SHA256)" >&2
  exit 1
fi

unpack="$scratch/unpack"
rm -rf "$unpack"
mkdir -p "$unpack"
unzip -q "$zip" -d "$unpack"
# The archive holds one top-level folder (maestro/).
src="$unpack/maestro"
[ -f "$src/lib/maestro-client.jar" ] || { echo "unexpected archive layout in $zip" >&2; exit 1; }

work="$scratch/class"
rm -rf "$work"
mkdir -p "$work"
(cd "$work" && unzip -q -o "$src/lib/maestro-client.jar" "$CLASS")
bytebuddy="$(ls "$src"/lib/byte-buddy-*.jar | head -1)"
java -cp "$bytebuddy" "$here/MaestroHostPatch.java" "$work/$CLASS" "$work/$CLASS.patched"
mv "$work/$CLASS.patched" "$work/$CLASS"
(cd "$work" && jar uf "$src/lib/maestro-client.jar" "$CLASS")
chmod +x "$src/bin/maestro"

rm -rf "$dest"
mkdir -p "$(dirname "$dest")"
mv "$src" "$dest"
cat > "$dest/PATCHED" <<EOF
upstream: $MAESTRO_TAG ($URL)
sha256: $MAESTRO_ZIP_SHA256
patch: tools/maestro-patch/maestro-ws-host.patch (applied as bytecode by MaestroHostPatch.java)
EOF
rm -rf "$unpack" "$work"
echo "patched Maestro $MAESTRO_TAG at $dest (MAESTRO=$dest/bin/maestro)"
