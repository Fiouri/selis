#!/usr/bin/env bash
# Signs unsigned release artifacts with the Selis release key (ADR 0021,
# scripts/android-keystore.md). The key never leaves CI secrets: the workflow decodes the
# keystore into the runner's temp dir and deletes it after this script; passwords are read
# from the environment (apksigner `env:`, jarsigner `:env`), never passed on a command line.
#
#   APK: apksigner, APK Signature Scheme v2 + v3 (no v1: minSdk 26 ≥ 24). The APK is not
#        rewritten otherwise, so an F-Droid build of the same commit can take this signature
#        with apksigcopier (docs/store/fdroid/README.md).
#   AAB: jarsigner (Play verifies the upload signature of a bundle with the JAR scheme), with
#        the separate upload key when ANDROID_UPLOAD_* is set, else with the release key.
#
# Usage: android-sign.sh <out-dir> <unsigned.apk|unsigned.aab>...
# Env:   ANDROID_KEYSTORE_FILE, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS,
#        ANDROID_KEY_PASSWORD; optional ANDROID_UPLOAD_KEYSTORE_FILE,
#        ANDROID_UPLOAD_KEYSTORE_PASSWORD, ANDROID_UPLOAD_KEY_ALIAS, ANDROID_UPLOAD_KEY_PASSWORD;
#        APKSIGNER (default: newest build-tools).
set -euo pipefail

out="${1:?usage: android-sign.sh <out-dir> <artifact>...}"
shift
for v in ANDROID_KEYSTORE_FILE ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; do
  [ -n "${!v:-}" ] || { echo "$v is not set" >&2; exit 2; }
done
[ -f "$ANDROID_KEYSTORE_FILE" ] || { echo "keystore not found" >&2; exit 2; }

apksigner="${APKSIGNER:-}"
if [ -z "$apksigner" ]; then
  sdk="${ANDROID_HOME:?ANDROID_HOME is not set}"
  apksigner="$sdk/build-tools/$(ls "$sdk/build-tools" | sort -V | tail -1)/apksigner"
fi

mkdir -p "$out"
for f in "$@"; do
  name="$(basename "$f")"
  signed="$out/${name/-unsigned/}"
  case "$name" in
  *.apk)
    "$apksigner" sign \
      --ks "$ANDROID_KEYSTORE_FILE" --ks-key-alias "$ANDROID_KEY_ALIAS" \
      --ks-pass env:ANDROID_KEYSTORE_PASSWORD --key-pass env:ANDROID_KEY_PASSWORD \
      --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true \
      --out "$signed" "$f"
    rm -f "$signed.idsig"
    ;;
  *.aab)
    cp "$f" "$signed"
    if [ -n "${ANDROID_UPLOAD_KEYSTORE_FILE:-}" ]; then
      jarsigner -keystore "$ANDROID_UPLOAD_KEYSTORE_FILE" \
        -storepass:env ANDROID_UPLOAD_KEYSTORE_PASSWORD -keypass:env ANDROID_UPLOAD_KEY_PASSWORD \
        -sigalg SHA256withRSA -digestalg SHA-256 "$signed" "$ANDROID_UPLOAD_KEY_ALIAS" > /dev/null
    else
      jarsigner -keystore "$ANDROID_KEYSTORE_FILE" \
        -storepass:env ANDROID_KEYSTORE_PASSWORD -keypass:env ANDROID_KEY_PASSWORD \
        -sigalg SHA256withRSA -digestalg SHA-256 "$signed" "$ANDROID_KEY_ALIAS" > /dev/null
    fi
    ;;
  *) echo "not an .apk or .aab: $name" >&2; exit 2 ;;
  esac
  echo "signed $(basename "$signed")"
done
