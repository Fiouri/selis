//! "Share" from the viewer: hands a copy of a library document to the system
//! share sheet. Android: `SharePlugin.kt`. Elsewhere the command reports
//! `unsupported` and the UI falls back to the Web Share API (iOS) or says so.

use std::sync::Arc;

use selis_core::Library;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Runtime, State};

use super::{CommandError, CommandResult, ErrorCode};

/// Opens the share sheet for the document's library copy. The path is resolved
/// here, never taken from the UI.
#[tauri::command]
#[specta::specta]
pub async fn share_document<R: Runtime>(
    app: AppHandle<R>,
    library: State<'_, Arc<Library>>,
    id: String,
) -> CommandResult<()> {
    let file = library.document_file(&id)?;
    let title = file.document.title.trim();
    let name = if title.is_empty() { "document" } else { title };
    platform::share(&app, &file.path, name).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("selis-share")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = api.register_android_plugin("com.anywecon.selis", "SharePlugin")?;
                app.manage(platform::ShareHandle(handle));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
mod platform {
    use serde::Serialize;
    use tauri::plugin::PluginHandle;
    use tauri::{AppHandle, Manager, Runtime};

    use super::{CommandError, CommandResult, ErrorCode};

    pub struct ShareHandle<R: Runtime>(pub PluginHandle<R>);

    #[derive(Serialize)]
    struct ShareArgs<'a> {
        path: &'a str,
        name: &'a str,
    }

    pub async fn share<R: Runtime>(
        app: &AppHandle<R>,
        path: &str,
        name: &str,
    ) -> CommandResult<()> {
        let handle = app
            .try_state::<ShareHandle<R>>()
            .ok_or_else(|| CommandError::new(ErrorCode::Unsupported, "share plugin not loaded"))?;
        handle
            .0
            .run_mobile_plugin_async::<serde_json::Value>("share", ShareArgs { path, name })
            .await
            .map(|_| ())
            .map_err(|e| CommandError::new(ErrorCode::Io, format!("share: {e}")))
    }
}

#[cfg(not(target_os = "android"))]
mod platform {
    use tauri::{AppHandle, Runtime};

    use super::{CommandError, CommandResult, ErrorCode};

    pub async fn share<R: Runtime>(
        _app: &AppHandle<R>,
        _path: &str,
        _name: &str,
    ) -> CommandResult<()> {
        Err(CommandError::new(
            ErrorCode::Unsupported,
            "no native share sheet on this platform",
        ))
    }
}
