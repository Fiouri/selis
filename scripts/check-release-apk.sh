#!/usr/bin/env bash
# Fails if a release APK could be inspected or driven from outside: the store
# build must not be debuggable, must not turn on WebView remote debugging, and
# must not be a `--features measure` build (scripts/measure-device.sh).
#
# Usage: scripts/check-release-apk.sh <app.apk>
#
# Checks:
#   1. AndroidManifest: android:debuggable is not set (a debuggable app gets
#      WebView debugging from the system, whatever the code does).
#   2. Native libs: no "setWebContentsDebuggingEnabled". wry compiles that call
#      only with debug_assertions or tauri's `devtools` feature.
#   3. Native libs: no "SELIS_MEASURE_BUILD" marker (src-tauri/src/lib.rs).
#   4. Native libs: no "SELIS_DEBUG_FORCE_RELAY" marker: the transfer testing aid
#      (all traffic through the relay) exists in debug builds only
#      (commands/transfer.rs, ADR 0010).
#   5. Native libs: no "debug.selis." system property names: the debug-only Rust
#      log file and the short-ticket test switch (debug_log.rs).
# Needs unzip and aapt2 ($ANDROID_HOME/build-tools/<newest>).
set -euo pipefail

apk="${1:?usage: check-release-apk.sh <app.apk>}"
[ -f "$apk" ] || { echo "no such APK: $apk" >&2; exit 2; }

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
aapt2=""
if [ -n "$sdk" ] && [ -d "$sdk/build-tools" ]; then
  newest="$(ls "$sdk/build-tools" | sort -V | tail -1)"
  for name in aapt2 aapt2.exe; do
    [ -x "$sdk/build-tools/$newest/$name" ] && aapt2="$sdk/build-tools/$newest/$name"
  done
fi
[ -n "$aapt2" ] || { echo "aapt2 not found (set ANDROID_HOME)" >&2; exit 2; }

failed=0
fail() {
  echo "FAIL: $*" >&2
  failed=1
}

# aapt2 prints the flag as "=true" or, in older versions, "=(type 0x12)0xffffffff".
if "$aapt2" dump xmltree --file AndroidManifest.xml "$apk" | grep -Eq 'android:debuggable\([^)]*\)=(true|\(type 0x12\)0xffffffff)'; then
  fail "AndroidManifest.xml sets android:debuggable"
fi

work="$(mktemp -d "${TMPDIR:-${TMP:-/tmp}}/check-apk.XXXXXX")"
trap 'rm -rf "$work"' EXIT
# Entries by name: some unzip builds (Git Bash) do not match wildcards across "/".
mapfile -t entries < <(unzip -Z1 "$apk" | grep '^lib/.*\.so$' || true)
[ "${#entries[@]}" -gt 0 ] || { echo "no native libraries in $apk" >&2; exit 2; }
unzip -q -o "$apk" "${entries[@]}" -d "$work"

libs=0
while IFS= read -r -d '' so; do
  libs=$((libs + 1))
  name="${so#"$work"/}"
  if grep -q -a 'setWebContentsDebuggingEnabled' "$so"; then
    fail "$name enables WebView remote debugging (tauri devtools / debug build)"
  fi
  if grep -q -a 'SELIS_MEASURE_BUILD' "$so"; then
    fail "$name is a --features measure build"
  fi
  if grep -q -a 'SELIS_DEBUG_FORCE_RELAY' "$so"; then
    fail "$name contains the debug-only transfer \"force relay\" option"
  fi
  if grep -q -a 'debug\.selis\.' "$so"; then
    fail "$name reads debug-only debug.selis.* properties (Rust log, short tickets)"
  fi
done < <(find "$work/lib" -name '*.so' -type f -print0)

if [ "$failed" -ne 0 ]; then
  echo "$(basename "$apk"): NOT safe to ship" >&2
  exit 1
fi
echo "$(basename "$apk"): release-safe ($libs native libs checked, not debuggable)"
