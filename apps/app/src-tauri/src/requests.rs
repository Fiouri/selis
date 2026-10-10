//! Results of long-running commands, kept per client request id
//! (docs/adr/0005-ipc-reliability.md).
//!
//! On Android the IPC reply of a command can be lost on its way back to the
//! WebView while the app resumes (Tauri 2.11 / wry 0.55; docs/spike-p0.md
//! "Known issues"). Every long-running command therefore runs through
//! [`RequestResults::run_once`]: the final result is stored under the caller's
//! request id, so the UI can fetch it with a fresh call (`take_result`), and a
//! repeated call with the same id returns that result instead of running the
//! work (a write) again.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde::de::DeserializeOwned;
use specta::Type;
use tokio::sync::watch;

use crate::commands::{CommandError, CommandResult, ErrorCode};

/// A finished result stays fetchable this long.
pub const RESULT_TTL: Duration = Duration::from_secs(5 * 60);
/// At most this many requests are remembered (running + finished).
pub const MAX_ENTRIES: usize = 64;
const MAX_REQUEST_ID_LEN: usize = 64;

/// A command's final result in the same shape the TypeScript bindings use for
/// `Result<T, CommandError>`.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum StoredResult {
    Ok {
        /// The command's own result type; the UI knows which command it called.
        #[specta(type = specta_typescript::Unknown)]
        data: serde_json::Value,
    },
    Error {
        error: CommandError,
    },
}

/// Answer of `take_result`.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum TakeResult {
    /// The command is still running.
    Pending,
    /// The command finished; this is what its reply carried.
    Done { result: StoredResult },
    /// Never seen (the call did not reach Rust) or already expired.
    Unknown,
}

enum Slot {
    Pending(watch::Sender<Option<StoredResult>>),
    Done { result: StoredResult, at: Instant },
}

struct Entry {
    command: &'static str,
    /// Insertion order, for evicting the oldest finished entry.
    seq: u64,
    slot: Slot,
}

#[derive(Default)]
struct Inner {
    entries: HashMap<String, Entry>,
    next_seq: u64,
}

enum Begin {
    Run,
    Done(StoredResult),
    Wait(watch::Receiver<Option<StoredResult>>),
}

/// Bounded, in-memory map request id → result (TTL [`RESULT_TTL`], at most
/// [`MAX_ENTRIES`]). Running requests are never evicted.
#[derive(Default)]
pub struct RequestResults {
    inner: Mutex<Inner>,
}

impl RequestResults {
    /// Runs `work` once per `request_id` and stores its result. A repeated call
    /// with the same id returns the stored result (or waits for the running
    /// one) without running `work`.
    pub async fn run_once<T, F>(
        &self,
        request_id: &str,
        command: &'static str,
        work: F,
    ) -> CommandResult<T>
    where
        T: Serialize + DeserializeOwned,
        F: Future<Output = CommandResult<T>>,
    {
        match self.begin(request_id, command, Instant::now())? {
            Begin::Done(stored) => stored.into_typed(),
            Begin::Wait(mut rx) => {
                let stored = rx
                    .wait_for(Option::is_some)
                    .await
                    .map_err(|_| internal("request ended without a result"))?
                    .clone();
                stored.map_or_else(
                    || Err(internal("request ended without a result")),
                    StoredResult::into_typed,
                )
            }
            Begin::Run => {
                // Stores an error if the work is dropped before it finishes, so
                // waiters and `take_result` never see "pending" forever.
                let mut guard = FinishGuard {
                    results: self,
                    request_id,
                    done: false,
                };
                let result = work.await;
                self.finish(
                    request_id,
                    StoredResult::from_result(&result),
                    Instant::now(),
                );
                guard.done = true;
                result
            }
        }
    }

    /// The state of `request_id`, without removing it (it stays until it
    /// expires, so a repeated call is still answered from the store).
    pub fn take(&self, request_id: &str) -> TakeResult {
        self.take_at(request_id, Instant::now())
    }

    fn take_at(&self, request_id: &str, now: Instant) -> TakeResult {
        let mut inner = self.lock();
        evict_expired(&mut inner, now);
        match inner.entries.get(request_id).map(|e| &e.slot) {
            Some(Slot::Pending(_)) => TakeResult::Pending,
            Some(Slot::Done { result, .. }) => TakeResult::Done {
                result: result.clone(),
            },
            None => TakeResult::Unknown,
        }
    }

    fn begin(&self, request_id: &str, command: &'static str, now: Instant) -> CommandResult<Begin> {
        validate_request_id(request_id)?;
        let mut inner = self.lock();
        evict_expired(&mut inner, now);
        if let Some(entry) = inner.entries.get(request_id) {
            if entry.command != command {
                return Err(CommandError::new(
                    ErrorCode::InvalidArgument,
                    format!("request id already used for {}", entry.command),
                ));
            }
            return Ok(match &entry.slot {
                Slot::Pending(tx) => Begin::Wait(tx.subscribe()),
                Slot::Done { result, .. } => Begin::Done(result.clone()),
            });
        }
        if inner.entries.len() >= MAX_ENTRIES && !evict_oldest_done(&mut inner) {
            return Err(internal("too many requests in flight"));
        }
        let seq = inner.next_seq;
        inner.next_seq += 1;
        let (tx, _) = watch::channel(None);
        inner.entries.insert(
            request_id.to_owned(),
            Entry {
                command,
                seq,
                slot: Slot::Pending(tx),
            },
        );
        Ok(Begin::Run)
    }

    fn finish(&self, request_id: &str, result: StoredResult, now: Instant) {
        let mut inner = self.lock();
        let Some(entry) = inner.entries.get_mut(request_id) else {
            return;
        };
        if let Slot::Pending(tx) = &entry.slot {
            tx.send_replace(Some(result.clone()));
            entry.slot = Slot::Done { result, at: now };
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

struct FinishGuard<'a> {
    results: &'a RequestResults,
    request_id: &'a str,
    done: bool,
}

impl Drop for FinishGuard<'_> {
    fn drop(&mut self) {
        if !self.done {
            self.results.finish(
                self.request_id,
                StoredResult::Error {
                    error: internal("request was interrupted"),
                },
                Instant::now(),
            );
        }
    }
}

impl StoredResult {
    fn from_result<T: Serialize>(result: &CommandResult<T>) -> Self {
        match result {
            Ok(value) => match serde_json::to_value(value) {
                Ok(data) => Self::Ok { data },
                Err(e) => Self::Error {
                    error: internal(format!("cannot store result: {e}")),
                },
            },
            Err(error) => Self::Error {
                error: error.clone(),
            },
        }
    }

    fn into_typed<T: DeserializeOwned>(self) -> CommandResult<T> {
        match self {
            Self::Ok { data } => serde_json::from_value(data)
                .map_err(|e| internal(format!("cannot read stored result: {e}"))),
            Self::Error { error } => Err(error),
        }
    }
}

fn evict_expired(inner: &mut Inner, now: Instant) {
    inner.entries.retain(|_, entry| match entry.slot {
        Slot::Pending(_) => true,
        Slot::Done { at, .. } => now.saturating_duration_since(at) < RESULT_TTL,
    });
}

fn evict_oldest_done(inner: &mut Inner) -> bool {
    let oldest = inner
        .entries
        .iter()
        .filter(|(_, e)| matches!(e.slot, Slot::Done { .. }))
        .min_by_key(|(_, e)| e.seq)
        .map(|(id, _)| id.clone());
    oldest.is_some_and(|id| inner.entries.remove(&id).is_some())
}

fn validate_request_id(request_id: &str) -> CommandResult<()> {
    let valid = !request_id.is_empty()
        && request_id.len() <= MAX_REQUEST_ID_LEN
        && request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if valid {
        Ok(())
    } else {
        Err(CommandError::new(
            ErrorCode::InvalidArgument,
            "invalid request id",
        ))
    }
}

fn internal(message: impl Into<String>) -> CommandError {
    CommandError::new(ErrorCode::Internal, message)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    fn done_value(result: &TakeResult) -> Option<serde_json::Value> {
        match result {
            TakeResult::Done {
                result: StoredResult::Ok { data },
            } => Some(data.clone()),
            _ => None,
        }
    }

    #[tokio::test]
    async fn stores_the_result_and_answers_take() {
        let store = RequestResults::default();
        assert!(matches!(store.take("r1"), TakeResult::Unknown));
        let out: CommandResult<u32> = store.run_once("r1", "cmd", async { Ok(7) }).await;
        assert_eq!(out.ok(), Some(7));
        assert_eq!(done_value(&store.take("r1")), Some(serde_json::json!(7)));
        // `take` does not consume: the result stays for duplicates.
        assert_eq!(done_value(&store.take("r1")), Some(serde_json::json!(7)));
    }

    #[tokio::test]
    async fn stores_errors_too() {
        let store = RequestResults::default();
        let out: CommandResult<u32> = store
            .run_once("r1", "cmd", async {
                Err(CommandError::new(ErrorCode::NotPdf, "x"))
            })
            .await;
        assert!(out.is_err());
        assert!(matches!(
            store.take("r1"),
            TakeResult::Done {
                result: StoredResult::Error { error }
            } if matches!(error.code, ErrorCode::NotPdf)
        ));
    }

    #[tokio::test]
    async fn a_duplicate_request_never_runs_the_work_again() {
        let store = RequestResults::default();
        let runs = AtomicUsize::new(0);
        let work = || async {
            runs.fetch_add(1, Ordering::SeqCst);
            Ok::<_, CommandError>(String::from("written"))
        };
        let first = store.run_once("r1", "import", work()).await;
        let second = store.run_once("r1", "import", work()).await;
        assert_eq!(first.ok().as_deref(), Some("written"));
        assert_eq!(second.ok().as_deref(), Some("written"));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_duplicate_of_a_running_request_waits_for_its_result() {
        let store = RequestResults::default();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let runs = AtomicUsize::new(0);
        let first = store.run_once("r1", "import", async {
            runs.fetch_add(1, Ordering::SeqCst);
            release_rx.await.ok();
            Ok::<_, CommandError>(1_u32)
        });
        let second = async {
            tokio::task::yield_now().await;
            assert!(matches!(store.take("r1"), TakeResult::Pending));
            let duplicate = store.run_once("r1", "import", async {
                runs.fetch_add(1, Ordering::SeqCst);
                Ok::<_, CommandError>(2_u32)
            });
            release_tx.send(()).ok();
            duplicate.await
        };
        let (a, b) = tokio::join!(first, second);
        assert_eq!(a.ok(), Some(1));
        assert_eq!(b.ok(), Some(1));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn interrupted_work_stores_an_error_instead_of_staying_pending() {
        let store = RequestResults::default();
        {
            let fut = store.run_once("r1", "cmd", std::future::pending::<CommandResult<u32>>());
            tokio::pin!(fut);
            // Poll once so the request is registered, then drop it.
            let _ = futures_poll_once(fut.as_mut()).await;
        }
        assert!(matches!(
            store.take("r1"),
            TakeResult::Done {
                result: StoredResult::Error { .. }
            }
        ));
    }

    async fn futures_poll_once<F: Future + Unpin>(fut: F) -> Option<F::Output> {
        tokio::select! {
            biased;
            out = fut => Some(out),
            () = std::future::ready(()) => None,
        }
    }

    #[test]
    fn finished_results_expire_after_the_ttl() {
        let store = RequestResults::default();
        let t0 = Instant::now();
        assert!(matches!(store.begin("r1", "cmd", t0), Ok(Begin::Run)));
        store.finish("r1", StoredResult::Ok { data: 1.into() }, t0);
        let just_before = t0 + RESULT_TTL - Duration::from_secs(1);
        assert!(done_value(&store.take_at("r1", just_before)).is_some());
        assert!(matches!(
            store.take_at("r1", t0 + RESULT_TTL),
            TakeResult::Unknown
        ));
    }

    #[test]
    fn running_requests_do_not_expire() {
        let store = RequestResults::default();
        let t0 = Instant::now();
        assert!(matches!(store.begin("r1", "cmd", t0), Ok(Begin::Run)));
        let later = t0 + RESULT_TTL * 10;
        assert!(matches!(store.take_at("r1", later), TakeResult::Pending));
    }

    #[test]
    fn evicts_the_oldest_finished_entry_when_full() {
        let store = RequestResults::default();
        let t0 = Instant::now();
        for i in 0..MAX_ENTRIES {
            let id = format!("r{i}");
            assert!(matches!(store.begin(&id, "cmd", t0), Ok(Begin::Run)));
            store.finish(&id, StoredResult::Ok { data: i.into() }, t0);
        }
        assert!(matches!(store.begin("new", "cmd", t0), Ok(Begin::Run)));
        assert!(matches!(store.take_at("r0", t0), TakeResult::Unknown));
        assert!(done_value(&store.take_at("r1", t0)).is_some());
        assert_eq!(store.lock().entries.len(), MAX_ENTRIES);
    }

    #[test]
    fn refuses_new_requests_when_full_of_running_ones() {
        let store = RequestResults::default();
        let t0 = Instant::now();
        for i in 0..MAX_ENTRIES {
            assert!(matches!(
                store.begin(&format!("r{i}"), "cmd", t0),
                Ok(Begin::Run)
            ));
        }
        assert!(store.begin("one-more", "cmd", t0).is_err());
    }

    #[test]
    fn rejects_bad_or_reused_request_ids() {
        let store = RequestResults::default();
        let t0 = Instant::now();
        assert!(store.begin("", "cmd", t0).is_err());
        assert!(store.begin("has space", "cmd", t0).is_err());
        assert!(store.begin(&"x".repeat(65), "cmd", t0).is_err());
        assert!(matches!(store.begin("r1", "import", t0), Ok(Begin::Run)));
        assert!(store.begin("r1", "pick", t0).is_err());
    }
}
