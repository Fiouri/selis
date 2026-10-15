# ADR 0022 — iOS release: automatic signing with an API key, TestFlight from CI

- Status: accepted
- Date: 2026-10-14

## Context

There is no Mac; iOS builds only on GitHub's macOS runners. The App Store needs a
distribution-signed IPA built with Xcode 26 and an iOS 26 SDK (required for uploads since
2026-04-28, <https://developer.apple.com/news/upcoming-requirements/>). Tauri builds the IPA with
`tauri ios build --export-method app-store-connect` and supports automatic signing in CI through
an App Store Connect API key (`APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`;
<https://tauri.app/distribute/sign/ios/>). Apple's `altool --upload-app` is deprecated in favour of
`--upload-package`, and Xcode 26's altool can exit 0 on a failed upload.

## Decision

- `release-ios.yml` on `macos-26`: automatic signing with an Admin API key (Xcode's
  cloud-managed distribution certificate) — no certificate or profile in secrets, nothing to
  renew by hand. Secrets: `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8`,
  `APPLE_DEVELOPMENT_TEAM`; repository variable `APPSTORE_APP_APPLE_ID` for the upload. Without
  them the job ends with a notice. The `.p8` lives in `~/private_keys` for the job only.
- Versions from ADR 0020 through `tauri ios build --config "$(version.ts ios-config)"`: short
  version `X.Y.Z`, build number increasing across rcs and releases.
- Upload with `xcrun altool --upload-package … --output-format json`; the job fails unless the
  JSON reports success and no product errors.
- Privacy manifest (`PrivacyInfo.xcprivacy`): no tracking, no collected data; required-reason
  APIs File timestamp (C617.1 app container, 3B52.1 user-picked files — tauri-plugin-dialog reads
  the picked file's modification date) and System boot time (35F9.1, elapsed time in the
  transfer stack).
- Purpose strings: camera for QR codes **and document scan** (the P4c scan was missing from the
  text), photo-library add for the share sheet's "Save Image" (without it iOS terminates the
  app when that action is chosen).
- `ITSAppUsesNonExemptEncryption` is not set until the owner decides
  (`docs/store/ios-export-compliance.md`: the correct value is YES; France needs a declaration).
- CI's simulator build stays on `macos-15` (no signing, no upload).

## Consequences

- Owner steps (account, app record, key, TestFlight testers): `docs/store/ios-release.md`.
- A revoked or expired API key stops releases but leaks nothing else; the certificate is
  Apple-managed.
- The IPA is not attached to GitHub releases (it installs only through Apple).
