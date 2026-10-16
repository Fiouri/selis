#!/usr/bin/env bash
# Store screenshots on the AVD (P5a, ADR 0024): six key screens with the
# realistic sample documents, in one theme per call.
#
#   apps/app/e2e/maestro/store-screenshots.sh <serial> en light|dark
#
# Store images are English-only (docs/store/play-console.md): Play and F-Droid show the en-US set
# for every listing language, so there are no Greek store screenshots (Greek UI pictures exist for
# tests only: the Playwright visual snapshots). CI fails on any other locale's images
# (scripts/check-store-images.sh).
#
# - Generates and pushes the samples (packages/fixtures/src/samples.ts; invented content only).
# - Screen 1080×1920 (9:16; Play allows at most 2:1, the AVD's 1080×2340 is 2.17:1) and a clean
#   status bar (System UI demo mode: 10:00, full battery, Wi-Fi, no notifications); both are
#   restored on exit.
# - Labels of the target language come from apps/app/src/i18n/<lang>.json, so the flow taps the
#   same strings the user sees.
# - Output: light → fastlane/metadata/android/en-US/images/phoneScreenshots/ (what Play and
#   F-Droid show), dark → docs/store/screenshots/en/dark/; {1-library,…,6-tools,7-scan}.png.
# Prerequisite: a release build with the `measure` feature installed (WebView readable through
# DevTools for Maestro, none of the debug-only UI of a debug build in the pictures):
#   npm run tauri -- android build --apk --target x86_64 --features measure, debug-signed.
set -euo pipefail
serial="${1:?usage: store-screenshots.sh <serial> en light|dark}"
lang="${2:?usage: store-screenshots.sh <serial> en light|dark}"
theme="${3:?usage: store-screenshots.sh <serial> en light|dark}"
case "$lang" in en) locale=en-US ;; *) echo "store screenshots are English-only: lang must be en" >&2; exit 2 ;; esac
case "$theme" in light | dark) ;; *) echo "theme must be light or dark" >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
export MSYS_NO_PATHCONV=1
win() { cygpath -m "$1" 2>/dev/null || echo "$1"; }

work="$root/.tmp/store-shots/$lang-$theme"
rm -rf "$work"
mkdir -p "$work"

# Samples → /sdcard/Download/selis-samples/<lang>/, media-scanned for the picker.
(cd "$root" && npm run --silent samples -w @selis/fixtures > /dev/null)
samples="$root/packages/fixtures/out/samples/$lang"
adb -s "$serial" shell mkdir -p "/sdcard/Download/selis-samples/$lang"
for f in "$samples"/*.pdf; do
  name="$(basename "$f")"
  adb -s "$serial" push "$(win "$f")" "/sdcard/Download/selis-samples/$lang/$name" > /dev/null
  adb -s "$serial" shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
    -d "\"file:///sdcard/Download/selis-samples/$lang/$name\"" > /dev/null
done

# The flow's parameters go into a small UTF-8 wrapper flow (an `env:` block, then runFlow):
# Greek labels passed as `maestro -e` arguments lose their characters on Windows.
node --input-type=module - "$(win "$root")" "$lang" "$theme" "$(win "$here/store-screenshots.yaml")" > "$work/store-screenshots-$lang-$theme.yaml" <<'EOF'
import { readFileSync } from "node:fs";
import { join } from "node:path";
const [root, lang, theme, flow] = process.argv.slice(2);
const json = JSON.parse(readFileSync(join(root, "apps/app/src/i18n", `${lang}.json`), "utf8"));
const t = (key, vars = {}) => {
  const value = key.split(".").reduce((o, k) => o?.[k], json);
  if (typeof value !== "string") throw new Error(`missing i18n key ${key}`);
  return value.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
};
const { samples } = await import(`file://${join(root, "packages/fixtures/src/samples.ts").replace(/\\/g, "/")}`);
const [lease, trip, invoice, report] = samples(lang);
const env = {
  LANG: lang,
  S_LEASE: lease.file, S_TRIP: trip.file, S_INVOICE: invoice.file, S_REPORT: report.file,
  T_THEME: t(theme === "dark" ? "settings.themeDark" : "settings.themeLight"),
  T_LIBRARY: t("tabs.library"),
  T_TRANSFER: t("tabs.transfer"),
  T_OPEN_LEASE: `${t("library.openDocument", { title: lease.title })},.*`,
  T_OPEN_TRIP: `${t("library.openDocument", { title: trip.title })},.*`,
  T_OPEN_REPORT: `${t("library.openDocument", { title: report.title })},.*`,
  T_PAGE_1: t("viewer.pageIndicator", { page: "1", total: "1" }),
  T_PAGE_1_OF_2: t("viewer.pageIndicator", { page: "1", total: "2" }),
  T_PAGE_2_OF_2: t("viewer.pageIndicator", { page: "2", total: "2" }),
  T_ANNOTATE: t("viewer.dockAnnotate"),
  T_DONE: t("annotate.done"),
  T_PEN: t("annotate.toolPen"),
  T_SIGN: t("viewer.dockSign"),
  T_NEW: t("sign.new"),
  T_MODE_TYPE: t("sign.modeType"),
  T_SAVE: t("sign.save"),
  T_PLACE_HINT: t("sign.placeHint"),
  T_REMOVE: t("sign.remove"),
  T_TAB_SEND: t("transfer.tabSend"),
  T_SELECT_ALL: t("transfer.send.selectAll"),
  T_SEND_ALL: t("transfer.send.startWith", { summary: ".*" }),
  T_EXPIRES: t("transfer.send.expiresIn", { time: ".*" }),
  T_MORE: t("viewer.more"),
  T_SCAN: t("scan.open"),
  T_FROM_PHOTO: t("scan.fromPhoto"),
  T_ADJUST: t("scan.adjustTitle"),
  SIGNER: "Daniel Reyes",
};
console.log("appId: com.anywecon.selis");
console.log("androidWebViewHierarchy: devtools");
console.log("env:");
for (const [k, v] of Object.entries(env)) console.log(`  ${k}: ${JSON.stringify(v)}`);
console.log("---");
console.log(`- runFlow: ${JSON.stringify(flow)}`);
EOF

restore() {
  adb -s "$serial" shell wm size reset || true
  adb -s "$serial" shell am broadcast -a com.android.systemui.demo -e command exit > /dev/null || true
  adb -s "$serial" shell rm -f /sdcard/Pictures/selis-scan-sample-$lang.jpg > /dev/null || true
  adb -s "$serial" shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/selis-scan-sample-$lang.jpg > /dev/null || true
  # The samples must not stay in the picker's Recent list: the other flows pick fixtures by name.
  for f in "$samples"/*.pdf; do
    name="$(basename "$f")"
    adb -s "$serial" shell rm -f "\"/sdcard/Download/selis-samples/$lang/$name\"" > /dev/null || true
    adb -s "$serial" shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE       -d "\"file:///sdcard/Download/selis-samples/$lang/$name\"" > /dev/null || true
  done
}
trap restore EXIT
# The photo for "Scan a photo" (tools/store/scan-sample.ts), the newest in the photo picker.
adb -s "$serial" push "$(win "$root/docs/store/scan-sample/$lang.jpg")" /sdcard/Pictures/selis-scan-sample-$lang.jpg > /dev/null
adb -s "$serial" shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/selis-scan-sample-$lang.jpg > /dev/null
adb -s "$serial" shell wm size 1080x1920
adb -s "$serial" shell settings put global sysui_demo_allowed 1
demo() { adb -s "$serial" shell am broadcast -a com.android.systemui.demo -e command "$@" > /dev/null; }
demo enter
demo clock -e hhmm 1000
demo battery -e level 100 -e plugged false
demo network -e wifi show -e level 4 -e mobile hide
demo notifications -e visible false

"$here/run.sh" "$serial" "$work/store-screenshots-$lang-$theme.yaml"
# Maestro writes takeScreenshot files into its debug output (run.sh: .tmp/maestro), one
# folder per run; take this run's.
latest="$(ls -td "$root"/.tmp/maestro/.maestro/tests/*/ | head -1)"
find "$latest" -path '*takeScreenshot/*.png' -exec cp {} "$work/" \;
[ "$(ls "$work"/*.png | wc -l)" -eq 7 ] || { echo "expected 7 screenshots in $latest" >&2; exit 1; }

if [ "$theme" = light ]; then
  shots="$root/fastlane/metadata/android/$locale/images/phoneScreenshots"
else
  shots="$root/docs/store/screenshots/$lang/$theme"
fi
rm -rf "$shots"
mkdir -p "$shots"
cp "$work"/*.png "$shots/"
echo "store screenshots $lang/$theme: $(ls "$work"/*.png | wc -l) → $shots"
