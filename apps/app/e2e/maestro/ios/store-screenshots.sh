#!/usr/bin/env bash
# App Store screenshots on one iOS simulator (P5b, ADR 0029). macOS only (CI:
# .github/workflows/ios-screenshots.yml).
#
#   apps/app/e2e/maestro/ios/store-screenshots.sh <app-path> <device-type-regex> <slug> en|el
#
# - Creates and boots a simulator of the newest runtime and the first device type matching the
#   regex (e.g. "^iPhone 17 Pro Max$"), light appearance, a clean status bar (9:41, full battery).
# - The four invented sample PDFs (packages/fixtures/src/samples.ts) go into Files › On My
#   iPhone/iPad, the scan sample photo (docs/store/scan-sample/<lang>.jpg) into Photos.
# - Labels of the target language come from apps/app/src/i18n/<lang>.json (wrapper flow env).
# - Output: fastlane/screenshots/<locale>/<slug>-{1-library,…,7-scan}.jpg, JPEG without alpha
#   (App Store Connect rejects alpha), at the device's native resolution.
set -euo pipefail
app="${1:?usage: store-screenshots.sh <app> <device-type-regex> <slug> en|el}"
type_re="${2:?device type regex}"
slug="${3:?slug}"
lang="${4:?en|el}"
case "$lang" in en) locale=en-US ;; el) locale=el ;; *) echo "lang must be en or el" >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../../.." && pwd)"
work="$root/.tmp/ios-shots/$slug-$lang"
rm -rf "$work"
mkdir -p "$work"

type_id="$(xcrun simctl list devicetypes -j | node -e '
  const re = new RegExp(process.argv[1]);
  const t = JSON.parse(require("fs").readFileSync(0, "utf8")).devicetypes.find((d) => re.test(d.name));
  if (!t) { console.error("no device type matches " + re); process.exit(1); }
  console.log(t.identifier);' "$type_re")"
runtime="$(xcrun simctl list runtimes -j | node -e '
  const rs = JSON.parse(require("fs").readFileSync(0, "utf8")).runtimes.filter((r) => r.isAvailable && r.platform === "iOS");
  rs.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  console.log(rs.at(-1).identifier);')"
udid="$(xcrun simctl create "selis-$slug-$lang" "$type_id" "$runtime")"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    # What the screen showed when it failed, and Maestro's own logs, for the artifact.
    xcrun simctl io "$udid" screenshot "$work/failed.png" >/dev/null 2>&1 || true
    "${MAESTRO:-maestro}" --device "$udid" hierarchy > "$work/failed-hierarchy.json" 2>/dev/null || true
    cp -R "$HOME/.maestro/tests" "$work/maestro-tests" 2>/dev/null || true
  fi
  xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
  xcrun simctl delete "$udid" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b >/dev/null
xcrun simctl ui "$udid" appearance light
xcrun simctl status_bar "$udid" override --time "9:41" --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100

# Samples into Files › On My iPhone/iPad (the Files app's local storage group).
(cd "$root" && npm run --silent samples -w @selis/fixtures > /dev/null)
xcrun simctl launch "$udid" com.apple.DocumentsApp >/dev/null 2>&1 || true
sleep 5
xcrun simctl terminate "$udid" com.apple.DocumentsApp >/dev/null 2>&1 || true
group=group.com.apple.FileProvider.LocalStorage
root_dir="$(xcrun simctl get_app_container "$udid" com.apple.DocumentsApp groups 2>/dev/null | awk -v g="$group" '$1 == g { print $2 }' || true)"
if [ -z "$root_dir" ]; then
  # Fallback: the app group's container is the one whose metadata names the group.
  for d in "$HOME/Library/Developer/CoreSimulator/Devices/$udid/data/Containers/Shared/AppGroup"/*/; do
    if grep -qa "$group" "$d.com.apple.mobile_container_manager.metadata.plist" 2>/dev/null; then root_dir="${d%/}"; break; fi
  done
fi
[ -n "$root_dir" ] || { echo "no Files local storage container ($group)" >&2; exit 1; }
files="$root_dir/File Provider Storage"
mkdir -p "$files"
echo "samples → $files"
cp "$root/packages/fixtures/out/samples/$lang/"*.pdf "$files/"
xcrun simctl addmedia "$udid" "$root/docs/store/scan-sample/$lang.jpg"
xcrun simctl install "$udid" "$app"

node --input-type=module - "$root" "$lang" "$here/store-screenshots.yaml" > "$work/flow.yaml" <<'EOF'
import { readFileSync } from "node:fs";
import { join } from "node:path";
const [root, lang, flow] = process.argv.slice(2);
const strings = (l) => JSON.parse(readFileSync(join(root, "apps/app/src/i18n", `${l}.json`), "utf8"));
const tr = (json) => (key, vars = {}) => {
  const value = key.split(".").reduce((o, k) => o?.[k], json);
  if (typeof value !== "string") throw new Error(`missing i18n key ${key}`);
  return value.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
};
const t = tr(strings(lang));
const en = tr(strings("en"));
const { samples } = await import(`file://${join(root, "packages/fixtures/src/samples.ts")}`);
const [lease, trip, invoice, report] = samples(lang);
// A file in the Files grid is a cell whose id is "<name without extension>, pdf" (its label
// below is not tappable).
const file = (s) => `${s.file.replace(/\.pdf$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, pdf`;
const open = (title) => `${t("library.openDocument", { title }).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},.*`;
// iPad picker: the Files grid (3 per row) sorts names in the device language; cell centres.
const cells = ["51%, 35%", "66%, 35%", "80%, 35%", "51%, 50%"];
const order = [lease, trip, invoice, report].map((s) => s.file.replace(/\.pdf$/, "")).sort((a, b) => a.localeCompare(b, lang));
const at = (s) => cells[order.indexOf(s.file.replace(/\.pdf$/, ""))];
const env = {
  LANG: lang,
  E_EMPTY: en("library.emptyTitle"),
  E_SETTINGS: en("tabs.settings"),
  E_LANGUAGE: `${en("settings.language")}.*`,
  S_LEASE: file(lease), S_TRIP: file(trip), S_INVOICE: file(invoice), S_REPORT: file(report),
  P_LEASE: at(lease), P_TRIP: at(trip), P_INVOICE: at(invoice), P_REPORT: at(report),
  T_IMPORT: t("library.import"),
  T_LIBRARY: t("tabs.library"),
  T_TRANSFER: t("tabs.transfer"),
  T_BACK: t("viewer.back"),
  // Titles here come from the file names (the picker hands over a copy named like the file).
  T_OPEN_LEASE: open(lease.file.replace(/\.pdf$/, "")),
  T_OPEN_TRIP: open(trip.file.replace(/\.pdf$/, "")),
  T_OPEN_REPORT: open(report.file.replace(/\.pdf$/, "")),
  // VoiceOver joins the header's lines ("Page 1 of 2 · saved"): match inside.
  T_PAGE_1: `.*${t("viewer.pageIndicator", { page: "1", total: "1" })}.*`,
  T_PAGE_1_OF_2: `.*${t("viewer.pageIndicator", { page: "1", total: "2" })}.*`,
  T_ANNOTATE: t("viewer.dockAnnotate"),
  T_DONE: t("annotate.done"),
  T_SIGN: t("viewer.dockSign"),
  T_NEW: t("sign.new"),
  T_MODE_TYPE: t("sign.modeType"),
  T_NAME_LABEL: t("sign.nameLabel"),
  T_CANCEL: t("sign.cancel"),
  T_CLOSE_SIGNING: t("sign.close"),
  T_TAB_SEND: t("transfer.tabSend"),
  T_SELECT_ALL: t("transfer.send.selectAll"),
  T_SEND_ALL: t("transfer.send.startWith", { summary: ".*" }),
  T_EXPIRES: t("transfer.send.expiresIn", { time: ".*" }),
  T_MORE: t("viewer.more"),
  T_TOOLS: t("tools.open"),
  T_PROTECT: t("tools.protect"),
  T_SCAN: t("scan.open"),
  T_FROM_PHOTO: t("scan.fromPhoto"),
  T_ADJUST: t("scan.adjustTitle"),
  SIGNER: lang === "el" ? "Δανιήλ Ρήγας" : "Daniel Reyes",
  // The first photo in PHPicker (iPhone: full-screen grid; iPad: the sheet's grid).
  PHOTO_POINT: process.env.PHOTO_POINT || "17%, 24%",
};
console.log("appId: com.anywecon.selis");
console.log("env:");
for (const [k, v] of Object.entries(env)) console.log(`  ${k}: ${JSON.stringify(v)}`);
console.log("---");
console.log(`- runFlow: ${JSON.stringify(flow)}`);
EOF

# takeScreenshot files land in the working directory or the debug output, by Maestro version.
(cd "$work" && "${MAESTRO:-maestro}" --device "$udid" test --debug-output "$work/debug" "$work/flow.yaml")

out="$root/fastlane/screenshots/$locale"
mkdir -p "$out"
count=0
while IFS= read -r png; do
  name="$(basename "$png" .png)"
  # JPEG: no alpha channel (App Store Connect rejects it), native pixels kept.
  sips -s format jpeg -s formatOptions 92 "$png" --out "$out/$slug-$name.jpg" >/dev/null
  sips -g pixelWidth -g pixelHeight "$out/$slug-$name.jpg" | tail -2 | tr -s ' ' | tr '\n' ' '
  echo "→ $out/$slug-$name.jpg"
  count=$((count + 1))
done < <(find "$work" -name '[0-9]-*.png' | awk -F/ '!seen[$NF]++' | sort)
[ "$count" -eq 7 ] || { echo "expected 7 screenshots, got $count (see $work/debug)" >&2; exit 1; }
