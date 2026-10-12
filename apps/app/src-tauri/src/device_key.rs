//! The device's transfer identity (ADR 0011): an Ed25519 key whose public half
//! is the iroh endpoint id other devices see (and, from P3b, trust). The secret
//! lives in the OS secure storage and is never given to the UI or written to
//! the library (a library move leaves it behind):
//!
//! - Android: `DeviceKeyPlugin.kt`, sealed with an AES-GCM key held by the
//!   Android Keystore, stored outside backups.
//! - iOS: the data-protection Keychain, "after first unlock, this device only".
//! - macOS: the login Keychain. Windows: the Credential Manager.
//! - Linux: the Secret Service (GNOME Keyring, KWallet).
//!
//! When no secure storage is reachable (a Linux session without a Secret
//! Service) the key is made for this run only; transfers still work, the
//! device just looks new next time.

use selis_transfer::SecretKey;
use tauri::{AppHandle, Runtime};

#[cfg_attr(target_os = "android", allow(dead_code))]
const SERVICE: &str = "com.anywecon.selis";
#[cfg_attr(target_os = "android", allow(dead_code))]
const ACCOUNT: &str = "transfer-device-key-v1";

/// Where the key came from (for logs and the dev peer).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySource {
    Secure,
    Ephemeral,
}

/// Loads the device key, creating and storing it on first use.
pub async fn load_or_create<R: Runtime>(app: &AppHandle<R>) -> (SecretKey, KeySource) {
    match platform::load_or_create(app).await {
        Ok(key) => (key, KeySource::Secure),
        Err(err) => {
            eprintln!("selis: device key not in secure storage ({err}); using a key for this run");
            (SecretKey::generate(), KeySource::Ephemeral)
        }
    }
}

fn key_from(bytes: &[u8]) -> Option<SecretKey> {
    <[u8; 32]>::try_from(bytes)
        .ok()
        .map(|b| SecretKey::from_bytes(&b))
}

#[cfg(target_os = "android")]
mod platform {
    use base64::Engine;
    use serde::Deserialize;
    use tauri::{AppHandle, Manager, Runtime};

    use super::{SecretKey, key_from};
    use crate::commands::transfer::TransferPlugins;

    #[derive(Deserialize)]
    struct Sealed {
        seed: String,
    }

    pub async fn load_or_create<R: Runtime>(app: &AppHandle<R>) -> Result<SecretKey, String> {
        let plugins = app
            .try_state::<TransferPlugins<R>>()
            .ok_or("device key plugin not loaded")?;
        let out: Sealed = plugins
            .device_key
            .run_mobile_plugin_async("deviceKey", ())
            .await
            .map_err(|e| e.to_string())?;
        let mut seed = base64::engine::general_purpose::STANDARD
            .decode(out.seed.as_bytes())
            .map_err(|e| e.to_string())?;
        let key = key_from(&seed).ok_or("device key has the wrong length");
        seed.fill(0);
        key.map_err(str::to_owned)
    }
}

#[cfg(not(target_os = "android"))]
mod platform {
    use std::collections::HashMap;

    use keyring_core::{Entry, Error, api::CredentialStoreApi};
    use tauri::{AppHandle, Runtime};

    use super::{ACCOUNT, SERVICE, SecretKey, key_from};

    fn entry() -> Result<Entry, Error> {
        #[cfg(target_os = "ios")]
        {
            let store = apple_native_keyring_store::protected::Store::new()?;
            let mods = HashMap::from([("access-policy", "after-first-unlock-this-device-only")]);
            store.build(SERVICE, ACCOUNT, Some(&mods))
        }
        #[cfg(target_os = "macos")]
        {
            let store = apple_native_keyring_store::keychain::Store::new()?;
            store.build(SERVICE, ACCOUNT, None::<&HashMap<&str, &str>>)
        }
        #[cfg(target_os = "windows")]
        {
            let store = windows_native_keyring_store::Store::new()?;
            store.build(SERVICE, ACCOUNT, None::<&HashMap<&str, &str>>)
        }
        #[cfg(all(unix, not(any(target_os = "macos", target_os = "ios"))))]
        {
            let store = zbus_secret_service_keyring_store::Store::new()?;
            store.build(SERVICE, ACCOUNT, None::<&HashMap<&str, &str>>)
        }
    }

    pub async fn load_or_create<R: Runtime>(_app: &AppHandle<R>) -> Result<SecretKey, String> {
        // The stores block (IPC to the OS keychain): off the async runtime.
        tauri::async_runtime::spawn_blocking(|| {
            let entry = entry().map_err(|e| e.to_string())?;
            match entry.get_secret() {
                Ok(bytes) => {
                    if let Some(key) = key_from(&bytes) {
                        return Ok(key);
                    }
                }
                Err(Error::NoEntry) => {}
                Err(e) => return Err(e.to_string()),
            }
            let key = SecretKey::generate();
            entry
                .set_secret(&key.to_bytes())
                .map_err(|e| e.to_string())?;
            Ok(key)
        })
        .await
        .map_err(|e| e.to_string())?
    }
}
