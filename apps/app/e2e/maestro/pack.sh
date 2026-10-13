#!/usr/bin/env bash
# Hooks for pack.yaml (run.sh PRE_RUN / POST_RUN).
#
#   PRE_RUN="apps/app/e2e/maestro/pack.sh pre" POST_RUN="apps/app/e2e/maestro/pack.sh check" \
#     apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/pack.yaml
#
# pre:   make plain / protected / tampered packs of three fixtures on the host
#        (crates/selis-core/examples/selispack.rs), push them to Download/selis-fixtures,
#        clear Selis and open Files in that folder.
# check: app data holds exactly the three fixtures (BLAKE3 as on the host), no staging
#        or import copies are left, and the packs in Download/ are byte-identical.
# Needs a debuggable build (run-as). Prerequisite: ./push-fixtures.sh <serial>.
set -euo pipefail
mode="${1:?usage: pack.sh pre|check <serial>}"
serial="${2:?usage: pack.sh pre|check <serial>}"
export MSYS_NO_PATHCONV=1

app=com.anywecon.selis
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
fixtures="$root/packages/fixtures/out"
packs="$root/.tmp/p3c/packs-$serial"
remote=/sdcard/Download/selis-fixtures
folder="content://com.android.externalstorage.documents/document/primary%3ADownload%2Fselis-fixtures"
sh_app() { adb -s "$serial" shell run-as "$app" sh -c "'$1'" | tr -d '\r'; }
win() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }

case "$mode" in
  pre)
    rm -rf "$packs"
    (cd "$root" && cargo run -q -p selis-core --example selispack -- make "$(win "$packs")" "correct horse" \
      "$(win "$fixtures/greek.pdf")" "$(win "$fixtures/mixed-sizes.pdf")" "$(win "$fixtures/acroform.pdf")")
    for f in plain protected tampered; do
      adb -s "$serial" push "$(win "$packs/$f.selispack")" "$remote/$f.selispack" >/dev/null
    done
    adb -s "$serial" shell pm clear "$app" >/dev/null
    adb -s "$serial" shell am force-stop com.google.android.documentsui
    adb -s "$serial" shell am start -a android.intent.action.VIEW -t vnd.android.document/directory \
      -d "$folder" com.google.android.documentsui >/dev/null
    sleep 2
    ;;
  check)
    want="$(for f in greek mixed-sizes acroform; do
      (cd "$root" && cargo run -q -p selis-transfer --example selis-peer -- hash "$(win "$fixtures/$f.pdf")") | cut -d' ' -f1
    done | sort | tr '\n' ' ')"
    got="$(sh_app 'ls library/' | grep '\.pdf$' | sed 's/\.pdf$//' | sort | tr '\n' ' ')"
    if [ "$want" != "$got" ]; then
      echo "library files differ: got [$got] want [$want]"
      exit 1
    fi
    left="$(sh_app 'ls pack-in 2>/dev/null; ls cache/share 2>/dev/null | grep import; true' | wc -l | tr -d ' ')"
    if [ "$left" != 0 ]; then
      echo "staging or import copies left behind ($left)"
      exit 1
    fi
    for f in plain protected tampered; do
      a="$(sha256sum "$packs/$f.selispack" | cut -d' ' -f1)"
      b="$(adb -s "$serial" shell sha256sum "$remote/$f.selispack" | cut -d' ' -f1 | tr -d '\r')"
      [ "$a" = "$b" ] || { echo "$f.selispack changed on the device"; exit 1; }
    done
    echo "library: exactly the 3 fixtures (BLAKE3 match), tampered pack added nothing, no leftovers, packs untouched"
    ;;
  *)
    echo "unknown mode $mode"
    exit 2
    ;;
esac
