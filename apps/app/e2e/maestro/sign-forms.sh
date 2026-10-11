#!/usr/bin/env bash
# POST_RUN hook for sign-forms.yaml (run.sh):
#
#   POST_RUN="apps/app/e2e/maestro/sign-forms.sh check" \
#     apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/sign-forms.yaml
#
# check: app data holds three library files (the imported original + the form
#        version + the signed version); the newest still has its AcroForm, the
#        typed value and a visual-signature stamp; one signature PNG is saved;
#        no working copy is left; the original in Download/ is byte-identical.
# Needs a debuggable build (run-as). Prerequisite: ./push-fixtures.sh <serial>.
set -euo pipefail
mode="${1:?usage: sign-forms.sh check <serial>}"
serial="${2:?usage: sign-forms.sh check <serial>}"
[ "$mode" = check ] || { echo "unknown mode $mode"; exit 2; }
export MSYS_NO_PATHCONV=1

app=com.anywecon.selis
here="$(cd "$(dirname "$0")" && pwd)"
fixtures="$here/../../../../packages/fixtures/out"
sh_app() { adb -s "$serial" shell run-as "$app" sh -c "'$1'" | tr -d '\r'; }

pdfs="$(sh_app 'ls library/*.pdf 2>/dev/null | wc -l' | tr -d ' ')"
if [ "$pdfs" != 3 ]; then
  echo "expected 3 library files (original + 2 versions), found $pdfs"
  exit 1
fi
if [ "$(sh_app 'ls work/*.pdf 2>/dev/null | wc -l' | tr -d ' ')" != 0 ]; then
  echo "a working copy was left behind"
  exit 1
fi
signatures="$(sh_app 'ls signatures/*.png 2>/dev/null | wc -l' | tr -d ' ')"
if [ "$signatures" != 1 ]; then
  echo "expected 1 saved signature, found $signatures"
  exit 1
fi
newest="$(sh_app 'ls -t library/*.pdf | head -1')"
for needle in /AcroForm "Maria Papadopoulou" selis-sig- /Stamp; do
  if [ "$(sh_app "grep -c -a \"$needle\" $newest || true")" = 0 ]; then
    echo "$newest lacks $needle"
    exit 1
  fi
done
original="$(sha256sum "$fixtures/acroform.pdf" | cut -d' ' -f1)"
got="$(adb -s "$serial" shell sha256sum /sdcard/Download/selis-fixtures/acroform.pdf | cut -d' ' -f1 | tr -d '\r')"
if [ "$got" != "$original" ]; then
  echo "original acroform.pdf changed: $got != $original"
  exit 1
fi
echo "library: original + 2 versions ($newest: AcroForm, value, signature); 1 saved signature; original untouched"
