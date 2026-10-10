//! Recovery of replies lost on the way to the WebView (docs/adr/0005-ipc-reliability.md).

use std::sync::Arc;

use tauri::State;

use super::CommandResult;
use crate::requests::{RequestResults, TakeResult};

/// The state of a long-running request: still running, its final result, or
/// unknown (never received, or expired). Read-only; a fresh call the UI makes
/// when the original reply did not arrive.
#[tauri::command]
#[specta::specta]
pub async fn take_result(
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
) -> CommandResult<TakeResult> {
    Ok(results.take(&request_id))
}
