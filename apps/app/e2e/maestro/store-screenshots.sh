#!/usr/bin/env bash
# Store screenshots on the AVD (P5a, docs/store/store-screenshots.md): six key screens with the
# realistic sample documents, in one language and theme per call.
#
#   apps/app/e2e/maestro/store-screenshots.sh <serial> en|el light|dark
#
# - Generates and pushes the samples (packages/fixtures/src/samples.ts; invented content only).
# - Screen 1080×1920 (9:16; Play allows at most 2:1, the AVD's 1080×2340 is 2.17:1) and a clean
#   status bar (System UI demo mode: 10:00, full battery, Wi-Fi, no notifications); both are
#   restored on exit.
# - Labels of the target language come from apps/app/src/i18n/<lang>.json, so the flow taps the
#   same strings the user sees.
# - Output: docs/store/screenshots/<lang>/<theme>/{1-library,…,6-scan}.png; light also goes to
#   fastlane/metadata/android/<locale>/images/phoneScreenshots/ (what Play and F-Droid show).
# Prerequisite: a debug build of Selis installed (any build with devtools-readable WebView).
set -euo pipefail
serial="${1:?usage: store-screenshots.sh <serial> en|el light|dark}"
lang="${2:?usage: store-screenshots.sh <serial> en|el light|dark}"
theme="${3:?usage: store-screenshots.sh <serial> en|el light|dark}"
case "$lang" in en) locale=en-US ;; el) locale=el-GR ;; *) echo "lang must be en or el" >&2; exit 2 ;; esac
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

# Labels and positions for the flow (KEY=VALUE per line, run.sh MAESTRO_ENV_FILE).
node --input-type=module - "$root" "$lang" "$theme" "$(win "$work")" > "$work/env" <<'EOF'
import { readFileSync } from "node:fs";
import { join } from "node:path";
const [root, lang, theme, out] = process.argv.slice(2);
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
  OUT: out,
  S_LEASE: lease.file, S_TRIP: trip.file, S_INVOICE: invoice.file, S_REPORT: report.file,
  T_THEME: t(theme === "dark" ? "settings.themeDark" : "settings.themeLight"),
  T_LIBRARY: t("tabs.library"),
  T_TRANSFER: t("tabs.transfer"),
  T_OPEN_LEASE: t("library.openDocument", { title: lease.title }),
  T_OPEN_TRIP: t("library.openDocument", { title: trip.title }),
  T_OPEN_REPORT: t("library.openDocument", { title: report.title }),
  T_PAGE_1: t("viewer.pageIndicator", { page: "1", total: "1" }),
  T_ANNOTATE: t("viewer.dockAnnotate"),
  T_DONE: t("annotate.done"),
  T_PEN: t("annotate.toolPen"),
  T_SIGN: t("viewer.dockSign"),
  T_NEW: t("sign.new"),
  T_MODE_TYPE: t("sign.modeType"),
  T_NAME: t("sign.nameLabel"),
  T_SAVE: t("sign.save"),
  T_PLACE_HINT: t("sign.placeHint"),
  T_REMOVE: t("sign.remove"),
  T_TAB_SEND: t("transfer.tabSend"),
  T_SELECT_ALL: t("transfer.send.selectAll"),
  T_SEND_ALL: t("transfer.send.startWith", { summary: ".*" }),
  T_QR: t("transfer.send.qrAlt"),
  T_SCAN: t("scan.open"),
  T_SHUTTER: t("scan.shutter"),
  T_ADJUST: t("scan.adjustTitle"),
  // adb input types ASCII only; a signature in Latin letters is usual in Greece too.
  SIGNER: lang === "el" ? "D. Rigas" : "Daniel Reyes",
  // Screen positions on the 1080×1920 screen (page fitted to the width).
  Y_HIGHLIGHT: "24%",
  Y_PEN: "59%",
  SIGN_POINT: "72%, 70%",
};
for (const [k, v] of Object.entries(env)) console.log(`${k}=${v}`);
EOF

restore() {
  adb -s "$serial" shell wm size reset || true
  adb -s "$serial" shell am broadcast -a com.android.systemui.demo -e command exit > /dev/null || true
}
trap restore EXIT
adb -s "$serial" shell wm size 1080x1920
adb -s "$serial" shell settings put global sysui_demo_allowed 1
demo() { adb -s "$serial" shell am broadcast -a com.android.systemui.demo -e command "$@" > /dev/null; }
demo enter
demo clock -e hhmm 1000
demo battery -e level 100 -e plugged false
demo network -e wifi show -e level 4 -e mobile hide
demo notifications -e visible false

MAESTRO_ENV_FILE="$work/env" "$here/run.sh" "$serial" "$here/store-screenshots.yaml"

shots="$root/docs/store/screenshots/$lang/$theme"
mkdir -p "$shots"
cp "$work"/*.png "$shots/"
if [ "$theme" = light ]; then
  play="$root/fastlane/metadata/android/$locale/images/phoneScreenshots"
  rm -rf "$play"
  mkdir -p "$play"
  cp "$work"/*.png "$play/"
fi
echo "store screenshots $lang/$theme: $(ls "$work"/*.png | wc -l) → $shots"
