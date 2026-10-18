//! Camera support for the document scan (P4c, ADR 0016). The camera itself runs in the WebView
//! (getUserMedia, ADR 0013); native code is only needed to open the app's system settings
//! after the camera permission was denied, and for the haptic tick when a page is captured
//! (ADR 0032). Android: `AppSettingsPlugin.kt`. Elsewhere `open_app_settings` reports
//! `unsupported` (the UI does not offer it) and `scan_haptic` does nothing.

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Runtime};

use super::CommandResult;

/// Opens this app's page in the system settings (permissions).
#[tauri::command]
#[specta::specta]
pub async fn open_app_settings<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    platform::open(&app).await
}

/// A short confirm haptic for a captured page (Android: the view's haptic feedback, no
/// permission; nothing elsewhere).
#[tauri::command]
#[specta::specta]
pub async fn scan_haptic<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    platform::haptic(&app).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("selis-camera")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle =
                    api.register_android_plugin("com.anywecon.selis", "AppSettingsPlugin")?;
                app.manage(platform::SettingsHandle(handle));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
mod platform {
    use tauri::plugin::PluginHandle;
    use tauri::{AppHandle, Manager, Runtime};

    use super::super::{CommandError, CommandResult, ErrorCode};

    pub struct SettingsHandle<R: Runtime>(pub PluginHandle<R>);

    pub async fn open<R: Runtime>(app: &AppHandle<R>) -> CommandResult<()> {
        let handle = app.try_state::<SettingsHandle<R>>().ok_or_else(|| {
            CommandError::new(ErrorCode::Unsupported, "settings plugin not loaded")
        })?;
        handle
            .0
            .run_mobile_plugin_async::<serde_json::Value>("open", ())
            .await
            .map_err(|e| CommandError::new(ErrorCode::Io, format!("app settings: {e}")))?;
        Ok(())
    }

    pub async fn haptic<R: Runtime>(app: &AppHandle<R>) -> CommandResult<()> {
        let handle = app.try_state::<SettingsHandle<R>>().ok_or_else(|| {
            CommandError::new(ErrorCode::Unsupported, "settings plugin not loaded")
        })?;
        handle
            .0
            .run_mobile_plugin_async::<serde_json::Value>("haptic", ())
            .await
            .map_err(|e| CommandError::new(ErrorCode::Io, format!("haptic: {e}")))?;
        Ok(())
    }
}

#[cfg(not(target_os = "android"))]
mod platform {
    use tauri::{AppHandle, Runtime};

    use super::super::{CommandError, CommandResult, ErrorCode};

    pub async fn open<R: Runtime>(_app: &AppHandle<R>) -> CommandResult<()> {
        Err(CommandError::new(
            ErrorCode::Unsupported,
            "app settings are opened from the system on this platform",
        ))
    }

    pub async fn haptic<R: Runtime>(_app: &AppHandle<R>) -> CommandResult<()> {
        Ok(())
    }
}
