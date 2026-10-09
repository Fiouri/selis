use serde::Serialize;
use specta::Type;
use tauri::{Runtime, Webview};

use super::{CommandError, CommandResult, ErrorCode};

// Each variant is only constructed on its own platform.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MemorySource {
    /// Android `ActivityManager.MemoryInfo.totalMem`.
    ActivityManager,
    /// `sysinfo` (desktop).
    Sysinfo,
    /// iOS `NSProcessInfo.physicalMemory`.
    ProcessInfo,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceMemory {
    /// Total RAM visible to the OS, in bytes (below the marketed size).
    #[specta(type = specta_typescript::Number)]
    pub total_bytes: u64,
    pub source: MemorySource,
}

/// Total device RAM, used by the UI to pick render limits (resolution, cache size).
#[tauri::command]
#[specta::specta]
pub async fn device_memory<R: Runtime>(webview: Webview<R>) -> CommandResult<DeviceMemory> {
    tauri::async_runtime::spawn_blocking(move || platform::total_memory(&webview))
        .await
        .map_err(|e| CommandError::new(ErrorCode::Internal, format!("memory query failed: {e}")))?
}

#[cfg(target_os = "android")]
mod platform {
    use std::sync::mpsc;
    use std::time::Duration;

    use jni::JNIEnv;
    use jni::objects::JObject;
    use tauri::{Runtime, Webview};

    use super::{CommandError, CommandResult, DeviceMemory, ErrorCode, MemorySource};

    fn query(env: &mut JNIEnv<'_>, activity: &JObject<'_>) -> jni::errors::Result<i64> {
        let service = env.new_string("activity")?;
        let manager = env
            .call_method(
                activity,
                "getSystemService",
                "(Ljava/lang/String;)Ljava/lang/Object;",
                &[(&service).into()],
            )?
            .l()?;
        let info = env.new_object("android/app/ActivityManager$MemoryInfo", "()V", &[])?;
        env.call_method(
            &manager,
            "getMemoryInfo",
            "(Landroid/app/ActivityManager$MemoryInfo;)V",
            &[(&info).into()],
        )?;
        env.get_field(&info, "totalMem", "J")?.j()
    }

    pub fn total_memory<R: Runtime>(webview: &Webview<R>) -> CommandResult<DeviceMemory> {
        let (tx, rx) = mpsc::channel();
        webview
            .with_webview(move |platform_webview| {
                // Runs on the Android main thread with the activity's JNI env.
                platform_webview
                    .jni_handle()
                    .exec(move |env, activity, _webview| {
                        let _ = tx.send(query(env, activity).map_err(|e| e.to_string()));
                    });
            })
            .map_err(|e| CommandError::new(ErrorCode::Internal, e.to_string()))?;
        let total = rx
            .recv_timeout(Duration::from_secs(3))
            .map_err(|e| CommandError::new(ErrorCode::Internal, format!("no reply from JNI: {e}")))?
            .map_err(|e| CommandError::new(ErrorCode::Internal, format!("ActivityManager: {e}")))?;
        let total_bytes = u64::try_from(total)
            .map_err(|_| CommandError::new(ErrorCode::Internal, "negative totalMem"))?;
        Ok(DeviceMemory {
            total_bytes,
            source: MemorySource::ActivityManager,
        })
    }
}

#[cfg(target_os = "ios")]
mod platform {
    use objc2_foundation::NSProcessInfo;
    use tauri::{Runtime, Webview};

    use super::{CommandResult, DeviceMemory, MemorySource};

    pub fn total_memory<R: Runtime>(_webview: &Webview<R>) -> CommandResult<DeviceMemory> {
        Ok(DeviceMemory {
            total_bytes: NSProcessInfo::processInfo().physicalMemory(),
            source: MemorySource::ProcessInfo,
        })
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod platform {
    use sysinfo::{MemoryRefreshKind, RefreshKind, System};
    use tauri::{Runtime, Webview};

    use super::{CommandError, CommandResult, DeviceMemory, ErrorCode, MemorySource};

    pub fn total_memory<R: Runtime>(_webview: &Webview<R>) -> CommandResult<DeviceMemory> {
        let system = System::new_with_specifics(
            RefreshKind::nothing().with_memory(MemoryRefreshKind::nothing().with_ram()),
        );
        let total_bytes = system.total_memory();
        if total_bytes == 0 {
            return Err(CommandError::new(
                ErrorCode::Internal,
                "total memory unavailable",
            ));
        }
        Ok(DeviceMemory {
            total_bytes,
            source: MemorySource::Sysinfo,
        })
    }
}
