#!/usr/bin/env bash
# App Store screenshots on one iOS simulator (P5b, ADR 0029). macOS only (CI:
# .github/workflows/ios-screenshots.yml).
#
#   apps/app/e2e/maestro/ios/store-screenshots.sh <app-path> <device-type-regex> <slug> en
#
# Store images are English-only (docs/store/ios-release.md): the Greek localization uses the
# primary (en-US) screenshot set, so there are no Greek App Store screenshots.
#
# - Creates and boots a simulator of the newest runtime and the first device type matching the
#   regex (e.g. "^iPhone 17 Pro Max$"), light appearance, a clean status bar (9:41, full battery).
# - The four invented sample PDFs (packages/fixtures/src/samples.ts) go into Files › On My
#   iPhone/iPad, the scan sample photo (docs/store/scan-sample/<lang>.jpg) into Photos.
# - Labels of the target language come from apps/app/src/i18n/<lang>.json (wrapper flow env).
# - Output: fastlane/screenshots/<locale>/<slug>-{1-library,…,7-scan}.jpg, JPEG without alpha
#   (App Store Connect rejects alpha), at the device's native resolution.
set -euo pipefail
app="${1:?usage: store-screenshots.sh <app> <device-type-regex> <slug> en}"
type_re="${2:?device type regex}"
slug="${3:?slug}"
lang="${4:?en}"
case "$lang" in en) locale=en-US ;; *) echo "store screenshots are English-only: lang must be en" >&2; exit 2 ;; esac

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

# The scan sample photo into Photos.
xcrun simctl addmedia "$udid" "$root/docs/store/scan-sample/$lang.jpg"
xcrun simctl install "$udid" "$app"

# The four samples, seeded into the app's library (crates/selis-core/examples/seed-library.rs, the
# app's own import path: titles from the file names). The Files picker runs out of process and did
# not take synthesized taps reliably on CI. A first launch creates the library; its root is where
# selis.db appears in the app's data container.
(cd "$root" && npm run --silent samples -w @selis/fixtures > /dev/null)
seeder="${SEEDER:-$root/target/release/examples/seed-library}"
[ -x "$seeder" ] || { echo "no seeder at $seeder (cargo build --release -p selis-core --example seed-library)" >&2; exit 1; }
xcrun simctl launch "$udid" com.anywecon.selis > /dev/null
data="$(xcrun simctl get_app_container "$udid" com.anywecon.selis data)"
db=""
for _ in $(seq 1 60); do
  db="$(find "$data" -name selis.db -not -path '*/tmp/*' 2>/dev/null | head -1)"
  [ -n "$db" ] && break
  sleep 1
done
[ -n "$db" ] || { echo "the app made no library in $data" >&2; exit 1; }
xcrun simctl terminate "$udid" com.anywecon.selis > /dev/null
sleep 1
# The order the library shows them in (newest first): lease, report, invoice, trip.
order="$(cd "$root" && node --input-type=module -e '
  const { samples } = await import("file://" + process.cwd() + "/packages/fixtures/src/samples.ts");
  const [lease, trip, invoice, report] = samples(process.argv[1]);
  for (const s of [trip, invoice, report, lease]) console.log(s.file);' "$lang")"
pdfs=()
while IFS= read -r name; do pdfs+=("$root/packages/fixtures/out/samples/$lang/$name"); done <<< "$order"
"$seeder" "$(dirname "$db")" "${pdfs[@]}"


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
const open = (title) => `${t("library.openDocument", { title }).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},.*`;
const env = {
  LANG: lang,
  E_SETTINGS: en("tabs.settings"),
  E_LANGUAGE: `${en("settings.language")}.*`,
  T_LIBRARY: t("tabs.library"),
  T_TRANSFER: t("tabs.transfer"),
  T_BACK: t("viewer.back"),
  T_RENAME: t("library.rename"),
  // Titles here come from the file names (the seeder imports like a picked file).
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
  T_NEW_TITLE: t("sign.newTitle"),
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
  SIGNER: "Daniel Reyes",
  // The first photo in PHPicker (iPhone: full-screen grid; iPad: the sheet's grid).
  PHOTO_POINT: process.env.PHOTO_POINT || "17%, 24%",
  // The ✓ of PHPicker's photo preview.
  PHOTO_CONFIRM: process.env.PHOTO_CONFIRM || "90%, 12%",
  // iPad only: the software keyboard's hide key (bottom right).
  KEYBOARD_HIDE: process.env.KEYBOARD_HIDE || "",
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
