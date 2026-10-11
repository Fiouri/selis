#!/usr/bin/env bash
# Runs a Maestro flow N times on one device and fails a run if the app hit an ANR.
#
# Usage: apps/app/e2e/maestro/run.sh <serial> <flow.yaml> [runs=1]
#
# The emulator hides ANR dialogs (`settings put global hide_error_dialogs 1`), so a
# flow can pass while the app was "not responding". After every run logcat is
# checked for "ANR in <appId>" (appId from the flow) and the run fails if found.
# Logs per run (Maestro output + logcat) go to .tmp/maestro-runs/<flow>/<timestamp>/.
# Prerequisite: ./push-fixtures.sh <serial>, and the app installed.
#
# Optional hooks (e.g. open-with.sh): $PRE_RUN and $POST_RUN are run as
# "$PRE_RUN <serial>" before / after every run; a failing hook fails the run.
set -u

serial="${1:?usage: run.sh <serial> <flow.yaml> [runs]}"
flow="${2:?usage: run.sh <serial> <flow.yaml> [runs]}"
runs="${3:-1}"

root="$(cd "$(dirname "$0")/../../../.." && pwd)"
app_id="$(sed -n 's/^appId:[[:space:]]*//p' "$flow" | head -1 | tr -d '\r')"
[ -n "$app_id" ] || { echo "no appId in $flow" >&2; exit 2; }

# Scratch stays on the project drive (CLAUDE.md, "Windows dev notes").
tmp="$root/.tmp"
out="$tmp/maestro-runs/$(basename "$flow" .yaml)/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$out"
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) win_tmp="$(cygpath -w "$tmp")" ;;
  *) win_tmp="$tmp" ;;
esac
export TMP="$win_tmp" TEMP="$win_tmp" JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=$win_tmp" MSYS_NO_PATHCONV=1
maestro="${MAESTRO:-maestro}"

pass=0
fail=0
for i in $(seq 1 "$runs"); do
  adb -s "$serial" logcat -c
  if [ -n "${PRE_RUN:-}" ] && ! $PRE_RUN "$serial" > "$out/pre-$i.log" 2>&1; then
    result="FAIL (PRE_RUN: $(tail -1 "$out/pre-$i.log" | tr -d '\r'))"
  elif "$maestro" --device "$serial" test --debug-output "$tmp/maestro" "$flow" > "$out/run-$i.log" 2>&1; then
    result=pass
  else
    result="FAIL ($(grep -o 'Assert that "[^"]*"[^.]*... FAILED\|Tap on "[^"]*"... FAILED\|[A-Za-z ]*"[^"]*" is visible... FAILED' "$out/run-$i.log" | head -1))"
  fi
  if [ "$result" = pass ] && [ -n "${POST_RUN:-}" ] && ! $POST_RUN "$serial" > "$out/post-$i.log" 2>&1; then
    result="FAIL (POST_RUN: $(tail -1 "$out/post-$i.log" | tr -d '\r'))"
  fi
  # Maestro copies an APK (~0.8 GB) into TMP on every run and never deletes it:
  # left alone, a few hundred runs fill the drive.
  find "$tmp" -maxdepth 1 -name 'tmp*.apk' -type f -delete 2>/dev/null
  adb -s "$serial" logcat -d -v time > "$out/logcat-$i.txt"
  if grep -q "ANR in $app_id" "$out/logcat-$i.txt"; then
    result="FAIL (ANR: $(grep -m1 "ANR in $app_id" "$out/logcat-$i.txt" | tr -d '\r'))"
  fi
  if [ "$result" = pass ]; then pass=$((pass + 1)); else fail=$((fail + 1)); fi
  echo "run $i/$runs: $result"
done

echo "$(basename "$flow"): pass=$pass fail=$fail (logs: $out)"
[ "$fail" -eq 0 ]
