//! System file picker, driven from Rust.
//!
//! On Android the IPC reply of a picker call can be lost on the way back to the
//! WebView (the plugin resolves, but the response never reaches JS; see
//! docs/spike-p0.md "Known issues"). The outcome is therefore also kept here,
//! keyed by the caller's request id, so the UI can fetch it with a fresh IPC
//! call (`take_pick_result`) once the app is back in front.

use std::sync::Mutex;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

use super::{CommandError, CommandResult, ErrorCode};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum PickOutcome {
    Picked { source: String },
    Cancelled,
}

/// Last picker outcome (one picker at a time), until the UI takes it.
#[derive(Default)]
pub struct PickerState(Mutex<Option<(u32, PickOutcome)>>);

impl PickerState {
    fn store(&self, request_id: u32, outcome: PickOutcome) {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = Some((request_id, outcome));
    }

    fn take(&self, request_id: u32) -> Option<PickOutcome> {
        let mut slot = self.0.lock().unwrap_or_else(|p| p.into_inner());
        match slot.as_ref() {
            Some((id, _)) if *id == request_id => slot.take().map(|(_, outcome)| outcome),
            _ => None,
        }
    }
}

fn to_source(path: FilePath) -> String {
    match path {
        FilePath::Url(url) => url.to_string(),
        FilePath::Path(path) => path.to_string_lossy().into_owned(),
    }
}

/// Opens the system picker for one PDF. Cancel (or a picker failure) yields `Cancelled`.
#[tauri::command]
#[specta::specta]
pub async fn pick_pdf<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, std::sync::Arc<PickerState>>,
    request_id: u32,
) -> CommandResult<PickOutcome> {
    let state = std::sync::Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app
            .dialog()
            .file()
            .add_filter("PDF", &["pdf"])
            .blocking_pick_file();
        let outcome = match picked {
            Some(path) => PickOutcome::Picked {
                source: to_source(path),
            },
            None => PickOutcome::Cancelled,
        };
        state.store(request_id, outcome.clone());
        outcome
    })
    .await
    .map_err(|e| CommandError::new(ErrorCode::Internal, format!("picker task failed: {e}")))
}

/// Returns (and clears) the outcome of picker request `request_id`, if it finished.
#[tauri::command]
#[specta::specta]
pub async fn take_pick_result(
    state: State<'_, std::sync::Arc<PickerState>>,
    request_id: u32,
) -> CommandResult<Option<PickOutcome>> {
    Ok(state.take(request_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_returns_only_the_matching_request_once() {
        let state = PickerState::default();
        state.store(
            7,
            PickOutcome::Picked {
                source: "content://x".into(),
            },
        );
        assert_eq!(state.take(6), None);
        assert_eq!(
            state.take(7),
            Some(PickOutcome::Picked {
                source: "content://x".into()
            })
        );
        assert_eq!(state.take(7), None);
    }

    #[test]
    fn a_newer_request_replaces_the_previous_outcome() {
        let state = PickerState::default();
        state.store(1, PickOutcome::Cancelled);
        state.store(2, PickOutcome::Cancelled);
        assert_eq!(state.take(1), None);
        assert_eq!(state.take(2), Some(PickOutcome::Cancelled));
    }
}
