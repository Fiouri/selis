//! "Open with" / share target. Documents handed over by other apps wait in
//! [`OpenQueue`] until the UI has imported them through the normal import path
//! (`import_document` with a request id, the import state machine) and
//! dismisses them.
//!
//! - Android: `OpenWithPlugin.kt` collects `content://` URIs from VIEW / SEND /
//!   SEND_MULTIPLE intents; `pending_opens` drains it into the queue.
//! - iOS: `CFBundleDocumentTypes` (Info.plist) makes Selis an "Open in" / "Copy
//!   to" target; the system hands a file URL to `RunEvent::Opened` (lib.rs).
//!
//! The UI asks on startup and whenever the app comes back to the foreground.
//! Reading the queue does not consume it, so a lost reply is simply asked for
//! again (docs/adr/0005-ipc-reliability.md).

use std::sync::Arc;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Runtime, State};

use super::CommandResult;

/// A SEND_MULTIPLE beyond this is truncated (the rest is logged and dropped).
#[cfg_attr(
    not(any(target_os = "android", target_os = "ios", target_os = "macos")),
    allow(dead_code)
)]
const MAX_PENDING: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingOpen {
    pub id: String,
    /// `content://` URI (Android) or `file://` URL (iOS), passed to `import_document`.
    pub source: String,
    /// The sender's file name, when it told us.
    pub name: Option<String>,
}

#[derive(Default)]
pub struct OpenQueue {
    inner: Mutex<QueueState>,
}

#[derive(Default)]
#[cfg_attr(
    not(any(target_os = "android", target_os = "ios", target_os = "macos")),
    allow(dead_code)
)]
struct QueueState {
    items: Vec<PendingOpen>,
    next_id: u64,
}

impl OpenQueue {
    /// Adds a document unless the same source is already waiting.
    // Windows/Linux have no "Open with" source yet (desktop file associations: P6).
    #[cfg_attr(
        not(any(target_os = "android", target_os = "ios", target_os = "macos")),
        allow(dead_code)
    )]
    pub fn push(&self, source: String, name: Option<String>) {
        let mut state = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if state.items.iter().any(|item| item.source == source) {
            return;
        }
        if state.items.len() >= MAX_PENDING {
            eprintln!("selis: open-with queue full, dropping a shared document");
            return;
        }
        state.next_id += 1;
        let id = format!("open-{}", state.next_id);
        let name = name.map(|n| n.trim().to_owned()).filter(|n| !n.is_empty());
        state.items.push(PendingOpen { id, source, name });
    }

    pub fn list(&self) -> Vec<PendingOpen> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .items
            .clone()
    }

    /// Removes an entry; unknown ids are ignored (dismiss is idempotent).
    pub fn dismiss(&self, id: &str) {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .items
            .retain(|item| item.id != id);
    }
}

/// Documents waiting to be imported, oldest first.
#[tauri::command]
#[specta::specta]
pub async fn pending_opens<R: Runtime>(
    app: AppHandle<R>,
    queue: State<'_, Arc<OpenQueue>>,
) -> CommandResult<Vec<PendingOpen>> {
    #[cfg(target_os = "android")]
    android::drain(&app, &queue).await?;
    #[cfg(not(target_os = "android"))]
    let _ = app;
    Ok(queue.list())
}

/// Called once a pending document has been imported (or failed for good).
#[tauri::command]
#[specta::specta]
pub async fn dismiss_open(queue: State<'_, Arc<OpenQueue>>, id: String) -> CommandResult<()> {
    queue.dismiss(&id);
    Ok(())
}

/// Registers the Android side (`OpenWithPlugin.kt`). No JS-facing commands:
/// only Rust talks to it, so it needs no capability.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("selis-open-with")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = api.register_android_plugin("com.anywecon.selis", "OpenWithPlugin")?;
                app.manage(android::OpenWithHandle(handle));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
mod android {
    use serde::Deserialize;
    use tauri::plugin::PluginHandle;
    use tauri::{AppHandle, Manager, Runtime};

    use super::OpenQueue;
    use crate::commands::{CommandError, CommandResult, ErrorCode};

    pub struct OpenWithHandle<R: Runtime>(pub PluginHandle<R>);

    #[derive(Deserialize)]
    struct Taken {
        items: Vec<TakenItem>,
    }

    #[derive(Deserialize)]
    struct TakenItem {
        uri: String,
        name: Option<String>,
    }

    /// Moves what the Kotlin plugin collected into the queue (a JNI call, not
    /// WebView IPC, so nothing can get lost on the way).
    pub async fn drain<R: Runtime>(app: &AppHandle<R>, queue: &OpenQueue) -> CommandResult<()> {
        let Some(handle) = app.try_state::<OpenWithHandle<R>>() else {
            return Ok(());
        };
        let taken: Taken = handle
            .0
            .run_mobile_plugin_async("takePending", ())
            .await
            .map_err(|e| CommandError::new(ErrorCode::Internal, format!("open-with: {e}")))?;
        for item in taken.items {
            queue.push(item.uri, item.name);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupes_by_source_and_dismisses() {
        let q = OpenQueue::default();
        q.push("content://a".into(), Some(" A.pdf ".into()));
        q.push("content://a".into(), None);
        q.push("content://b".into(), Some("  ".into()));
        let items = q.list();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].name.as_deref(), Some("A.pdf"));
        assert_eq!(items[1].name, None);
        assert_ne!(items[0].id, items[1].id);
        q.dismiss(&items[0].id);
        q.dismiss(&items[0].id);
        assert_eq!(q.list(), [items[1].clone()]);
        // A dismissed source can arrive again later (a new "Open with").
        q.push("content://a".into(), None);
        assert_eq!(q.list().len(), 2);
    }

    #[test]
    fn caps_the_queue() {
        let q = OpenQueue::default();
        for i in 0..(MAX_PENDING + 5) {
            q.push(format!("content://{i}"), None);
        }
        assert_eq!(q.list().len(), MAX_PENDING);
    }
}
