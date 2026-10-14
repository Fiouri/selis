#!/usr/bin/env bash
# Hooks for tools.yaml (run.sh PRE_RUN / POST_RUN), P4a (ADR 0015).
#
#   PRE_RUN="apps/app/e2e/maestro/tools.sh pre" POST_RUN="apps/app/e2e/maestro/tools.sh check" \
#     apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/tools.yaml
#
# pre:   clear Selis, start sampling the app's RSS (dumpsys meminfo, ~1/s).
# check: stop sampling and print the RSS around the compress of the 1000-page fixture; pull
#        every library file: each passes `qpdf --check` and opens in pdf.js (tools-check.ts, the
#        protected one with its password); every 2-page file has the same page content streams
#        (BLAKE3) as greek.pdf; the 1000-page document got a new version; nothing is left in
#        the work folder.
# Needs a debuggable build (run-as), qpdf on the host, ./push-fixtures.sh <serial>.
set -euo pipefail
mode="${1:?usage: tools.sh pre|check <serial>}"
serial="${2:?usage: tools.sh pre|check <serial>}"
export MSYS_NO_PATHCONV=1

app=com.anywecon.selis
password="correct horse"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
state="$root/.tmp/maestro-tools/$serial"
sh_app() { adb -s "$serial" shell run-as "$app" sh -c "'$1'" | tr -d '\r'; }
win() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
pdfops() { (cd "$root" && cargo run -q --release -p selis-pdfops --example pdfops -- "$@"); }

case "$mode" in
  pre)
    mkdir -p "$state"
    [ -f "$state/sampler.pid" ] && kill "$(cat "$state/sampler.pid")" 2>/dev/null || true
    adb -s "$serial" shell pm clear "$app" >/dev/null
    : > "$state/rss.log"
    # At most 15 minutes: POST_RUN (which stops it) does not run after a failed flow.
    (
      end=$((SECONDS + 900))
      while [ "$SECONDS" -lt "$end" ]; do
        kb="$(adb -s "$serial" shell dumpsys meminfo "$app" 2>/dev/null | tr -d '\r' | sed -n 's/.*TOTAL RSS:[[:space:]]*\([0-9]*\).*/\1/p' | head -1)"
        [ -n "$kb" ] && echo "$(date +%s%3N) $kb" >> "$state/rss.log"
        sleep 0.5
      done
    ) &
    echo $! > "$state/sampler.pid"
    # Built now, not inside the check (the release example takes a while the first time).
    pdfops 2>/dev/null || true
    ;;
  check)
    [ -f "$state/sampler.pid" ] && kill "$(cat "$state/sampler.pid")" 2>/dev/null || true
    rm -f "$state/sampler.pid"
    status=0
    (cd "$here" && node tools-rss.ts "$(win "$state/rss.log")" "$(win "$root/.tmp/maestro/.maestro/tests")") || status=1
    rm -rf "$state/files"
    mkdir -p "$state/files"
    for f in $(sh_app 'ls library/' | grep '\.pdf$'); do
      adb -s "$serial" exec-out run-as "$app" cat "library/$f" > "$state/files/$f"
    done
    (cd "$here" && node tools-check.ts "$(win "$state/files")" "$password") || status=1
    want="$(pdfops contents "$(win "$root/packages/fixtures/out/greek.pdf")" | tr -d '\r')"
    two_page=0
    large=0
    for f in "$state"/files/*.pdf; do
      kind="$(pdfops protection "$(win "$f")" | tr -d '\r')"
      if [ "$kind" = password ]; then
        got="$(pdfops contents "$(win "$f")" "$password" | tr -d '\r')"
      else
        got="$(pdfops contents "$(win "$f")" | tr -d '\r')"
      fi
      pages="$(printf '%s\n' "$got" | grep -c .)"
      if [ "$pages" = 2 ]; then
        two_page=$((two_page + 1))
        [ "$got" = "$want" ] || { echo "$(basename "$f"): page contents differ from greek.pdf"; status=1; }
      elif [ "$pages" = 1000 ]; then
        large=$((large + 1))
      fi
    done
    # greek: original, protected, unprotected; large-1000: original + at least one tool version.
    [ "$two_page" = 3 ] || { echo "expected 3 versions of greek.pdf, found $two_page"; status=1; }
    [ "$large" -ge 2 ] || { echo "expected the 1000-page document to have a new version, found $large file(s)"; status=1; }
    left="$(sh_app 'ls work 2>/dev/null' | grep -c '\.pdf$' || true)"
    [ "$left" = 0 ] || { echo "work folder still holds $left file(s)"; status=1; }
    [ "$status" = 0 ] && echo "tools: every output passes qpdf --check and pdf.js, page contents kept, nothing left"
    exit "$status"
    ;;
  *)
    echo "unknown mode $mode"
    exit 2
    ;;
esac
