//! The `transfers` table (P3, ADR 0010): what was sent and received, and the
//! receives that can still be resumed after the app was stopped mid-way.

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
    #[cfg_attr(feature = "specta", specta(type = f64))]
    pub total_bytes: u64,
    #[cfg_attr(feature = "specta", specta(type = f64))]
    pub done_bytes: u64,
    /// Opaque resume token (receive only, while resumable).
    pub resume: Option<String>,
    pub error: Option<String>,
    #[cfg_attr(feature = "specta", specta(type = f64))]
    pub created_at: i64,
    #[cfg_attr(feature = "specta", specta(type = f64))]
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
}
