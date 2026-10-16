#!/usr/bin/env bash
# Store images are English-only (docs/store/play-console.md, docs/store/ios-release.md): Play and
# F-Droid fall back to fastlane/metadata/android/en-US/images for every other listing language,
# App Store Connect to the primary language's screenshots. Greek UI pictures exist for tests only
# (Playwright visual snapshots).
#
# Fails when fastlane/metadata/android/<locale>/images exists for a locale other than en-US, or
# fastlane/screenshots/<locale> for a locale other than en-US.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
bad=0
for dir in "$root"/fastlane/metadata/android/*/images "$root"/fastlane/screenshots/*/; do
  [ -d "$dir" ] || continue
  dir="${dir%/}"
  case "$dir" in
    */android/en-US/images | */screenshots/en-US) ;;
    *)
      echo "FAIL: ${dir#"$root"/} — store images are English-only (en-US); other locales use the en-US set" >&2
      bad=1
      ;;
  esac
done
[ "$bad" -eq 0 ] || exit 1
echo "store images: en-US only"
