#!/usr/bin/env bash
# Store checks of release artifacts (ADR 0021). For every APK:
#
#   1. zipalign -c -P 16: entries aligned, uncompressed .so on 16 KB boundaries.
#   2. ELF: every LOAD segment of the 64-bit libraries (arm64-v8a, x86_64) aligned to 16 KB
#      (2**14) and GNU_RELRO ending on a 16 KB boundary. Google Play: apps targeting
#      Android 15+ must support 16 KB pages on 64-bit devices; updates that do not cannot be
#      released from 2027-02-01 (https://developer.android.com/guide/practices/page-sizes).
#   3. targetSdkVersion and compileSdkVersion ≥ MIN_TARGET_SDK: new apps and updates must target
#      Android 16 (API 36) from 2026-08-31
#      (https://support.google.com/googleplay/android-developer/answer/11926878).
#   4. versionCode and versionName as tools/release/version.ts derives them (ADR 0020).
#   5. scripts/check-release-apk.sh: not debuggable, no WebView debugging, no measure build,
#      no debug.selis.* properties.
#   6. With --signed: apksigner verify, APK Signature Scheme v2 and v3 both present and, when
#      APK_CERT_SHA256 is set, the app signing certificate (ADR 0025).
#
# For an AAB: bundletool asks for 16 KB alignment (PAGE_ALIGNMENT_16K), its manifest has the
# same SDK levels and versionCode, and with --signed jarsigner verifies every entry (and, with
# APK_CERT_SHA256, that it carries the upload key, not the app signing key).
#
# Usage: check-android-release.sh [--signed] <artifact.apk|artifact.aab>...
# Needs ANDROID_HOME (build-tools ≥ 35 for zipalign -P), NDK_HOME (llvm-objdump, llvm-readelf),
# node, unzip; for an AAB also BUNDLETOOL (path to bundletool-all.jar) and java.
set -euo pipefail

MIN_TARGET_SDK=36
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"

signed=0
if [ "${1:-}" = "--signed" ]; then signed=1; shift; fi
[ "$#" -gt 0 ] || { echo "usage: check-android-release.sh [--signed] <artifact>..." >&2; exit 2; }

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -n "$sdk" ] || { echo "ANDROID_HOME is not set" >&2; exit 2; }
bt="$sdk/build-tools/$(ls "$sdk/build-tools" | sort -V | tail -1)"
tool() { # first existing of name, name.exe, name.bat in build-tools
  for n in "$1" "$1.exe" "$1.bat"; do [ -e "$bt/$n" ] && { echo "$bt/$n"; return; }; done
  echo "missing $1 in $bt" >&2; exit 2
}
zipalign="$(tool zipalign)"
aapt2="$(tool aapt2)"
apksigner="$(tool apksigner)"
[ -n "${NDK_HOME:-}" ] || { echo "NDK_HOME is not set" >&2; exit 2; }
llvm="$(ls -d "$NDK_HOME"/toolchains/llvm/prebuilt/*/bin | head -1)"
objdump="$llvm/llvm-objdump"; readelf="$llvm/llvm-readelf"
[ -e "$objdump" ] || objdump="$objdump.exe"
[ -e "$readelf" ] || readelf="$readelf.exe"

show="$(node "$root/tools/release/version.ts" show)"
expected_name="$(node -e 'console.log(JSON.parse(process.argv[1]).version)' "$show")"
expected_code() { node -e 'console.log(JSON.parse(process.argv[1]).android[process.argv[2]])' "$show" "$1"; }

failed=0
fail() { echo "FAIL: $*" >&2; failed=1; }

work="$(mktemp -d "${TMPDIR:-${TMP:-/tmp}}/check-android.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# ABI of an APK from its file name (Tauri/AGP: app-<flavor>-release*.apk).
abi_of() {
  case "$(basename "$1")" in
    *arm64*) echo arm64 ;; *x86_64*) echo x86_64 ;; *x86*) echo x86 ;; *arm*) echo arm ;; *) echo universal ;;
  esac
}

check_sdk() { # name target compile code versionName expected-abi
  [ "${2:-0}" -ge "$MIN_TARGET_SDK" ] || fail "$1: targetSdkVersion ${2:-?} < $MIN_TARGET_SDK"
  [ "${3:-0}" -ge "$MIN_TARGET_SDK" ] || fail "$1: compileSdkVersion ${3:-?} < $MIN_TARGET_SDK"
  local want; want="$(expected_code "$6")"
  [ "$4" = "$want" ] || fail "$1: versionCode $4, expected $want ($6)"
  [ "$5" = "$expected_name" ] || fail "$1: versionName $5, expected $expected_name"
}

check_elf() { # name dir-with-lib
  local name="$1" dir="$2" so rel a relro va size
  while IFS= read -r -d '' so; do
    rel="${so#"$dir"/}"
    case "$rel" in lib/arm64-v8a/*|lib/x86_64/*) ;; *) continue ;; esac
    while read -r a; do
      [ "$a" = "2**14" ] || [ "$a" = "2**16" ] || fail "$name: $rel has a LOAD segment aligned to $a (needs 2**14)"
    done < <("$objdump" -p "$so" | awk '/LOAD/ { print $NF }')
    # GNU_RELRO: VirtAddr + MemSiz must be a multiple of 0x4000.
    relro="$("$readelf" -Wl "$so" | awk '$1 == "GNU_RELRO" { print $3, $6 }')"
    if [ -n "$relro" ]; then
      read -r va size <<< "$relro"
      (( (va + size) % 16384 == 0 )) || fail "$name: $rel GNU_RELRO ends at $(printf '0x%x' $((va + size))), not on a 16 KB boundary"
    fi
    echo "  $rel: LOAD 16 KB"
  done < <(find "$dir/lib" -name '*.so' -type f -print0 2>/dev/null)
}

for artifact in "$@"; do
  name="$(basename "$artifact")"
  [ -f "$artifact" ] || { fail "no such file: $artifact"; continue; }
  dir="$work/${name%.*}"; mkdir -p "$dir"
  case "$name" in
  *.apk)
    echo "$name"
    "$zipalign" -c -P 16 -v 4 "$artifact" > "$dir/zipalign.txt" 2>&1 || fail "$name: zipalign -c -P 16 failed ($(grep -c BAD "$dir/zipalign.txt") entries)"
    mapfile -t libs < <(unzip -Z1 "$artifact" | grep '^lib/.*\.so$' || true)
    [ "${#libs[@]}" -gt 0 ] || fail "$name: no native libraries"
    [ "${#libs[@]}" -eq 0 ] || unzip -q -o "$artifact" "${libs[@]}" -d "$dir"
    check_elf "$name" "$dir"
    badging="$("$aapt2" dump badging "$artifact")"
    code="$(sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p" <<< "$badging" | head -1)"
    vname="$(sed -n "s/.*versionName='\([^']*\)'.*/\1/p" <<< "$badging" | head -1)"
    target="$(sed -n "s/^targetSdkVersion:'\([0-9]*\)'.*/\1/p" <<< "$badging")"
    compile="$(sed -n "s/.*compileSdkVersion='\([0-9]*\)'.*/\1/p" <<< "$badging" | head -1)"
    check_sdk "$name" "$target" "$compile" "$code" "$vname" "$(abi_of "$name")"
    echo "  versionCode $code, versionName $vname, targetSdk $target, compileSdk $compile"
    "$here/check-release-apk.sh" "$artifact" || failed=1
    if [ "$signed" = 1 ]; then
      out="$("$apksigner" verify --verbose --print-certs "$artifact" 2>&1)" || fail "$name: apksigner verify failed: $out"
      grep -q 'Verified using v2 scheme (APK Signature Scheme v2): true' <<< "$out" || fail "$name: no v2 signature"
      grep -q 'Verified using v3 scheme (APK Signature Scheme v3): true' <<< "$out" || fail "$name: no v3 signature"
      grep -m1 'certificate SHA-256 digest' <<< "$out" | sed 's/^/  /'
      cert="$(sed -n 's/.*certificate SHA-256 digest: *//p' <<< "$out" | head -1)"
      # ADR 0025: one app signing key everywhere; its fingerprint is public (repo variable).
      if [ -n "${APK_CERT_SHA256:-}" ] && [ "$cert" != "${APK_CERT_SHA256,,}" ]; then
        fail "$name: signed with $cert, expected the app signing key ${APK_CERT_SHA256,,}"
      fi
    fi
    ;;
  *.aab)
    echo "$name"
    [ -n "${BUNDLETOOL:-}" ] || { fail "$name: BUNDLETOOL (bundletool-all.jar) is not set"; continue; }
    java -jar "$BUNDLETOOL" dump config --bundle="$artifact" | grep -q PAGE_ALIGNMENT_16K || fail "$name: bundle does not request 16 KB alignment"
    manifest="$(java -jar "$BUNDLETOOL" dump manifest --bundle="$artifact")"
    code="$(sed -n 's/.*android:versionCode="\([0-9]*\)".*/\1/p' <<< "$manifest" | head -1)"
    vname="$(sed -n 's/.*android:versionName="\([^"]*\)".*/\1/p' <<< "$manifest" | head -1)"
    target="$(sed -n 's/.*android:targetSdkVersion="\([0-9]*\)".*/\1/p' <<< "$manifest" | head -1)"
    compile="$(sed -n 's/.*android:compileSdkVersion="\([0-9]*\)".*/\1/p' <<< "$manifest" | head -1)"
    check_sdk "$name" "$target" "$compile" "$code" "$vname" universal
    grep -q 'android:debuggable="true"' <<< "$manifest" && fail "$name: debuggable"
    echo "  versionCode $code, versionName $vname, targetSdk $target, compileSdk $compile, 16 KB pages"
    mkdir -p "$dir/bundle" && unzip -q -o "$artifact" 'base/lib/*' -d "$dir/bundle" 2>/dev/null || true
    [ -d "$dir/bundle/base/lib" ] && mv "$dir/bundle/base/lib" "$dir/lib" && check_elf "$name" "$dir"
    if [ "$signed" = 1 ]; then
      # Not -strict: an Android upload key is self-signed and its signature has no timestamp, which
      # -strict always reports as errors (Play and Android check neither). Required instead: the
      # whole bundle verified, no unsigned or altered entry.
      jarsigner -verify "$artifact" > "$dir/jarsigner.txt" 2>&1 || fail "$name: jarsigner -verify failed: $(tail -3 "$dir/jarsigner.txt")"
      grep -q '^jar verified\.' "$dir/jarsigner.txt" || fail "$name: jarsigner did not verify it: $(head -3 "$dir/jarsigner.txt")"
      ! grep -qiE 'unsigned entries|jar is unsigned|has been modified|digest .* does not match|not signed' "$dir/jarsigner.txt" ||
        fail "$name: $(grep -iE 'unsigned entries|jar is unsigned|has been modified|does not match|not signed' "$dir/jarsigner.txt" | head -1)"
      # ADR 0025: the bundle carries the upload key, never the app signing key.
      if [ -n "${APK_CERT_SHA256:-}" ]; then
        unzip -q -o "$artifact" 'META-INF/*' -d "$dir/meta" 2>/dev/null || true
        block="$(find "$dir/meta/META-INF" -maxdepth 1 \( -name '*.RSA' -o -name '*.EC' -o -name '*.DSA' \) | head -1)"
        [ -n "$block" ] || fail "$name: no signature block"
        upload="$(keytool -printcert -file "$block" 2>/dev/null | sed -n 's/.*SHA256: *//p' | head -1 | tr -d ':' | tr 'A-F' 'a-f')"
        [ "$upload" != "${APK_CERT_SHA256,,}" ] || fail "$name: signed with the app signing key; the AAB must carry the upload key"
        echo "  upload certificate SHA-256 digest: $upload"
      fi
    fi
    ;;
  *) fail "$name: not an .apk or .aab" ;;
  esac
done

if [ "$failed" -ne 0 ]; then
  echo "release checks FAILED" >&2
  exit 1
fi
echo "release checks passed ($# artifacts)"
