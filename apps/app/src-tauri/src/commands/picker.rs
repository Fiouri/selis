//! System file picker, driven from Rust so its outcome goes through the request
//! store (`take_result` can recover it if the reply is lost; see
//! docs/adr/0005-ipc-reliability.md).

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

use super::{CommandError, CommandResult, ErrorCode};
use crate::requests::RequestResults;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum PickOutcome {
    Picked { source: String },
    Cancelled,
}

fn to_source(path: FilePath) -> String {
    match path {
        FilePath::Url(url) => url.to_string(),
        FilePath::Path(path) => path.to_string_lossy().into_owned(),
    }
}

/// Opens the system picker for one PDF. Cancel (or a picker failure) yields
/// `Cancelled`. Runs once per `request_id`.
#[tauri::command]
#[specta::specta]
pub async fn pick_pdf<R: Runtime>(
    app: AppHandle<R>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
) -> CommandResult<PickOutcome> {
    results
        .run_once(&request_id, "pick_pdf", async move {
            tauri::async_runtime::spawn_blocking(move || {
                match app
                    .dialog()
                    .file()
                    .add_filter("PDF", &["pdf"])
                    .blocking_pick_file()
                {
                    Some(path) => PickOutcome::Picked {
                        source: to_source(path),
                    },
                    None => PickOutcome::Cancelled,
                }
            })
            .await
            .map_err(|e| CommandError::new(ErrorCode::Internal, format!("picker task failed: {e}")))
        })
        .await
}
