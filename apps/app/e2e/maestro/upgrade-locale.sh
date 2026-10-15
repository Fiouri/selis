#!/usr/bin/env bash
# Hooks for upgrade-locale.yaml (ADR 0030): an install from before English first, with the
# language on "Same as the device" on a Greek-locale device, is updated to this build and must
# open in English.
#
#   OLD_APK=<previous build, schema 6> NEW_APK=<this build> \
#   PRE_RUN="apps/app/e2e/maestro/upgrade-locale.sh pre" \
#   POST_RUN="apps/app/e2e/maestro/upgrade-locale.sh post" \
#     apps/app/e2e/maestro/run.sh <serial> apps/app/e2e/maestro/upgrade-locale.yaml
#
# pre:  uninstall Selis, install OLD_APK, Greek as the app's locale (per-app language, Android
#       13+: the device language is not touched), then upgrade-locale-old.yaml picks "Same as
#       the device" (the UI turns Greek), and NEW_APK is installed over it (data kept).
# post: the database (run-as, debug build) is at schema 7, its schema-6 backup held "system",
#       now "en"; the app's locale is reset.
# Both APKs must be debuggable (run-as) and signed with the same key (debug builds are).
set -euo pipefail
mode="${1:?usage: upgrade-locale.sh pre|post <serial>}"
serial="${2:?usage: upgrade-locale.sh pre|post <serial>}"
export MSYS_NO_PATHCONV=1

app=com.anywecon.selis
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
win() { case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) cygpath -m "$1" ;; *) echo "$1" ;; esac; }

case "$mode" in
  pre)
    old="${OLD_APK:?OLD_APK: the previous build}"
    new="${NEW_APK:?NEW_APK: this build}"
    adb -s "$serial" uninstall "$app" > /dev/null 2>&1 || true
    adb -s "$serial" install "$(win "$old")" > /dev/null
    adb -s "$serial" shell cmd locale set-app-locales "$app" --locales el-GR
    "${MAESTRO:-maestro}" --device "$serial" test --debug-output "$(win "$root/.tmp/maestro")" \
      "$(win "$here/upgrade-locale-old.yaml")"
    adb -s "$serial" shell am force-stop "$app"
    adb -s "$serial" install -r "$(win "$new")" > /dev/null
    locales="$(adb -s "$serial" shell cmd locale get-app-locales "$app" | tr -d '\r')"
    case "$locales" in *el-GR*) ;; *) echo "the app's locale did not survive the update: $locales"; exit 1 ;; esac
    echo "updated over the previous build; $locales"
    ;;
  post)
    # The database after the update: schema 7, its backup from schema 6, and the locale.
    state="$root/.tmp/maestro-upgrade/$serial"
    rm -rf "$state" && mkdir -p "$state"
    for f in selis.db selis.db-wal selis.db.bak-v6; do
      adb -s "$serial" exec-out run-as "$app" cat "$f" > "$state/$f" 2>/dev/null || rm -f "$state/$f"
    done
    adb -s "$serial" shell cmd locale set-app-locales "$app" --locales ""
    python -I - "$state" <<'PY'
import sqlite3, sys
state = sys.argv[1]
db = sqlite3.connect(f"{state}/selis.db")
version = db.execute("PRAGMA user_version").fetchone()[0]
locale = db.execute("SELECT value FROM settings WHERE key = 'locale'").fetchone()
old = sqlite3.connect(f"{state}/selis.db.bak-v6")
before = old.execute("SELECT value FROM settings WHERE key = 'locale'").fetchone()
print(f"schema {version}; locale before {before[0] if before else None}, after {locale[0] if locale else None}")
ok = version >= 7 and before == ('"system"',) and locale == ('"en"',)
sys.exit(0 if ok else 1)
PY
    ;;
  *)
    echo "unknown mode $mode"
    exit 2
    ;;
esac
