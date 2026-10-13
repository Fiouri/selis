//! Debug builds only: `tracing` output (iroh, iroh-blobs, selis-transfer) to
//! `<app cache>/logs/rust.log`. On Android:
//! `adb shell setprop debug.selis.rust_log iroh=debug,iroh_blobs=debug,selis_transfer=trace`,
//! restart the app, then `adb shell run-as com.anywecon.selis cat cache/logs/rust.log`.
//! Elsewhere `RUST_LOG`. Default: warnings only. Also the source of the other
//! debug-only switches read from `debug.selis.*` properties
//! (`scripts/check-release-apk.sh` fails a release build that contains one).

use std::{fs::OpenOptions, path::Path, sync::Mutex};

use tracing_subscriber::EnvFilter;

pub fn init(cache: &Path) {
    let filter = std::env::var("RUST_LOG")
        .ok()
        .filter(|f| !f.trim().is_empty())
        .or_else(|| property("debug.selis.rust_log"))
        .unwrap_or_else(|| "warn".to_owned());
    let dir = cache.join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("rust.log"))
    else {
        return;
    };
    let _ = tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::new(filter))
        .with_ansi(false)
        .with_writer(Mutex::new(file))
        .try_init();
}

/// An Android system property (`adb shell setprop`): an app cannot get
/// environment variables there. `None` elsewhere or when unset.
pub fn property(name: &str) -> Option<String> {
    if !cfg!(target_os = "android") {
        return None;
    }
    let out = std::process::Command::new("getprop")
        .arg(name)
        .output()
        .ok()?;
    let value = String::from_utf8(out.stdout).ok()?.trim().to_owned();
    (!value.is_empty()).then_some(value)
}
