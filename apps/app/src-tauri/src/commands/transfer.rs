//! Transfer screen (P3a, ADR 0010). The iroh endpoint exists only between
//! `transfer_open` (the screen opens) and `transfer_close` (it closes, or the
//! app goes to the background with nothing running): Selis opens no socket at
//! start or anywhere else. A running transfer keeps the endpoint alive (on
//! Android under a dataSync foreground service, `TransferPlugin.kt`).
//!
//! Sending: `transfer_offer` → ticket (QR + link); the receiver connects, both
//! screens show the code, `transfer_decide` lets it fetch.
//! Receiving: `transfer_receive(link)` → code → progress → the documents are
//! verified, imported into the library (origin "received") and the transfer
//! store is emptied. A receive that stops mid-way keeps a resume token in the
//! `transfers` table and continues with `transfer_resume`, also after the app
//! was killed.
//!
//! Long-running commands take a request id (ADR 0005).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use selis_core::{
    Library, ReceivedDocument, ReceivedFile, TransferDirection, TransferRowState, TransferUpdate,
};
use selis_transfer::{
    Network, OfferItem, OfferVersion, ReceiveState, ResumeInfo, Route, SendState, ServiceConfig,
    TransferError, TransferService, TransferTicket, qr,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Runtime, State};

use super::{CommandError, CommandResult, ErrorCode, settings};
use crate::device_key;
use crate::requests::RequestResults;

/// How often trackers look at a running transfer.
const POLL: Duration = Duration::from_millis(250);
/// How often a receive's progress is written to the `transfers` table.
const PERSIST_EVERY: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TransferErrorCode {
    Expired,
    AlreadyUsed,
    Unknown,
    Declined,
    Unreachable,
    Interrupted,
    Mismatch,
    Protocol,
    Storage,
    Cancelled,
    /// Not a Selis transfer link.
    InvalidLink,
}

impl From<TransferError> for TransferErrorCode {
    fn from(e: TransferError) -> Self {
        match e {
            TransferError::Expired => Self::Expired,
            TransferError::AlreadyUsed => Self::AlreadyUsed,
            TransferError::Unknown => Self::Unknown,
            TransferError::Declined => Self::Declined,
            TransferError::Unreachable => Self::Unreachable,
            TransferError::Interrupted => Self::Interrupted,
            TransferError::Mismatch => Self::Mismatch,
            TransferError::Protocol => Self::Protocol,
            TransferError::Storage => Self::Storage,
            TransferError::Cancelled => Self::Cancelled,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RouteView {
    Direct,
    Relay,
    Unknown,
}

impl From<Route> for RouteView {
    fn from(r: Route) -> Self {
        match r {
            Route::Direct => Self::Direct,
            Route::Relay => Self::Relay,
            Route::Unknown => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SendView {
    WaitingForReceiver,
    #[serde(rename_all = "camelCase")]
    Confirm {
        code: String,
    },
    #[serde(rename_all = "camelCase")]
    Sending {
        bytes: f64,
        total: f64,
        route: RouteView,
    },
    /// The receiver dropped; it can come back while this screen stays open.
    #[serde(rename_all = "camelCase")]
    Interrupted {
        bytes: f64,
        total: f64,
    },
    Done,
    #[serde(rename_all = "camelCase")]
    Failed {
        error: TransferErrorCode,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReceiveView {
    Connecting,
    #[serde(rename_all = "camelCase")]
    Confirm {
        code: String,
    },
    #[serde(rename_all = "camelCase")]
    Receiving {
        bytes: f64,
        total: f64,
        route: RouteView,
    },
    Verifying,
    /// Adding the documents to the library.
    Saving,
    #[serde(rename_all = "camelCase")]
    Done {
        document_ids: Vec<String>,
        duplicates: u32,
    },
    /// Stopped mid-way (connection lost, app stopped, Android's daily limit):
    /// `transfer_resume` continues without fetching again what arrived.
    #[serde(rename_all = "camelCase")]
    Paused {
        bytes: f64,
        total: f64,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        error: TransferErrorCode,
    },
}

impl ReceiveView {
    fn running(&self) -> bool {
        matches!(
            self,
            Self::Connecting
                | Self::Confirm { .. }
                | Self::Receiving { .. }
                | Self::Verifying
                | Self::Saving
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum NetworkView {
    Default,
    LocalOnly,
    CustomRelay,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TransferInfo {
    /// This device's id as other devices see it (hex).
    pub device_id: String,
    pub network: NetworkView,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OfferView {
    pub session_id: String,
    /// `selis://transfer/…` (the QR code's content, also for copying).
    pub link: String,
    /// The QR code, black on white (any theme).
    pub qr_svg: String,
    pub doc_count: u32,
    pub total_bytes: f64,
    /// Unix seconds after which the code is refused.
    pub expires_at: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResumableView {
    pub id: String,
    pub doc_count: u32,
    pub total_bytes: f64,
    pub done_bytes: f64,
    pub updated_at: f64,
}

/// Android plugin handles (`DeviceKeyPlugin.kt`, `TransferPlugin.kt`).
#[cfg(target_os = "android")]
pub struct TransferPlugins<R: Runtime> {
    pub device_key: tauri::plugin::PluginHandle<R>,
    pub transfer: tauri::plugin::PluginHandle<R>,
}

/// Lives for the app; holds a service only while the Transfer screen is open.
#[derive(Default)]
pub struct TransferState {
    open: tokio::sync::Mutex<Option<Open>>,
    receives: Mutex<HashMap<String, ReceiveView>>,
    sends: Mutex<HashMap<String, SendView>>,
    /// The screen asked to close while something was running: close when it ends.
    close_requested: Mutex<bool>,
    #[cfg(debug_assertions)]
    force_relay: Mutex<bool>,
}

struct Open {
    service: Arc<TransferService>,
    network: NetworkView,
    /// Receive row id → its tracker.
    trackers: HashMap<String, tauri::async_runtime::JoinHandle<()>>,
    /// Ticket link → receive row id (a repeated scan joins the same receive).
    links: HashMap<String, String>,
    /// Receive row id → the service's session.
    sessions: HashMap<String, String>,
    /// Send session → its tracker and `transfers` row.
    send_tasks: HashMap<String, (tauri::async_runtime::JoinHandle<()>, String)>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn err(code: ErrorCode, msg: impl Into<String>) -> CommandError {
    CommandError::new(code, msg)
}

fn not_open() -> CommandError {
    err(
        ErrorCode::InvalidArgument,
        "the transfer screen is not open",
    )
}

impl TransferState {
    /// Whether the endpoint exists (tests: nothing listens before the screen opens).
    #[cfg(test)]
    async fn is_open(&self) -> bool {
        self.open.lock().await.is_some()
    }

    fn running(&self) -> bool {
        lock(&self.receives).values().any(ReceiveView::running)
            || lock(&self.sends)
                .values()
                .any(|s| matches!(s, SendView::Confirm { .. } | SendView::Sending { .. }))
    }

    async fn service(&self) -> CommandResult<Arc<TransferService>> {
        self.open
            .lock()
            .await
            .as_ref()
            .map(|o| Arc::clone(&o.service))
            .ok_or_else(not_open)
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("selis-transfer")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let device_key =
                    api.register_android_plugin("com.anywecon.selis", "DeviceKeyPlugin")?;
                let transfer =
                    api.register_android_plugin("com.anywecon.selis", "TransferPlugin")?;
                app.manage(TransferPlugins {
                    device_key,
                    transfer,
                });
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
async fn android_call<R: Runtime>(app: &AppHandle<R>, cmd: &str, args: serde_json::Value) {
    if let Some(p) = app.try_state::<TransferPlugins<R>>()
        && let Err(e) = p
            .transfer
            .run_mobile_plugin_async::<serde_json::Value>(cmd, args)
            .await
    {
        eprintln!("selis: transfer plugin {cmd}: {e}");
    }
}

fn store_dir<R: Runtime>(app: &AppHandle<R>) -> CommandResult<PathBuf> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| err(ErrorCode::Io, e.to_string()))?;
    Ok(cache.join("transfer"))
}

/// Opens the endpoint (idempotent). Called when the Transfer screen opens.
#[tauri::command]
#[specta::specta]
pub async fn transfer_open<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
) -> CommandResult<TransferInfo> {
    let mut open = state.open.lock().await;
    *lock(&state.close_requested) = false;
    if let Some(o) = open.as_ref() {
        return Ok(TransferInfo {
            device_id: o.service.endpoint_id().to_string(),
            network: o.network,
        });
    }
    let settings = settings::load(&library)?;
    let (network, view) = if settings.local_only {
        (Network::LocalOnly, NetworkView::LocalOnly)
    } else if let Some(url) = settings
        .relay_url
        .as_deref()
        .and_then(selis_transfer::parse_relay_url)
    {
        (Network::CustomRelay(url), NetworkView::CustomRelay)
    } else {
        (Network::Default, NetworkView::Default)
    };
    let (key, _source) = device_key::load_or_create(&app).await;
    let base = store_dir(&app)?;
    let mut config = ServiceConfig::new(key, base.join("store"), network);
    #[cfg(debug_assertions)]
    {
        // Testing aid, compiled out of release builds (scripts/check-release-apk.sh).
        std::hint::black_box("SELIS_DEBUG_FORCE_RELAY");
        config.force_relay = *lock(&state.force_relay) && view != NetworkView::LocalOnly;
    }
    #[cfg(target_os = "android")]
    android_call(&app, "open", serde_json::json!({})).await;
    let service = TransferService::start(config)
        .await
        .map_err(|e| err(ErrorCode::Io, e.to_string()))?;
    let info = TransferInfo {
        device_id: service.endpoint_id().to_string(),
        network: view,
    };
    *open = Some(Open {
        service: Arc::new(service),
        network: view,
        trackers: HashMap::new(),
        links: HashMap::new(),
        sessions: HashMap::new(),
        send_tasks: HashMap::new(),
    });
    Ok(info)
}

/// Closes the endpoint when the Transfer screen closes or the app goes to the
/// background. With something running and no `force`, it stays open until
/// that ends (the foreground service keeps it going) and `false` is returned.
#[tauri::command]
#[specta::specta]
pub async fn transfer_close<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
    force: bool,
) -> CommandResult<bool> {
    if !force && state.running() {
        *lock(&state.close_requested) = true;
        return Ok(false);
    }
    close_now(&app, &state, &library).await;
    Ok(true)
}

async fn close_now<R: Runtime>(app: &AppHandle<R>, state: &TransferState, library: &Library) {
    let Some(open) = state.open.lock().await.take() else {
        return;
    };
    for (id, task) in open.trackers {
        task.abort();
        pause_row(library, state, &id);
    }
    for session in open.sessions.values() {
        open.service.cancel_receive(session);
    }
    for (session, (task, row)) in open.send_tasks {
        task.abort();
        let finished = matches!(
            lock(&state.sends).get(&session),
            Some(SendView::Done | SendView::Failed { .. })
        );
        if !finished {
            let _ = library.transfer_update(
                &row,
                &TransferUpdate {
                    state: Some(TransferRowState::Cancelled),
                    ..Default::default()
                },
            );
        }
    }
    lock(&state.sends).clear();
    *lock(&state.close_requested) = false;
    // Partial downloads stay for resuming; with none left the store goes.
    let wipe = library
        .resumable_transfers()
        .map(|r| r.is_empty())
        .unwrap_or(false);
    open.service.close(wipe).await;
    if wipe && let Ok(dir) = store_dir(app) {
        let _ = std::fs::remove_dir_all(dir);
    }
    #[cfg(target_os = "android")]
    android_call(app, "close", serde_json::json!({})).await;
    #[cfg(not(target_os = "android"))]
    let _ = app;
}

/// A receive stopped by us (closing, pausing): resumable if it got that far.
fn pause_row(library: &Library, state: &TransferState, id: &str) {
    let mut receives = lock(&state.receives);
    let Some(view) = receives.get_mut(id) else {
        return;
    };
    if !view.running() {
        return;
    }
    let resumable = library
        .transfer(id)
        .ok()
        .flatten()
        .is_some_and(|r| r.resume.is_some());
    let (bytes, total) = match view {
        ReceiveView::Receiving { bytes, total, .. } => (*bytes, *total),
        _ => (0.0, 0.0),
    };
    *view = if resumable {
        ReceiveView::Paused { bytes, total }
    } else {
        ReceiveView::Failed {
            error: TransferErrorCode::Cancelled,
        }
    };
    let update = TransferUpdate {
        state: Some(if resumable {
            TransferRowState::Interrupted
        } else {
            TransferRowState::Cancelled
        }),
        ..Default::default()
    };
    let _ = library.transfer_update(id, &update);
}

/// Pauses every receive (Android's daily foreground-service limit, `timeout` event).
#[tauri::command]
#[specta::specta]
pub async fn transfer_pause(
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
) -> CommandResult<()> {
    let mut open = state.open.lock().await;
    if let Some(o) = open.as_mut() {
        for (id, task) in o.trackers.drain() {
            task.abort();
            pause_row(&library, &state, &id);
            if let Some(session) = o.sessions.remove(&id) {
                o.service.cancel_receive(&session);
            }
        }
    }
    Ok(())
}

/// Offers documents: returns the QR code and link (valid 10 minutes, once).
#[tauri::command]
#[specta::specta]
pub async fn transfer_offer(
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    document_ids: Vec<String>,
    include_history: bool,
) -> CommandResult<OfferView> {
    let state = Arc::clone(&state);
    let library = Arc::clone(&library);
    results
        .run_once(&request_id, "transfer_offer", async move {
            offer(state, library, document_ids, include_history).await
        })
        .await
}

async fn offer(
    state: Arc<TransferState>,
    library: Arc<Library>,
    document_ids: Vec<String>,
    include_history: bool,
) -> CommandResult<OfferView> {
    if document_ids.is_empty() || document_ids.len() > 10_000 {
        return Err(err(ErrorCode::InvalidArgument, "choose documents to send"));
    }
    let service = state.service().await?;
    let mut items = Vec::new();
    let mut total: u64 = 0;
    for id in &document_ids {
        let out = library.outgoing(id, include_history)?;
        let title = out.title.trim().to_owned();
        let name = format!("{}.pdf", if title.is_empty() { "document" } else { &title });
        for path in std::iter::once(&out.current).chain(out.history.iter().map(|(p, _)| p)) {
            total += std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        }
        items.push(OfferItem {
            title,
            name: sanitize_name(&name),
            path: out.current,
            history: out
                .history
                .into_iter()
                .map(|(path, created_at)| OfferVersion { path, created_at })
                .collect(),
        });
    }
    let doc_count = u32::try_from(items.len()).unwrap_or(u32::MAX);
    let (session_id, ticket) = service
        .offer(items)
        .await
        .map_err(|e| err(ErrorCode::Io, e.to_string()))?;
    let link = ticket.to_link();
    let qr_svg = qr::svg(&link).ok_or_else(|| err(ErrorCode::Internal, "QR code"))?;
    let row = library.transfer_start(TransferDirection::Send)?;
    library.transfer_update(
        &row,
        &TransferUpdate {
            doc_count: Some(doc_count),
            total_bytes: Some(total),
            ..Default::default()
        },
    )?;
    lock(&state.sends).insert(session_id.clone(), SendView::WaitingForReceiver);
    let task = tauri::async_runtime::spawn(track_send(
        Arc::clone(&state),
        library,
        service,
        session_id.clone(),
        row.clone(),
    ));
    if let Some(o) = state.open.lock().await.as_mut() {
        o.send_tasks.insert(session_id.clone(), (task, row));
    }
    Ok(OfferView {
        session_id,
        link,
        qr_svg,
        doc_count,
        total_bytes: total as f64,
        expires_at: ticket.expires_at as f64,
    })
}

/// File names in the manifest: no path separators or control characters.
fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned: String = cleaned.chars().take(200).collect();
    if cleaned.trim().is_empty() || cleaned == "." || cleaned == ".." {
        "document.pdf".into()
    } else {
        cleaned
    }
}

fn send_view(s: SendState) -> SendView {
    match s {
        SendState::WaitingForReceiver => SendView::WaitingForReceiver,
        SendState::Confirm { code } => SendView::Confirm { code },
        SendState::Sending {
            bytes,
            total,
            route,
        } => SendView::Sending {
            bytes: bytes as f64,
            total: total as f64,
            route: route.into(),
        },
        SendState::Interrupted { bytes, total } => SendView::Interrupted {
            bytes: bytes as f64,
            total: total as f64,
        },
        SendState::Done => SendView::Done,
        SendState::Failed { error } => SendView::Failed {
            error: error.into(),
        },
    }
}

async fn track_send(
    state: Arc<TransferState>,
    library: Arc<Library>,
    service: Arc<TransferService>,
    session: String,
    row: String,
) {
    loop {
        tokio::time::sleep(POLL).await;
        let Some(s) = service.send_state(&session) else {
            // Cancelled (or the screen closed).
            let _ = library.transfer_update(
                &row,
                &TransferUpdate {
                    state: Some(TransferRowState::Cancelled),
                    ..Default::default()
                },
            );
            lock(&state.sends).remove(&session);
            return;
        };
        let view = send_view(s);
        let finished = match &view {
            SendView::Done => Some((TransferRowState::Done, None)),
            SendView::Failed { error } => Some((
                if *error == TransferErrorCode::Cancelled {
                    TransferRowState::Cancelled
                } else {
                    TransferRowState::Failed
                },
                Some(error_name(*error)),
            )),
            _ => None,
        };
        if let SendView::Sending { bytes, .. } = &view {
            let _ = library.transfer_update(
                &row,
                &TransferUpdate {
                    done_bytes: Some(*bytes as u64),
                    ..Default::default()
                },
            );
        }
        lock(&state.sends).insert(session.clone(), view);
        if let Some((st, error)) = finished {
            let _ = library.transfer_update(
                &row,
                &TransferUpdate {
                    state: Some(st),
                    error,
                    ..Default::default()
                },
            );
            return;
        }
    }
}

fn error_name(e: TransferErrorCode) -> String {
    serde_json::to_value(e)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

#[tauri::command]
#[specta::specta]
pub async fn transfer_send_status(
    state: State<'_, Arc<TransferState>>,
    session_id: String,
) -> CommandResult<SendView> {
    if let Some(v) = lock(&state.sends).get(&session_id) {
        return Ok(v.clone());
    }
    let service = state.service().await?;
    service
        .send_state(&session_id)
        .map(send_view)
        .ok_or_else(|| err(ErrorCode::NotFound, "no such transfer"))
}

/// The sender's answer to the code both screens show.
#[tauri::command]
#[specta::specta]
pub async fn transfer_decide(
    state: State<'_, Arc<TransferState>>,
    session_id: String,
    confirm: bool,
) -> CommandResult<()> {
    let service = state.service().await?;
    service
        .decide(&session_id, confirm)
        .map_err(|e| err(ErrorCode::InvalidArgument, e.to_string()))
}

#[tauri::command]
#[specta::specta]
pub async fn transfer_cancel_send(
    state: State<'_, Arc<TransferState>>,
    session_id: String,
) -> CommandResult<()> {
    if let Ok(service) = state.service().await {
        service.cancel_send(&session_id);
    }
    lock(&state.sends).insert(
        session_id,
        SendView::Failed {
            error: TransferErrorCode::Cancelled,
        },
    );
    Ok(())
}

/// Starts receiving from a scanned or pasted link; returns the receive id.
/// The same link again returns the same receive (a double scan, a lost reply).
#[tauri::command]
#[specta::specta]
pub async fn transfer_receive<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
    link: String,
) -> CommandResult<String> {
    let state = Arc::clone(&state);
    let library = Arc::clone(&library);
    results
        .run_once(&request_id, "transfer_receive", async move {
            receive(app, state, library, link).await
        })
        .await
}

async fn receive<R: Runtime>(
    app: AppHandle<R>,
    state: Arc<TransferState>,
    library: Arc<Library>,
    link: String,
) -> CommandResult<String> {
    let ticket =
        TransferTicket::parse(&link).map_err(|_| err(ErrorCode::InvalidArgument, "invalidLink"))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if !ticket.is_valid_at(now) {
        return Err(err(ErrorCode::InvalidArgument, "expired"));
    }
    let key = ticket.to_link();
    let mut open = state.open.lock().await;
    let o = open.as_mut().ok_or_else(not_open)?;
    if let Some(id) = o.links.get(&key) {
        return Ok(id.clone());
    }
    let id = library.transfer_start(TransferDirection::Receive)?;
    library.transfer_update(
        &id,
        &TransferUpdate {
            peer: Some(ticket.addr.id.to_string()),
            ..Default::default()
        },
    )?;
    let dest = store_dir(&app)?.join("in").join(&id);
    let session_id = o
        .service
        .receive(ticket, dest.clone())
        .map_err(|_| err(ErrorCode::InvalidArgument, "expired"))?;
    lock(&state.receives).insert(id.clone(), ReceiveView::Connecting);
    let task = tauri::async_runtime::spawn(track_receive(
        app.clone(),
        Arc::clone(&state),
        Arc::clone(&library),
        Arc::clone(&o.service),
        session_id.clone(),
        id.clone(),
        dest,
    ));
    o.links.insert(key, id.clone());
    o.trackers.insert(id.clone(), task);
    o.sessions.insert(id.clone(), session_id);
    Ok(id)
}

/// Continues a receive that stopped (see `transfer_resumable`).
#[tauri::command]
#[specta::specta]
pub async fn transfer_resume<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
    id: String,
) -> CommandResult<()> {
    let row = library
        .transfer(&id)?
        .ok_or_else(|| err(ErrorCode::NotFound, "no such transfer"))?;
    let info = row
        .resume
        .as_deref()
        .and_then(ResumeInfo::decode)
        .ok_or_else(|| err(ErrorCode::InvalidArgument, "not resumable"))?;
    let mut open = state.open.lock().await;
    let o = open.as_mut().ok_or_else(not_open)?;
    if o.trackers
        .get(&id)
        .is_some_and(|t| !t.inner().is_finished())
    {
        return Ok(());
    }
    library.transfer_update(
        &id,
        &TransferUpdate {
            state: Some(TransferRowState::Active),
            ..Default::default()
        },
    )?;
    let dest = store_dir(&app)?.join("in").join(&id);
    let session = o.service.resume(info, dest.clone());
    lock(&state.receives).insert(id.clone(), ReceiveView::Connecting);
    let task = tauri::async_runtime::spawn(track_receive(
        app.clone(),
        Arc::clone(&state),
        Arc::clone(&library),
        Arc::clone(&o.service),
        session.clone(),
        id.clone(),
        dest,
    ));
    o.trackers.insert(id.clone(), task);
    o.sessions.insert(id, session);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn transfer_resumable(
    library: State<'_, Arc<Library>>,
) -> CommandResult<Vec<ResumableView>> {
    Ok(library
        .resumable_transfers()?
        .into_iter()
        .map(|r| ResumableView {
            id: r.id,
            doc_count: r.doc_count,
            total_bytes: r.total_bytes as f64,
            done_bytes: r.done_bytes as f64,
            updated_at: r.updated_at as f64,
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn transfer_receive_status(
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
    id: String,
) -> CommandResult<ReceiveView> {
    if let Some(v) = lock(&state.receives).get(&id) {
        return Ok(v.clone());
    }
    // Not tracked in this run (the app restarted): what the table says.
    let row = library
        .transfer(&id)?
        .ok_or_else(|| err(ErrorCode::NotFound, "no such transfer"))?;
    Ok(match row.state {
        TransferRowState::Done => ReceiveView::Done {
            document_ids: vec![],
            duplicates: 0,
        },
        TransferRowState::Active | TransferRowState::Interrupted if row.resume.is_some() => {
            ReceiveView::Paused {
                bytes: row.done_bytes as f64,
                total: row.total_bytes as f64,
            }
        }
        TransferRowState::Cancelled => ReceiveView::Failed {
            error: TransferErrorCode::Cancelled,
        },
        _ => ReceiveView::Failed {
            error: TransferErrorCode::Interrupted,
        },
    })
}

/// Stops a receive for good: nothing is added, partial data is dropped.
#[tauri::command]
#[specta::specta]
pub async fn transfer_cancel_receive<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<TransferState>>,
    library: State<'_, Arc<Library>>,
    id: String,
) -> CommandResult<()> {
    if let Some(o) = state.open.lock().await.as_mut() {
        if let Some(task) = o.trackers.remove(&id) {
            task.abort();
        }
        if let Some(session) = o.sessions.remove(&id) {
            o.service.cancel_receive(&session);
        }
    }
    lock(&state.receives).insert(
        id.clone(),
        ReceiveView::Failed {
            error: TransferErrorCode::Cancelled,
        },
    );
    if library.transfer(&id)?.is_some() {
        library.transfer_update(
            &id,
            &TransferUpdate {
                state: Some(TransferRowState::Cancelled),
                ..Default::default()
            },
        )?;
    }
    if let Ok(dir) = store_dir(&app) {
        let _ = std::fs::remove_dir_all(dir.join("in").join(&id));
    }
    maybe_close(&app, &state, &library).await;
    Ok(())
}

fn receive_view(s: &ReceiveState) -> ReceiveView {
    match s {
        ReceiveState::Connecting => ReceiveView::Connecting,
        ReceiveState::Confirm { code } => ReceiveView::Confirm { code: code.clone() },
        ReceiveState::Receiving {
            bytes,
            total,
            route,
        } => ReceiveView::Receiving {
            bytes: *bytes as f64,
            total: *total as f64,
            route: (*route).into(),
        },
        ReceiveState::Verifying => ReceiveView::Verifying,
        ReceiveState::Done { .. } => ReceiveView::Saving,
        ReceiveState::Failed { error } => ReceiveView::Failed {
            error: (*error).into(),
        },
    }
}

#[allow(clippy::too_many_arguments)]
async fn track_receive<R: Runtime>(
    app: AppHandle<R>,
    state: Arc<TransferState>,
    library: Arc<Library>,
    service: Arc<TransferService>,
    session: String,
    id: String,
    dest: PathBuf,
) {
    let mut resume_saved = false;
    let mut last_persist = Instant::now();
    loop {
        tokio::time::sleep(POLL).await;
        let Some(s) = service.receive_state(&session) else {
            return;
        };
        if !resume_saved && let Some(info) = service.resume_info(&session) {
            resume_saved = true;
            let _ = library.transfer_update(
                &id,
                &TransferUpdate {
                    resume: Some(Some(info.encode())),
                    ..Default::default()
                },
            );
        }
        match s {
            ReceiveState::Done { items } => {
                lock(&state.receives).insert(id.clone(), ReceiveView::Saving);
                let total: u64 = items.iter().map(|i| i.size).sum();
                let docs: Vec<ReceivedDocument> = items
                    .into_iter()
                    .map(|i| ReceivedDocument {
                        title: i.title,
                        current: ReceivedFile {
                            path: i.path,
                            blake3: i.blake3,
                            created_at: None,
                        },
                        history: i
                            .history
                            .into_iter()
                            .map(|v| ReceivedFile {
                                path: v.path,
                                blake3: v.blake3,
                                created_at: Some(v.created_at),
                            })
                            .collect(),
                    })
                    .collect();
                let lib = Arc::clone(&library);
                let imported = tauri::async_runtime::spawn_blocking(move || {
                    let mut ids = Vec::new();
                    let mut duplicates = 0u32;
                    for doc in &docs {
                        let out = lib.import_received(doc)?;
                        if out.duplicate {
                            duplicates += 1;
                        }
                        ids.push(out.document.id);
                    }
                    Ok::<_, selis_core::Error>((ids, duplicates, docs.len()))
                })
                .await;
                let _ = std::fs::remove_dir_all(&dest);
                let (view, update) = match imported {
                    Ok(Ok((document_ids, duplicates, count))) => (
                        ReceiveView::Done {
                            document_ids,
                            duplicates,
                        },
                        TransferUpdate {
                            state: Some(TransferRowState::Done),
                            doc_count: Some(u32::try_from(count).unwrap_or(u32::MAX)),
                            done_bytes: Some(total),
                            total_bytes: Some(total),
                            ..Default::default()
                        },
                    ),
                    _ => (
                        ReceiveView::Failed {
                            error: TransferErrorCode::Storage,
                        },
                        TransferUpdate {
                            state: Some(TransferRowState::Failed),
                            error: Some(error_name(TransferErrorCode::Storage)),
                            ..Default::default()
                        },
                    ),
                };
                let _ = library.transfer_update(&id, &update);
                lock(&state.receives).insert(id.clone(), view);
                break;
            }
            ReceiveState::Failed { error } => {
                let code = TransferErrorCode::from(error);
                // A broken connection after the sender confirmed can continue later.
                let resumable = resume_saved
                    && matches!(
                        code,
                        TransferErrorCode::Interrupted | TransferErrorCode::Unreachable
                    );
                let row = library.transfer(&id).ok().flatten();
                let (view, st) = if resumable {
                    let (bytes, total) = row
                        .as_ref()
                        .map(|r| (r.done_bytes as f64, r.total_bytes as f64))
                        .unwrap_or((0.0, 0.0));
                    (
                        ReceiveView::Paused { bytes, total },
                        TransferRowState::Interrupted,
                    )
                } else {
                    let _ = std::fs::remove_dir_all(&dest);
                    (
                        ReceiveView::Failed { error: code },
                        if code == TransferErrorCode::Cancelled {
                            TransferRowState::Cancelled
                        } else {
                            TransferRowState::Failed
                        },
                    )
                };
                let _ = library.transfer_update(
                    &id,
                    &TransferUpdate {
                        state: Some(st),
                        error: Some(error_name(code)),
                        ..Default::default()
                    },
                );
                lock(&state.receives).insert(id.clone(), view);
                break;
            }
            ref other => {
                let view = receive_view(other);
                if let ReceiveView::Receiving { bytes, total, .. } = &view
                    && last_persist.elapsed() >= PERSIST_EVERY
                {
                    last_persist = Instant::now();
                    let _ = library.transfer_update(
                        &id,
                        &TransferUpdate {
                            done_bytes: Some(*bytes as u64),
                            total_bytes: Some(*total as u64),
                            ..Default::default()
                        },
                    );
                }
                lock(&state.receives).insert(id.clone(), view);
            }
        }
    }
    maybe_close(&app, &state, &library).await;
}

/// Closes the endpoint if the screen asked for it and nothing runs any more.
async fn maybe_close<R: Runtime>(app: &AppHandle<R>, state: &TransferState, library: &Library) {
    if *lock(&state.close_requested) && !state.running() {
        close_now(app, state, library).await;
    }
}

/// Shows or updates the transfer notification (Android foreground service;
/// a no-op elsewhere). Texts come translated from the UI.
#[tauri::command]
#[specta::specta]
pub async fn transfer_foreground<R: Runtime>(
    app: AppHandle<R>,
    channel: String,
    title: String,
    text: String,
    progress: u32,
    max: u32,
) -> CommandResult<()> {
    #[cfg(target_os = "android")]
    android_call(
        &app,
        "foreground",
        serde_json::json!({ "channel": channel, "title": title, "text": text, "progress": progress, "max": max }),
    )
    .await;
    #[cfg(not(target_os = "android"))]
    let _ = (app, channel, title, text, progress, max);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn transfer_foreground_stop<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    #[cfg(target_os = "android")]
    android_call(&app, "stopForeground", serde_json::json!({})).await;
    #[cfg(not(target_os = "android"))]
    let _ = app;
    Ok(())
}

/// Debug builds only: all traffic through the relay (applies at the next open).
#[tauri::command]
#[specta::specta]
pub async fn transfer_debug_force_relay(
    state: State<'_, Arc<TransferState>>,
    on: bool,
) -> CommandResult<()> {
    #[cfg(debug_assertions)]
    {
        *lock(&state.force_relay) = on;
        Ok(())
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (state, on);
        Err(err(ErrorCode::Unsupported, "debug builds only"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn nothing_is_open_until_the_transfer_screen_opens_it() {
        let state = TransferState::default();
        assert!(!state.is_open().await);
        assert!(!state.running());
        assert!(state.service().await.is_err());
    }

    #[test]
    fn manifest_names_are_safe() {
        assert_eq!(sanitize_name("a/b\\c:d.pdf"), "a_b_c_d.pdf");
        assert_eq!(sanitize_name(".."), "document.pdf");
        assert_eq!(sanitize_name("  "), "document.pdf");
        assert_eq!(sanitize_name(&"x".repeat(300)).chars().count(), 200);
    }

    #[test]
    fn error_names_are_camel_case() {
        assert_eq!(error_name(TransferErrorCode::AlreadyUsed), "alreadyUsed");
        assert_eq!(error_name(TransferErrorCode::InvalidLink), "invalidLink");
    }
}
