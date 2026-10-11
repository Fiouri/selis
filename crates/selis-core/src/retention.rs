//! Version history retention (Settings → Storage): at most N versions per
//! document, and at most `history_limit_bytes` of older versions overall.
//!
//! The newest version of every document (its current content) is never
//! removed, and a stored file is deleted only once no version and no document
//! refers to it any more. Originals outside the library are never touched.

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::library::Library;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct RetentionPolicy {
    /// Versions kept per document, the current one included (at least 1).
    pub versions_per_document: u32,
    /// Bytes of older (non-current) versions kept across the library.
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub history_limit_bytes: u64,
}

impl Default for RetentionPolicy {
    /// 10 versions, 200 MB (docs/design/p1-ui-brief.md §6).
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

struct Victim {
    id: String,
    file_path: String,
    size: i64,
}

impl Library {
    /// Prunes the version history to `policy`. Idempotent.
    pub fn apply_retention(&self, policy: &RetentionPolicy) -> Result<RetentionReport> {
        let keep = i64::from(policy.versions_per_document.max(1));
        let limit = i64::try_from(policy.history_limit_bytes).unwrap_or(i64::MAX);
        let mut victims: Vec<Victim> = Vec::new();
        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            // 1) Per document: everything beyond the newest `keep` versions.
            {
                let mut stmt = tx.prepare(
                    "SELECT v.id, v.file_path, v.size_bytes FROM versions v
                      WHERE (SELECT COUNT(*) FROM versions w
                              WHERE w.document_id = v.document_id AND w.seq > v.seq) >= ?1",
                )?;
                let rows = stmt.query_map([keep], |r| {
                    Ok(Victim {
                        id: r.get(0)?,
                        file_path: r.get(1)?,
                        size: r.get(2)?,
                    })
                })?;
                for row in rows {
                    victims.push(row?);
                }
            }
            for v in &victims {
                tx.execute("DELETE FROM versions WHERE id = ?1", [&v.id])?;
            }
            // 2) Library-wide: the oldest older versions until the history fits.
            let older: Vec<Victim> = {
                let mut stmt = tx.prepare(
                    "SELECT v.id, v.file_path, v.size_bytes FROM versions v
                      WHERE v.seq < (SELECT MAX(w.seq) FROM versions w WHERE w.document_id = v.document_id)
                      ORDER BY v.created_at, v.seq, v.id",
                )?;
                stmt.query_map([], |r| {
                    Ok(Victim {
                        id: r.get(0)?,
                        file_path: r.get(1)?,
                        size: r.get(2)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
            };
            let mut total: i64 = older.iter().map(|v| v.size).sum();
            for v in older {
                if total <= limit {
                    break;
                }
                tx.execute("DELETE FROM versions WHERE id = ?1", [&v.id])?;
                total -= v.size;
                victims.push(v);
            }
            tx.commit()?;
        }

        let mut report = RetentionReport::default();
        for v in &victims {
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

    /// A document with `count` versions (seq 1..=count, 1 KB each, a file per version);
    /// the document points at the newest one, as after a save in P2.
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
    fn keeps_the_newest_versions_per_document() -> Result<()> {
        let (_dir, lib) = lib()?;
        let id = doc_with_versions(&lib, "a", 15)?;
        let policy = RetentionPolicy {
            versions_per_document: 10,
            history_limit_bytes: u64::MAX,
        };
        let report = lib.apply_retention(&policy)?;
        assert_eq!(report.removed_versions, 5);
        assert_eq!(seqs(&lib, &id)?, (6..=15).collect::<Vec<_>>());
        // Removed version files are gone; kept ones and the current file stay.
        assert!(!lib.resolve_location("library/a-v2.pdf")?.exists());
        assert!(lib.resolve_location("library/a-v6.pdf")?.exists());
        assert!(lib.resolve_location("library/a-v15.pdf")?.exists());
        assert_eq!(
            lib.apply_retention(&policy)?,
            RetentionReport::default(),
            "idempotent"
        );
        Ok(())
    }

    #[test]
    fn history_limit_drops_the_oldest_but_never_the_current_version() -> Result<()> {
        let (_dir, lib) = lib()?;
        let a = doc_with_versions(&lib, "a", 4)?;
        let b = doc_with_versions(&lib, "b", 3)?;
        // Older versions: a2, a3, b2 (1 KB each, oldest), a1 and b1 (the ~25 B imports).
        // 1.5 KB of history: a2 and b2 go (oldest first), a3 and the imports stay.
        let report = lib.apply_retention(&RetentionPolicy {
            versions_per_document: 50,
            history_limit_bytes: 1536,
        })?;
        assert_eq!(report.removed_versions, 2);
        assert_eq!(seqs(&lib, &a)?, [1, 3, 4]);
        assert_eq!(seqs(&lib, &b)?, [1, 3]);
        assert_eq!(seqs(&lib, &a)?.last(), Some(&4));
        assert_eq!(seqs(&lib, &b)?.last(), Some(&3));
        // Even a zero budget keeps every document's current version.
        lib.apply_retention(&RetentionPolicy {
            versions_per_document: 1,
            history_limit_bytes: 0,
        })?;
        assert_eq!(seqs(&lib, &a)?, [4]);
        assert_eq!(seqs(&lib, &b)?, [3]);
        assert!(lib.resolve_location("library/a-v4.pdf")?.exists());
        Ok(())
    }

    #[test]
    fn a_single_version_document_is_never_touched() -> Result<()> {
        let (_dir, lib) = lib()?;
        let bytes = b"%PDF-1.7\n% only\n%%EOF\n";
        let doc = lib.import_reader(bytes.as_slice(), "only")?.document;
        let report = lib.apply_retention(&RetentionPolicy {
            versions_per_document: 1,
            history_limit_bytes: 0,
        })?;
        assert_eq!(report, RetentionReport::default());
        assert!(std::path::Path::new(&lib.document_file(&doc.id)?.path).is_file());
        Ok(())
    }
}
