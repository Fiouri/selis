//! Documents received over a transfer (P3, ADR 0010): each becomes a library
//! document with origin "received", its versions labelled "received", the
//! history first (oldest first) and the received file as the current version.
//!
//! The files are copied into the library while their BLAKE3 is computed again,
//! and a mismatch with what the manifest promised refuses the document: the
//! transfer already verified every chunk, this guards the hand-over from the
//! transfer store. All rows go in one transaction; files copied before a failed
//! one are swept at the next start (`Library::sweep_orphans`).

use std::{fs::File, path::PathBuf};

use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{Error, Result},
    fsutil::HashedTempFile,
    library::{FILES_DIR, ImportOutcome, Library, looks_like_pdf, now_ms, sanitize_title},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ReceivedFile {
    pub path: PathBuf,
    /// BLAKE3 the sender's manifest gave (lowercase hex).
    pub blake3: String,
    /// When the sender saved this version (unix ms), if it is history.
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ReceivedDocument {
    pub title: String,
    pub current: ReceivedFile,
    /// Earlier versions, oldest first.
    pub history: Vec<ReceivedFile>,
}

impl Library {
    /// Adds a received document. A document whose current file is already in
    /// the library is returned as a duplicate (nothing is added).
    pub fn import_received(&self, doc: &ReceivedDocument) -> Result<ImportOutcome> {
        if let Some(existing) = self.find_imported_by_hash(&doc.current.blake3)? {
            return Ok(ImportOutcome {
                document: existing,
                duplicate: true,
            });
        }
        // Copy every file in (content addressed, so a repeat is harmless), checking its hash.
        let mut stored = Vec::new();
        for file in doc.history.iter().chain(std::iter::once(&doc.current)) {
            stored.push((self.store_received(file)?, file.created_at));
        }

        let now = now_ms();
        let id = Uuid::now_v7().to_string();
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let (current_location, current_hash, current_size) = stored
            .last()
            .map(|((l, h, s), _)| (l.clone(), h.clone(), *s))
            .ok_or(Error::InvalidArgument("nothing received"))?;
        tx.execute(
            "INSERT INTO documents
                (id, title, kind, location, blake3, size_bytes, page_count,
                 created_at, modified_at, last_opened_at, favorite, origin)
             VALUES (?1, ?2, 'imported', ?3, ?4, ?5, NULL, ?6, ?6, NULL, 0, 'received')",
            params![
                id,
                sanitize_title(&doc.title),
                current_location,
                current_hash,
                current_size,
                now
            ],
        )?;
        for (seq, ((location, hash, size), created_at)) in stored.iter().enumerate() {
            tx.execute(
                "INSERT INTO versions (id, document_id, seq, blake3, size_bytes, created_at, label, file_path)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'received', ?7)",
                params![
                    Uuid::now_v7().to_string(),
                    id,
                    i64::try_from(seq + 1).unwrap_or(i64::MAX),
                    hash,
                    size,
                    created_at.unwrap_or(now),
                    location
                ],
            )?;
        }
        tx.commit()?;
        let document = self.get_locked(&conn, &id)?;
        Ok(ImportOutcome {
            document,
            duplicate: false,
        })
    }

    /// Copies a received file into the library under its hash; returns (location, hash, size).
    fn store_received(&self, file: &ReceivedFile) -> Result<(String, String, i64)> {
        let files = self.files_dir();
        // Already in the library (the transfer skipped it, or a repeat): the
        // library's copy was verified when it came in.
        if let Some(existing) = self.file_with_hash(&file.blake3) {
            let size = std::fs::metadata(&existing)
                .map_err(|e| Error::io(&existing, e))?
                .len();
            let size = i64::try_from(size).map_err(|_| Error::InvalidArgument("file too large"))?;
            let hash = file.blake3.to_ascii_lowercase();
            return Ok((format!("{FILES_DIR}/{hash}.pdf"), hash, size));
        }
        let reader = File::open(&file.path).map_err(|e| Error::io(&file.path, e))?;
        let tmp = HashedTempFile::from_reader(&files, reader)?;
        if tmp.size_bytes == 0 {
            return Err(Error::EmptyFile);
        }
        if !looks_like_pdf(&tmp.head) {
            return Err(Error::NotPdf);
        }
        let hash = tmp.hash.to_hex();
        if hash != file.blake3.to_ascii_lowercase() {
            return Err(Error::InvalidArgument(
                "received file does not match its hash",
            ));
        }
        let size =
            i64::try_from(tmp.size_bytes).map_err(|_| Error::InvalidArgument("file too large"))?;
        let name = format!("{hash}.pdf");
        let dest = files.join(&name);
        if !dest.exists() {
            tmp.persist(&dest)?;
        }
        Ok((format!("{FILES_DIR}/{name}"), hash, size))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::LibraryQuery;

    fn pdf(marker: &str) -> Vec<u8> {
        format!("%PDF-1.7\n% {marker}\n%%EOF\n").into_bytes()
    }

    fn file(
        dir: &std::path::Path,
        name: &str,
        bytes: &[u8],
        created_at: Option<i64>,
    ) -> ReceivedFile {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap_or_default();
        ReceivedFile {
            path,
            blake3: blake3::hash(bytes).to_hex().to_string(),
            created_at,
        }
    }

    #[test]
    fn adds_the_document_with_its_history_labelled_received() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let lib = Library::open(dir.path().join("lib"))?;
        let doc = ReceivedDocument {
            title: "Συμβόλαιο".into(),
            history: vec![file(dir.path(), "v1", &pdf("v1"), Some(5))],
            current: file(dir.path(), "v2", &pdf("v2"), None),
        };
        let out = lib.import_received(&doc)?;
        assert!(!out.duplicate);
        assert_eq!(out.document.title, "Συμβόλαιο");
        let rows: Vec<(i64, String, i64)> = lib
            .conn()
            .prepare(
                "SELECT seq, label, created_at FROM versions WHERE document_id = ?1 ORDER BY seq",
            )?
            .query_map([&out.document.id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        assert_eq!(rows.len(), 2);
        assert_eq!(
            (rows[0].0, rows[0].1.as_str(), rows[0].2),
            (1, "received", 5)
        );
        assert_eq!(rows[1].1, "received");
        let origin: String = lib.conn().query_row(
            "SELECT origin FROM documents WHERE id = ?1",
            [&out.document.id],
            |r| r.get(0),
        )?;
        assert_eq!(origin, "received");
        // The same document again: a duplicate, nothing added.
        assert!(lib.import_received(&doc)?.duplicate);
        assert_eq!(lib.list_documents(&LibraryQuery::default())?.len(), 1);
        Ok(())
    }

    #[test]
    fn refuses_a_file_that_does_not_match_its_hash_and_adds_nothing() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let lib = Library::open(dir.path().join("lib"))?;
        let mut current = file(dir.path(), "c", &pdf("c"), None);
        current.blake3 = blake3::hash(b"something else").to_hex().to_string();
        let doc = ReceivedDocument {
            title: "x".into(),
            current,
            history: vec![],
        };
        assert!(lib.import_received(&doc).is_err());
        assert!(lib.list_documents(&LibraryQuery::default())?.is_empty());
        Ok(())
    }
}
