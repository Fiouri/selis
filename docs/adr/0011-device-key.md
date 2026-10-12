# ADR 0011 — Device key in OS secure storage

- Status: accepted
- Date: 2026-10-12

## Context

A device's transfer identity is an Ed25519 key: its public half is the iroh endpoint id the other
device sees (and, from P3b, trusts); resuming a transfer requires the same id. The secret must
not sit in the library (a library move or a backup would copy the identity) nor reach the UI.

## Decision

`apps/app/src-tauri/src/device_key.rs` loads the key on `transfer_open`, creating it on first use:

| Platform | Storage |
| --- | --- |
| Android | `DeviceKeyPlugin.kt`: a 32-byte seed from `SecureRandom`, sealed with AES-256-GCM by a key generated inside the **Android Keystore** (`selis-device-key-wrap-v1`, never exportable); the sealed bytes live in `noBackupFilesDir` (excluded from Auto Backup and device-to-device transfer), written atomically (temp, fsync, rename). |
| iOS | data-protection **Keychain** (`apple-native-keyring-store` `protected`), `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, not synchronized to iCloud. |
| macOS | login Keychain (`apple-native-keyring-store` `keychain`). |
| Windows | Credential Manager (`windows-native-keyring-store`). |
| Linux | Secret Service (`zbus-secret-service-keyring-store`, pure Rust). |

The seed crosses the JNI boundary once (base64) and is zeroed on the Kotlin side after use. If the
storage is unreachable or the sealed key cannot be opened (Keystore reset, file damaged), a fresh
key is used — persisted when possible, otherwise for that run only. Nothing else is lost: trusted
devices see a new device.

The user asked for an iOS Keychain **Swift** plugin; the Rust `keyring-core` store calls the same
Keychain API (Security.framework) and builds in CI without an Xcode project change, so it is used
instead. Behaviour is identical; iOS is CI-build-only until a Mac is available.

## Consequences

- Reinstalling the app or restoring a backup on a new phone gives a new identity (by design).
- `keyring-core` and the platform stores are MIT/Apache-2.0 (cargo-deny green).
- The library move (P3b) explicitly excludes the device key.
