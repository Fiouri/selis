//! Version history retention (docs/SPEC.md "Data model": "the last 10 or up to
//! 200 MB per document, configurable; v1 is never deleted automatically").
//!
//! Per document, versions are pruned oldest first until both limits hold. Two
//! versions are never removed: v1 (the imported original) and the newest one
//! (the current content). A stored file is deleted only once no version and no
//! document refers to it any more. Originals outside the library are never touched.

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::library::Library;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct RetentionPolicy {
    /// Versions kept per document, v1 and the current one included (at least 2).
    pub versions_per_document: u32,
    /// Bytes of history per document: versions other than v1 and the current one.
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub history_limit_bytes: u64,
}

impl Default for RetentionPolicy {
    /// 10 versions, 200 MB (docs/SPEC.md; docs/design/p1-ui-brief.md §6).
    fn default() -> Self {
        Self {
            versions_per_document: 10,
            history_limit_bytes: 200 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RetentionReport {
    pub removed_versions: u32,
    pub freed_bytes: u64,
}

#[derive(Clone)]
struct Candidate {
    id: String,
    document_id: String,
    file_path: String,
    size: i64,
}

impl Library {
    /// Prunes the version history of every document to `policy`. Idempotent.
    pub fn apply_retention(&self, policy: &RetentionPolicy) -> Result<RetentionReport> {
        let keep = usize::try_from(policy.versions_per_document.max(2)).unwrap_or(usize::MAX);
        let limit = i64::try_from(policy.history_limit_bytes).unwrap_or(i64::MAX);
        let mut removed: Vec<Candidate> = Vec::new();
        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            // Prunable versions: not v1, not the newest of their document; oldest first.
            let candidates: Vec<Candidate> = {
                let mut stmt = tx.prepare(
                    "SELECT v.id, v.document_id, v.file_path, v.size_bytes FROM versions v
                      WHERE v.seq > 1
                        AND v.seq < (SELECT MAX(w.seq) FROM versions w WHERE w.document_id = v.document_id)
                      ORDER BY v.document_id, v.seq",
                )?;
                stmt.query_map([], |r| {
                    Ok(Candidate {
                        id: r.get(0)?,
                        document_id: r.get(1)?,
                        file_path: r.get(2)?,
                        size: r.get(3)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
            };
            for group in candidates.chunk_by(|a, b| a.document_id == b.document_id) {
                // v1 + the current version are always there on top of the group.
                let mut count = group.len() + 2;
                let mut bytes: i64 = group.iter().map(|c| c.size).sum();
                for c in group {
                    if count <= keep && bytes <= limit {
                        break;
                    }
                    tx.execute("DELETE FROM versions WHERE id = ?1", [&c.id])?;
                    count -= 1;
                    bytes -= c.size;
                    removed.push(c.clone());
                }
            }
            tx.commit()?;
        }

        let mut report = RetentionReport::default();
        for v in &removed {
            report.removed_versions += 1;
            report.freed_bytes += u64::try_from(v.size).unwrap_or(0);
            self.remove_if_unreferenced(&v.file_path)?;
        }
        Ok(report)
    }

    /// Deletes a library file once no version and no document points at it.
    fn remove_if_unreferenced(&self, location: &str) -> Result<()> {
        let referenced: i64 = self.conn().query_row(
            "SELECT (SELECT COUNT(*) FROM versions WHERE file_path = ?1)
                  + (SELECT COUNT(*) FROM documents WHERE location = ?1)",
            params![location],
            |r| r.get(0),
        )?;
        if referenced == 0
            && let Ok(path) = self.resolve_location(location)
        {
            // Already gone is fine: the row was the only thing that mattered.
            let _ = std::fs::remove_file(path);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;

    /// A document with `count` versions (v1 = the import, then 1 KB files); the
    /// document points at the newest one, as after a save in P2.
    fn doc_with_versions(lib: &Library, marker: &str, count: i64) -> Result<String> {
        let bytes = format!("%PDF-1.7\n% {marker}\n%%EOF\n");
        let id = lib.import_reader(bytes.as_bytes(), marker)?.document.id;
        let conn = lib.conn();
        for seq in 2..=count {
            let rel = format!("library/{marker}-v{seq}.pdf");
            let path = lib.resolve_location(&rel)?;
            std::fs::write(&path, vec![b'x'; 1024]).map_err(|e| Error::io(&path, e))?;
            conn.execute(
                "INSERT INTO versions (id, document_id, seq, blake3, size_bytes, created_at, label, file_path)
                 VALUES (?1, ?2, ?3, ?4, 1024, ?3, 'auto', ?5)",
                params![format!("{marker}-{seq}"), id, seq, format!("h{seq}"), rel],
            )?;
            conn.execute(
                "UPDATE documents SET location = ?2 WHERE id = ?1",
                params![id, rel],
            )?;
        }
        Ok(id)
    }

    fn seqs(lib: &Library, id: &str) -> Result<Vec<i64>> {
        let conn = lib.conn();
        let mut stmt =
            conn.prepare("SELECT seq FROM versions WHERE document_id = ?1 ORDER BY seq")?;
        Ok(stmt
            .query_map([id], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn lib() -> Result<(tempfile::TempDir, Library)> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let lib = Library::open(dir.path())?;
        Ok((dir, lib))
    }

    #[test]
    fn keeps_v1_and_the_newest_versions() -> Result<()> {
        let (_dir, lib) = lib()?;
        let id = doc_with_versions(&lib, "a", 15)?;
        let policy = RetentionPolicy {
            versions_per_document: 10,
            history_limit_bytes: u64::MAX,
        };
        let report = lib.apply_retention(&policy)?;
        assert_eq!(report.removed_versions, 5);
        assert_eq!(seqs(&lib, &id)?, [1, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        // Removed version files are gone; kept ones and the current file stay.
        assert!(!lib.resolve_location("library/a-v2.pdf")?.exists());
        assert!(lib.resolve_location("library/a-v7.pdf")?.exists());
        assert!(lib.resolve_location("library/a-v15.pdf")?.exists());
        assert_eq!(
            lib.apply_retention(&policy)?,
            RetentionReport::default(),
            "idempotent"
        );
        Ok(())
    }

    #[test]
    fn history_limit_is_per_document_and_spares_v1_and_current() -> Result<()> {
        let (_dir, lib) = lib()?;
        let a = doc_with_versions(&lib, "a", 6)?; // history: v2..v5 = 4 KB
        let b = doc_with_versions(&lib, "b", 3)?; // history: v2 = 1 KB
        let report = lib.apply_retention(&RetentionPolicy {
            versions_per_document: 50,
            history_limit_bytes: 2048,
        })?;
        assert_eq!(report.removed_versions, 2);
        assert_eq!(seqs(&lib, &a)?, [1, 4, 5, 6]);
        assert_eq!(seqs(&lib, &b)?, [1, 2, 3], "b is under its own limit");

        // Even a zero budget keeps v1 and the current version of every document.
        lib.apply_retention(&RetentionPolicy {
            versions_per_document: 2,
            history_limit_bytes: 0,
        })?;
        assert_eq!(seqs(&lib, &a)?, [1, 6]);
        assert_eq!(seqs(&lib, &b)?, [1, 3]);
        let v1: String = lib.conn().query_row(
            "SELECT file_path FROM versions WHERE document_id = ?1 AND seq = 1",
            [&a],
            |r| r.get(0),
        )?;
        assert!(lib.resolve_location(&v1)?.exists());
        assert!(lib.resolve_location("library/a-v6.pdf")?.exists());
        Ok(())
    }

    #[test]
    fn a_single_version_document_is_never_touched() -> Result<()> {
        let (_dir, lib) = lib()?;
        let bytes = b"%PDF-1.7\n% only\n%%EOF\n";
        let doc = lib.import_reader(bytes.as_slice(), "only")?.document;
        let report = lib.apply_retention(&RetentionPolicy {
            versions_per_document: 2,
            history_limit_bytes: 0,
        })?;
        assert_eq!(report, RetentionReport::default());
        assert!(std::path::Path::new(&lib.document_file(&doc.id)?.path).is_file());
        Ok(())
    }
}
