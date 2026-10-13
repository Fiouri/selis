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
#
# Disk guard: before every run, the drives holding .tmp and the AVDs
# ($ANDROID_AVD_HOME, default ~/.android/avd) must have at least $MIN_FREE_GB
# (default 30) GB free, or the script stops (exit 3) before Maestro or the
# emulator can fill the drive.
#
# APK guard: Maestro copies its driver APKs (maestro-app*.apk, maestro-server*.apk)
# and the app (tmp*.apk) into the temp dir on every run and never deletes them;
# 1,800 such copies (34 GB) piled up by P3. Each run.sh gets its own temp dir under
# .tmp/maestro-tmp/ (so parallel runs on two devices never delete each other's
# files), emptied after every run and removed on exit. Before every run, dirs of
# run.sh processes that are gone are removed, and the script stops (exit 3) if any
# *.apk older than this run is still in .tmp or .tmp/maestro-tmp. Run logs and
# Maestro debug output older than 7 days are pruned at start.
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
# Marks the start of this script: an APK not newer than it was left by an earlier run.
started="$out/.started"
touch "$started"
run_tmp="$tmp/maestro-tmp/$$"
mkdir -p "$run_tmp"
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) win_tmp="$(cygpath -w "$run_tmp")" ;;
  *) win_tmp="$run_tmp" ;;
esac
export TMP="$win_tmp" TEMP="$win_tmp" JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=$win_tmp" MSYS_NO_PATHCONV=1
maestro="${MAESTRO:-maestro}"

min_free_gb="${MIN_FREE_GB:-30}"
avd_dir="${ANDROID_AVD_HOME:-$HOME/.android/avd}"
# Prints why and fails when a drive is short of space. Junctions (e.g. the AVD
# folder moved to another drive) are followed to the drive that really fills up.
check_disk() {
  local dir real free_kb
  for dir in "$tmp" "$avd_dir"; do
    [ -d "$dir" ] || continue
    real="$(readlink -f "$dir" 2>/dev/null || echo "$dir")"
    free_kb="$(df -Pk "$real" 2>/dev/null | awk 'NR == 2 { print $4 }')"
    [ -n "$free_kb" ] || continue
    if [ "$free_kb" -lt $((min_free_gb * 1024 * 1024)) ]; then
      echo "ABORT: only $((free_kb / 1024 / 1024)) GB free on the drive holding $real (needs >= $min_free_gb GB)." >&2
      echo "Free space first (old .tmp/maestro-runs, .tmp/maestro, emulator snapshots), then rerun." >&2
      return 1
    fi
  done
}

# Prunes run logs and Maestro debug output older than 7 days.
prune_old() {
  if [ -d "$tmp/maestro-runs" ]; then
    find "$tmp/maestro-runs" -mindepth 2 -maxdepth 2 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null
    find "$tmp/maestro-runs" -mindepth 1 -maxdepth 1 -type d -empty -delete 2>/dev/null
  fi
  # --debug-output .tmp/maestro: Maestro writes .maestro/tests/<timestamp>/.
  if [ -d "$tmp/maestro/.maestro/tests" ]; then
    find "$tmp/maestro/.maestro/tests" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null
  fi
}

# Removes the temp dirs of run.sh processes that are gone (killed before their
# exit trap), then fails if an APK older than this run is still around: in .tmp
# itself (Maestro run without run.sh) or in a live run's dir (it should have
# emptied it after its run).
check_apks() {
  local dir pid stale
  for dir in "$tmp"/maestro-tmp/*/; do
    [ -d "$dir" ] || continue
    pid="$(basename "$dir")"
    [ "$pid" = "$$" ] && continue
    kill -0 "$pid" 2>/dev/null || rm -rf "$dir"
  done
  stale="$({
    find "$tmp" -maxdepth 1 -name '*.apk' -type f ! -newer "$started"
    find "$tmp/maestro-tmp" -mindepth 2 -maxdepth 2 -name '*.apk' -type f ! -newer "$started"
  } 2>/dev/null)"
  [ -z "$stale" ] && return 0
  echo "ABORT: APKs left over from an earlier run ($(echo "$stale" | wc -l) files, e.g. $(echo "$stale" | head -1))." >&2
  echo "Delete them (rm .tmp/*.apk .tmp/maestro-tmp/*/*.apk), then rerun." >&2
  return 1
}

# Maestro's copies of its driver and the app (~0.8 GB) from this script's runs.
clean_apks() {
  find "$run_tmp" -mindepth 1 -delete 2>/dev/null
}

prune_old

# Animations off for the runs (restored on exit): Chrome WebView then reports
# prefers-reduced-motion and the app's sheets appear at once. With them on,
# Maestro can read a sheet's rows mid-slide and tap a row lower (seen on the S23).
scales="window_animation_scale transition_animation_scale animator_duration_scale"
declare -A saved_scale
for key in $scales; do
  saved_scale[$key]="$(adb -s "$serial" shell settings get global "$key" | tr -d '\r')"
  adb -s "$serial" shell settings put global "$key" 0
done
restore_scales() {
  for key in $scales; do
    value="${saved_scale[$key]}"
    if [ -z "$value" ] || [ "$value" = null ]; then
      adb -s "$serial" shell settings delete global "$key" > /dev/null
    else
      adb -s "$serial" shell settings put global "$key" "$value"
    fi
  done
}
cleanup() {
  restore_scales
  rm -rf "$run_tmp"
}
trap cleanup EXIT

pass=0
fail=0
for i in $(seq 1 "$runs"); do
  if ! check_disk || ! check_apks; then
    echo "$(basename "$flow"): stopped before run $i/$runs, pass=$pass fail=$fail (disk guard)"
    exit 3
  fi
  adb -s "$serial" logcat -c
  if [ -n "${PRE_RUN:-}" ] && ! $PRE_RUN "$serial" > "$out/pre-$i.log" 2>&1; then
    result="FAIL (PRE_RUN: $(tail -1 "$out/pre-$i.log" | tr -d '\r'))"
  elif "$maestro" --device "$serial" test --debug-output "$tmp/maestro" "$flow" > "$out/run-$i.log" 2>&1; then
    result=pass
  else
    # First failing step; Maestro colours its output, so strip the ANSI codes first.
    result="FAIL ($(sed 's/\x1b\[[0-9;]*m//g' "$out/run-$i.log" | grep -m1 'FAILED' | tr -d '\r'))"
  fi
  if [ "$result" = pass ] && [ -n "${POST_RUN:-}" ] && ! $POST_RUN "$serial" > "$out/post-$i.log" 2>&1; then
    result="FAIL (POST_RUN: $(tail -1 "$out/post-$i.log" | tr -d '\r'))"
  fi
  # Maestro never deletes its APK copies: left alone, a few hundred runs fill the drive.
  clean_apks
  adb -s "$serial" logcat -d -v time > "$out/logcat-$i.txt"
  if grep -q "ANR in $app_id" "$out/logcat-$i.txt"; then
    result="FAIL (ANR: $(grep -m1 "ANR in $app_id" "$out/logcat-$i.txt" | tr -d '\r'))"
  fi
  if [ "$result" = pass ]; then pass=$((pass + 1)); else fail=$((fail + 1)); fi
  echo "run $i/$runs: $result"
done

echo "$(basename "$flow"): pass=$pass fail=$fail (logs: $out)"
[ "$fail" -eq 0 ]
