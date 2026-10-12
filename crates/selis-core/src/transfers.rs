//! The `transfers` table (P3, ADR 0010): what was sent and received, and the
//! receives that can still be resumed after the app was stopped mid-way.

use std::path::PathBuf;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{Error, Result},
    library::{Library, now_ms},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum TransferDirection {
    Send,
    Receive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum TransferRowState {
    Active,
    Interrupted,
    Done,
    Failed,
    Cancelled,
}

impl TransferDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Send => "send",
            Self::Receive => "receive",
        }
    }

    fn parse(s: &str) -> Result<Self> {
        match s {
            "send" => Ok(Self::Send),
            "receive" => Ok(Self::Receive),
            _ => Err(Error::InvalidArgument("transfer direction")),
        }
    }
}

impl TransferRowState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Interrupted => "interrupted",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    fn parse(s: &str) -> Result<Self> {
        match s {
            "active" => Ok(Self::Active),
            "interrupted" => Ok(Self::Interrupted),
            "done" => Ok(Self::Done),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(Error::InvalidArgument("transfer state")),
        }
    }

    fn finished(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct TransferRow {
    pub id: String,
    pub direction: TransferDirection,
    pub state: TransferRowState,
    pub peer: Option<String>,
    pub doc_count: u32,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub total_bytes: u64,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub done_bytes: u64,
    /// Opaque resume token (receive only, while resumable).
    pub resume: Option<String>,
    pub error: Option<String>,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub created_at: i64,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub updated_at: i64,
}

/// Fields an update may change (`None` = keep).
#[derive(Debug, Clone, Default)]
pub struct TransferUpdate {
    pub state: Option<TransferRowState>,
    pub peer: Option<String>,
    pub doc_count: Option<u32>,
    pub total_bytes: Option<u64>,
    pub done_bytes: Option<u64>,
    /// `Some(None)` clears it.
    pub resume: Option<Option<String>>,
    pub error: Option<String>,
}

/// A document as offered to another device: its current file and, on request,
/// the earlier versions kept in the library (oldest first).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outgoing {
    pub title: String,
    pub current: PathBuf,
    /// (file, created_at unix ms)
    pub history: Vec<(PathBuf, i64)>,
}

fn i64_of(n: u64) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

const COLUMNS: &str = "id, direction, state, peer, doc_count, total_bytes, done_bytes, resume, error, created_at, updated_at";

type RawRow = (TransferRow, String, String);

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RawRow> {
    Ok((
        TransferRow {
            id: r.get(0)?,
            direction: TransferDirection::Send,
            state: TransferRowState::Active,
            peer: r.get(3)?,
            doc_count: u32::try_from(r.get::<_, i64>(4)?).unwrap_or(0),
            total_bytes: u64::try_from(r.get::<_, i64>(5)?).unwrap_or(0),
            done_bytes: u64::try_from(r.get::<_, i64>(6)?).unwrap_or(0),
            resume: r.get(7)?,
            error: r.get(8)?,
            created_at: r.get(9)?,
            updated_at: r.get(10)?,
        },
        r.get(1)?,
        r.get(2)?,
    ))
}

fn finish_row((mut t, direction, state): RawRow) -> Result<TransferRow> {
    t.direction = TransferDirection::parse(&direction)?;
    t.state = TransferRowState::parse(&state)?;
    Ok(t)
}

impl Library {
    /// Starts a transfer row (state active); returns its id.
    pub fn transfer_start(&self, direction: TransferDirection) -> Result<String> {
        let id = Uuid::now_v7().to_string();
        let now = now_ms();
        self.conn().execute(
            "INSERT INTO transfers (id, direction, state, created_at, updated_at) VALUES (?1, ?2, 'active', ?3, ?3)",
            params![id, direction.as_str(), now],
        )?;
        Ok(id)
    }

    /// Applies `update`. A finished transfer always drops its resume token.
    pub fn transfer_update(&self, id: &str, update: &TransferUpdate) -> Result<()> {
        let mut t = self
            .transfer(id)?
            .ok_or_else(|| Error::NotFound(id.to_owned()))?;
        if let Some(s) = update.state {
            t.state = s;
        }
        if let Some(p) = &update.peer {
            t.peer = Some(p.clone());
        }
        if let Some(n) = update.doc_count {
            t.doc_count = n;
        }
        if let Some(n) = update.total_bytes {
            t.total_bytes = n;
        }
        if let Some(n) = update.done_bytes {
            t.done_bytes = n;
        }
        if let Some(r) = &update.resume {
            t.resume = r.clone();
        }
        if let Some(e) = &update.error {
            t.error = Some(e.clone());
        }
        if t.state.finished() {
            t.resume = None;
        }
        self.conn().execute(
            "UPDATE transfers SET state = ?2, peer = ?3, doc_count = ?4, total_bytes = ?5, done_bytes = ?6,
                 resume = ?7, error = ?8, updated_at = ?9 WHERE id = ?1",
            params![
                id,
                t.state.as_str(),
                t.peer,
                t.doc_count,
                i64_of(t.total_bytes),
                i64_of(t.done_bytes),
                t.resume,
                t.error,
                now_ms()
            ],
        )?;
        Ok(())
    }

    pub fn transfer(&self, id: &str) -> Result<Option<TransferRow>> {
        let found = self
            .conn()
            .query_row(
                &format!("SELECT {COLUMNS} FROM transfers WHERE id = ?1"),
                [id],
                row,
            )
            .optional()?;
        found.map(finish_row).transpose()
    }

    /// Receives that stopped mid-way and can continue, newest first.
    pub fn resumable_transfers(&self) -> Result<Vec<TransferRow>> {
        let rows = {
            let conn = self.conn();
            let mut stmt = conn.prepare(&format!(
                "SELECT {COLUMNS} FROM transfers WHERE resume IS NOT NULL AND state IN ('active', 'interrupted')
                 ORDER BY updated_at DESC"
            ))?;
            stmt.query_map([], row)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        rows.into_iter().map(finish_row).collect()
    }

    /// What sending document `id` means: its current file and, with `history`,
    /// its earlier library versions (a linked document's external original is
    /// not part of the library and is not sent).
    pub fn outgoing(&self, id: &str, history: bool) -> Result<Outgoing> {
        let file = self.document_file(id)?;
        let current = PathBuf::from(&file.path);
        let mut earlier = Vec::new();
        if history {
            let rows: Vec<(String, i64)> = {
                let conn = self.conn();
                let mut stmt = conn.prepare(
                    "SELECT file_path, created_at FROM versions
                      WHERE document_id = ?1 AND file_path LIKE 'library/%' ORDER BY seq",
                )?;
                stmt.query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<rusqlite::Result<_>>()?
            };
            for (location, created_at) in rows {
                let path = self.resolve_location(&location)?;
                // The current file is sent as the document itself; a version
                // file gone missing is skipped rather than failing the send.
                if path != current && path.is_file() && !earlier.iter().any(|(p, _)| p == &path) {
                    earlier.push((path, created_at));
                }
            }
        }
        Ok(Outgoing {
            title: file.document.title,
            current,
            history: earlier,
        })
    }

    /// Marks transfers a previous run left "active" (the process died) as interrupted.
    pub fn transfers_mark_interrupted(&self) -> Result<usize> {
        Ok(self.conn().execute(
            "UPDATE transfers SET state = 'interrupted', updated_at = ?1 WHERE state = 'active'",
            [now_ms()],
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_receive_stays_resumable_until_it_finishes() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let lib = Library::open(dir.path().join("lib"))?;
        let id = lib.transfer_start(TransferDirection::Receive)?;
        lib.transfer_update(
            &id,
            &TransferUpdate {
                resume: Some(Some("tok".into())),
                total_bytes: Some(200),
                done_bytes: Some(50),
                doc_count: Some(2),
                peer: Some("abc".into()),
                ..Default::default()
            },
        )?;
        // The app dies; the next start marks it interrupted, still resumable.
        assert_eq!(lib.transfers_mark_interrupted()?, 1);
        let r = lib.resumable_transfers()?;
        assert_eq!(r.len(), 1);
        assert_eq!(
            (r[0].state, r[0].done_bytes, r[0].resume.as_deref()),
            (TransferRowState::Interrupted, 50, Some("tok"))
        );
        lib.transfer_update(
            &id,
            &TransferUpdate {
                state: Some(TransferRowState::Done),
                done_bytes: Some(200),
                ..Default::default()
            },
        )?;
        assert!(lib.resumable_transfers()?.is_empty());
        let t = lib
            .transfer(&id)?
            .ok_or_else(|| Error::NotFound(id.clone()))?;
        assert_eq!((t.state, t.resume), (TransferRowState::Done, None));
        assert!(lib.transfer("nope")?.is_none());
        Ok(())
    }

    #[test]
    fn outgoing_sends_the_current_file_and_optionally_its_history() -> Result<()> {
        use crate::received::{ReceivedDocument, ReceivedFile};
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let lib = Library::open(dir.path().join("lib"))?;
        let mut files = Vec::new();
        for (name, created_at) in [("v1", Some(3)), ("v2", None)] {
            let bytes = format!(
                "%PDF-1.7
% {name}
%%EOF
"
            )
            .into_bytes();
            let path = dir.path().join(name);
            std::fs::write(&path, &bytes).map_err(|e| Error::io(&path, e))?;
            files.push(ReceivedFile {
                path,
                blake3: blake3::hash(&bytes).to_hex().to_string(),
                created_at,
            });
        }
        let current = files.pop().ok_or_else(|| Error::NotFound("v2".into()))?;
        let doc = lib
            .import_received(&ReceivedDocument {
                title: "T".into(),
                current,
                history: files,
            })?
            .document;
        let plain = lib.outgoing(&doc.id, false)?;
        assert!(plain.history.is_empty() && plain.current.is_file());
        assert_eq!(plain.title, "T");
        let full = lib.outgoing(&doc.id, true)?;
        assert_eq!(full.history.len(), 1);
        assert_eq!(full.history[0].1, 3);
        assert_ne!(full.history[0].0, full.current);
        assert!(lib.outgoing("missing", true).is_err());
        Ok(())
    }
}
