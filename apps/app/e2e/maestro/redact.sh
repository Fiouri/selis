#!/usr/bin/env bash
# POST_RUN hook for redact.yaml (run.sh):
#
#   POST_RUN="apps/app/e2e/maestro/redact.sh check" \
#     apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/redact.yaml
#
# check: app data holds two library files (the imported original + the version
#        written on Done); the version has no pending /Redact marks; read by
#        pdf.js (redact-check.ts) its text no longer has the two redacted lines
#        but keeps the rest, their glyph codes are nowhere in the file, and each
#        box sits on its own line; no working copy is left; the original in
#        Download/ is untouched.
# Needs a debuggable build (run-as). Prerequisite: ./push-fixtures.sh <serial>.
set -euo pipefail
mode="${1:?usage: redact.sh check <serial>}"
serial="${2:?usage: redact.sh check <serial>}"
[ "$mode" = check ] || { echo "unknown mode $mode"; exit 2; }
export MSYS_NO_PATHCONV=1

app=com.anywecon.selis
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../../../.."
fixtures="$root/packages/fixtures/out"
sh_app() { adb -s "$serial" shell run-as "$app" sh -c "'$1'" | tr -d '\r'; }

pdfs="$(sh_app 'ls library/*.pdf 2>/dev/null | wc -l' | tr -d ' ')"
if [ "$pdfs" != 2 ]; then
  echo "expected 2 library files (original + version), found $pdfs"
  exit 1
fi
working="$(sh_app 'ls work/*.pdf 2>/dev/null | wc -l' | tr -d ' ')"
if [ "$working" != 0 ]; then
  echo "a working copy was left behind ($working)"
  exit 1
fi
newest="$(sh_app 'ls -t library/*.pdf | head -1')"
if [ "$(sh_app "grep -c -a /Redact $newest || true")" != 0 ]; then
  echo "$newest still has /Redact marks"
  exit 1
fi
out="$root/.tmp/redact-check"
mkdir -p "$out"
adb -s "$serial" exec-out run-as "$app" cat "$newest" > "$out/version.pdf"
# node is a Windows program under Git Bash: hand it Windows paths.
win() { cygpath -m "$1" 2>/dev/null || echo "$1"; }
# pdf.js (not PDFium, which wrote the file): text, bytes, marks and box positions.
(cd "$here" && node redact-check.ts "$(win "$out/version.pdf")" "$(win "$fixtures/greek.pdf")")
original="$(sha256sum "$fixtures/greek.pdf" | cut -d' ' -f1)"
got="$(adb -s "$serial" shell sha256sum /sdcard/Download/selis-fixtures/greek.pdf | cut -d' ' -f1 | tr -d '\r')"
if [ "$got" != "$original" ]; then
  echo "original greek.pdf changed: $got != $original"
  exit 1
fi
echo "library: original + version; redacted lines gone (pdf.js), boxes on their lines; no marks or working copy left; original untouched"
