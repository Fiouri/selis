#!/usr/bin/env bash
# POST_RUN hook for erase.yaml (run.sh):
#
#   POST_RUN="apps/app/e2e/maestro/erase.sh check" \
#     apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/erase.yaml
#
# check: the database lists three versions of the document: the import and two
#        labelled "erase" (ADR 0033); each version's file is in library/ under its
#        BLAKE3; the original version's file is byte-identical to the fixture (so
#        its BLAKE3 is the fixture's); the newest, read by pdf.js (erase-check.ts),
#        has no secret line and no diagonal while the rest stays; no working copy
#        is left; the original in Download/ is untouched.
# Needs a debuggable build (run-as). Prerequisite: ./push-fixtures.sh <serial>.
set -euo pipefail
mode="${1:?usage: erase.sh check <serial>}"
serial="${2:?usage: erase.sh check <serial>}"
[ "$mode" = check ] || { echo "unknown mode $mode"; exit 2; }
export MSYS_NO_PATHCONV=1

app=com.anywecon.selis
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../../../.."
fixtures="$root/packages/fixtures/out"
sh_app() { adb -s "$serial" shell run-as "$app" sh -c "'$1'" | tr -d '\r'; }
# node and python are Windows programs under Git Bash: hand them Windows paths.
win() { cygpath -m "$1" 2>/dev/null || echo "$1"; }

working="$(sh_app 'ls work/*.pdf 2>/dev/null | wc -l' | tr -d ' ')"
if [ "$working" != 0 ]; then
  echo "a working copy was left behind ($working)"
  exit 1
fi

out="$root/.tmp/erase-check/$serial"
rm -rf "$out" && mkdir -p "$out"
for f in selis.db selis.db-wal; do
  adb -s "$serial" exec-out run-as "$app" cat "$f" > "$out/$f" 2>/dev/null || rm -f "$out/$f"
done
rows="$(python -I - "$(win "$out")" <<'PY'
import sqlite3, sys
db = sqlite3.connect(f"{sys.argv[1]}/selis.db")
for seq, label, blake3, path in db.execute("SELECT seq, label, blake3, file_path FROM versions ORDER BY seq"):
    print(seq, label, blake3, path)
PY
)"
# Python on Windows ends lines with CR LF.
rows="$(printf '%s\n' "$rows" | tr -d '\r')"
echo "$rows"
labels="$(echo "$rows" | awk '{print $2}' | tr '\n' ' ')"
case "$labels" in
  "manual erase erase "|"auto erase erase "|"received erase erase ") ;;
  *) echo "expected the import and two 'erase' versions, got: $labels"; exit 1 ;;
esac
while read -r seq label blake3 path; do
  name="$(basename "$path")"
  if [ "$name" != "$blake3.pdf" ]; then
    echo "version $seq: file $name is not named by its BLAKE3 $blake3"
    exit 1
  fi
  adb -s "$serial" exec-out run-as "$app" cat "$path" > "$out/v$seq.pdf" < /dev/null
done <<< "$rows"

want="$(sha256sum "$fixtures/erase.pdf" | cut -d' ' -f1)"
first="$(sha256sum "$out/v1.pdf" | cut -d' ' -f1)"
if [ "$first" != "$want" ]; then
  echo "the original version changed: $first != $want"
  exit 1
fi
(cd "$here" && node erase-check.ts "$(win "$out/v3.pdf")" "$(win "$out/v2.pdf")" "$(win "$fixtures/erase.pdf")")
got="$(adb -s "$serial" shell sha256sum /sdcard/Download/selis-fixtures/erase.pdf | cut -d' ' -f1 | tr -d '\r')"
if [ "$got" != "$want" ]; then
  echo "original erase.pdf changed: $got != $want"
  exit 1
fi
echo "versions: import + 2 erase; the original version byte-identical to the fixture (same BLAKE3); line and diagonal gone (pdf.js); no working copy; original untouched"
