#!/usr/bin/env bash
# Usage: apps/app/e2e/maestro/release-suite.sh <serial>   (MAESTRO=… for the S23's patched copy)
# RC QA (docs/release/1.0-rc.md): the Tier 2 Maestro flows on a release build (`measure` feature: release profile, not
# debuggable, WebView readable over DevTools). run-as checks cannot run on a non-debuggable app:
# their POST_RUN hooks are skipped (listed debug-only in docs/release/1.0-rc.md); hooks without
# run-as run as in the debug suite. transfer-recover and transfer-background need debug.selis.*
# properties: debug-only.
set -u
serial="$1"
cd "$(dirname "$0")/../../../.."
export MSYS_NO_PATHCONV=1
M=apps/app/e2e/maestro
sum=".tmp/release-suite-$serial.txt"
: > "$sum"
run() { # name pre post flow
  local out; out="$(PRE_RUN="$2" POST_RUN="$3" $M/run.sh "$serial" "$M/$4" 2>&1 | tail -2 | head -1)"
  echo "$1: $out" | tee -a "$sum"
}
$M/push-fixtures.sh "$serial" > /dev/null 2>&1 || echo "push-fixtures FAILED" | tee -a "$sum"
run import-scroll-back "" "" import-scroll-back.yaml
run import-background-resume "" "" import-background-resume.yaml
run library-search-favorites "" "" library-search-favorites.yaml
run viewer-search "" "" viewer-search.yaml
run settings-theme "" "" settings-theme.yaml
run intent-cold "$M/open-with.sh cold" "$M/open-with.sh check" import-from-intent.yaml
run intent-warm "$M/open-with.sh warm" "$M/open-with.sh check" import-from-intent.yaml
run delete-rename "" "" delete-rename.yaml
run annotate "" "" annotate.yaml
run sign-forms "" "" sign-forms.yaml
run pages "" "" pages.yaml
run redact "" "" redact.yaml
run transfer "$M/transfer.sh pre" "$M/transfer.sh post-release" transfer.yaml
run pack "$M/pack.sh pre" "" pack.yaml
run tools "$M/tools.sh pre" "" tools.yaml
run images "$M/images.sh pre" "" images.yaml
run scan "$M/scan.sh pre" "" scan.yaml
run scan-auto "$M/scan.sh pre" "" scan-auto.yaml
run scan-batch "$M/scan.sh pre-batch" "" scan-batch.yaml
run scan-idcard "$M/scan.sh pre" "" scan-idcard.yaml
run ocr "$M/ocr.sh pre" "$M/ocr.sh check-release" ocr.yaml
echo "suite done" | tee -a "$sum"
