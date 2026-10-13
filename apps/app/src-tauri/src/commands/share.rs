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

pub(crate) use platform::share_file;

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
    #[serde(rename_all = "camelCase")]
    struct ShareArgs<'a> {
        path: &'a str,
        name: &'a str,
        mime: Option<&'a str>,
        /// The file is already in the share folder under its final name.
        in_place: bool,
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
            .run_mobile_plugin_async::<serde_json::Value>(
                "share",
                ShareArgs {
                    path,
                    name,
                    mime: None,
                    in_place: false,
                },
            )
            .await
            .map(|_| ())
            .map_err(|e| CommandError::new(ErrorCode::Io, format!("share: {e}")))
    }

    /// Shares a file already written to the share folder (`cache/share`).
    /// Always `true`: the share sheet does not say whether something was picked.
    pub async fn share_file<R: Runtime>(
        app: &AppHandle<R>,
        path: &std::path::Path,
        name: &str,
        mime: &str,
    ) -> CommandResult<bool> {
        let handle = app
            .try_state::<ShareHandle<R>>()
            .ok_or_else(|| CommandError::new(ErrorCode::Unsupported, "share plugin not loaded"))?;
        handle
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                "share",
                ShareArgs {
                    path: &path.to_string_lossy(),
                    name,
                    mime: Some(mime),
                    in_place: true,
                },
            )
            .await
            .map(|_| true)
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

    /// No share sheet here: the system "save as" dialog, then a copy. `false`
    /// when the dialog was cancelled (nothing written).
    pub async fn share_file<R: Runtime>(
        app: &AppHandle<R>,
        path: &std::path::Path,
        name: &str,
        _mime: &str,
    ) -> CommandResult<bool> {
        use tauri_plugin_dialog::DialogExt;
        let app = app.clone();
        let source = path.to_path_buf();
        let name = name.to_owned();
        tauri::async_runtime::spawn_blocking(move || {
            let Some(target) = app
                .dialog()
                .file()
                .set_file_name(&name)
                .blocking_save_file()
            else {
                return Ok(false);
            };
            let target = target
                .into_path()
                .map_err(|e| CommandError::new(ErrorCode::Unsupported, e.to_string()))?;
            std::fs::copy(&source, &target)
                .map(|_| true)
                .map_err(|e| CommandError::new(ErrorCode::Io, e.to_string()))
        })
        .await
        .map_err(|e| CommandError::new(ErrorCode::Internal, e.to_string()))?
    }
}
