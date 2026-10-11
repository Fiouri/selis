//! Removing a document from the library.
//!
//! The rows go first, in one transaction (document, versions, tags); the files
//! are removed only after the commit, so a failure never leaves a row that
//! points at a missing file. Files are removed only when nothing references
//! them any more, and only inside the library's own directories: a linked
//! document's external file is never touched.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::library::Library;

/// Directories (relative to the library root) whose files the library owns.
const OWNED_DIRS: [&str; 2] = ["library/", "thumbs/"];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct DeleteReport {
    /// Library files removed from disk (stored copy, versions, thumbnail).
    pub removed_files: u32,
}

impl Library {
    /// Deletes a document. Imported: its library copy, every version and its
    /// thumbnail go too. Linked: only the library entry (and files the library
    /// itself made for it); the external file stays as it is.
    pub fn delete_document(&self, id: &str) -> Result<DeleteReport> {
        let mut files: Vec<String> = Vec::new();
        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            let (kind, location, thumbnail): (String, String, Option<String>) = tx
                .query_row(
                    "SELECT kind, location, thumbnail_path FROM documents WHERE id = ?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?
                .ok_or_else(|| Error::NotFound(id.to_owned()))?;
            {
                let mut stmt =
                    tx.prepare("SELECT file_path FROM versions WHERE document_id = ?1")?;
                for path in stmt.query_map([id], |r| r.get::<_, String>(0))? {
                    files.push(path?);
                }
            }
            if kind == "imported" {
                files.push(location.clone());
            } else {
                // Belt and braces: a version row could name the external file.
                files.retain(|f| *f != location);
            }
            files.extend(thumbnail);
            files.sort();
            files.dedup();

            // Explicit, not only ON DELETE CASCADE: correct even without foreign keys.
            tx.execute("DELETE FROM document_tags WHERE document_id = ?1", [id])?;
            tx.execute("DELETE FROM versions WHERE document_id = ?1", [id])?;
            tx.execute("DELETE FROM documents WHERE id = ?1", [id])?;
            tx.commit()?;
        }

        let mut report = DeleteReport::default();
        for file in &files {
            if self.remove_if_unreferenced(file)? {
                report.removed_files += 1;
            }
        }
        Ok(report)
    }

    /// Deletes a library-owned file once no version, document or thumbnail
    /// points at it. Returns whether a file was removed.
    pub(crate) fn remove_if_unreferenced(&self, location: &str) -> Result<bool> {
        if !OWNED_DIRS.iter().any(|dir| location.starts_with(dir)) {
            return Ok(false);
        }
        let referenced: i64 = self.conn().query_row(
            "SELECT (SELECT COUNT(*) FROM versions WHERE file_path = ?1)
                  + (SELECT COUNT(*) FROM documents WHERE location = ?1 OR thumbnail_path = ?1)",
            params![location],
            |r| r.get(0),
        )?;
        if referenced > 0 {
            return Ok(false);
        }
        let Ok(path) = self.resolve_location(location) else {
            return Ok(false);
        };
        // Already gone (or locked by another process) is fine: the row was what
        // mattered, and a leftover file is invisible to the library.
        Ok(std::fs::remove_file(path).is_ok())
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::library::LibraryQuery;
    use crate::thumbs::THUMBS_DIR;

    fn pdf(marker: &str) -> Vec<u8> {
        format!("%PDF-1.7\n% {marker}\n%%EOF\n").into_bytes()
    }

    fn webp() -> Vec<u8> {
        let mut bytes = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
        bytes.resize(64, 7);
        bytes
    }

    fn lib() -> Result<(tempfile::TempDir, Library)> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let lib = Library::open(dir.path())?;
        Ok((dir, lib))
    }

    fn count(lib: &Library, sql: &str, id: &str) -> Result<i64> {
        Ok(lib.conn().query_row(sql, [id], |r| r.get(0))?)
    }

    fn dir_len(path: &Path) -> Result<usize> {
        Ok(std::fs::read_dir(path)
            .map_err(|e| Error::io(path, e))?
            .count())
    }

    /// An imported document with a thumbnail, a tag and a second version.
    fn rich_document(lib: &Library, marker: &str) -> Result<String> {
        let id = lib
            .import_reader(pdf(marker).as_slice(), marker)?
            .document
            .id;
        lib.save_thumbnail(&id, &webp())?;
        let tag = lib.create_tag(&format!("tag-{marker}"))?;
        lib.set_document_tags(&id, std::slice::from_ref(&tag.id))?;
        let rel = format!("library/{marker}-v2.pdf");
        let path = lib.resolve_location(&rel)?;
        std::fs::write(&path, pdf(&format!("{marker} v2"))).map_err(|e| Error::io(&path, e))?;
        lib.conn().execute(
            "INSERT INTO versions (id, document_id, seq, blake3, size_bytes, created_at, label, file_path)
             VALUES (?1, ?2, 2, 'h2', 10, 0, 'auto', ?3)",
            params![format!("{marker}-2"), id, rel],
        )?;
        Ok(id)
    }

    #[test]
    fn deleting_an_import_removes_copy_versions_thumbnail_and_rows() -> Result<()> {
        let (dir, lib) = lib()?;
        let id = rich_document(&lib, "a")?;
        let keep = rich_document(&lib, "b")?;
        let stored = lib.document_file(&id)?.path;
        let thumb = lib
            .get_document(&id)?
            .thumbnail_path
            .ok_or(Error::InvalidArgument("no thumbnail"))?;

        let report = lib.delete_document(&id)?;
        assert_eq!(report.removed_files, 3, "copy + v2 + thumbnail");
        assert!(!Path::new(&stored).exists());
        assert!(!Path::new(&thumb).exists());
        assert!(!dir.path().join("library/a-v2.pdf").exists());
        assert_eq!(
            count(
                &lib,
                "SELECT COUNT(*) FROM versions WHERE document_id = ?1",
                &id
            )?,
            0
        );
        assert_eq!(
            count(
                &lib,
                "SELECT COUNT(*) FROM document_tags WHERE document_id = ?1",
                &id
            )?,
            0
        );
        assert!(matches!(lib.get_document(&id), Err(Error::NotFound(_))));

        // The other document is untouched; the tag itself stays.
        let other = lib.document_file(&keep)?;
        assert!(Path::new(&other.path).is_file());
        assert!(other.document.thumbnail_path.is_some());
        assert_eq!(lib.list_tags()?.len(), 2);
        assert_eq!(dir_len(&lib.files_dir())?, 2, "b's copy + b-v2");
        assert_eq!(dir_len(&dir.path().join(THUMBS_DIR))?, 1);

        assert!(matches!(lib.delete_document(&id), Err(Error::NotFound(_))));
        Ok(())
    }

    #[test]
    fn deleting_a_linked_document_never_touches_the_external_file() -> Result<()> {
        let (dir, lib) = lib()?;
        let outside = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let external = outside.path().join("Εξωτερικό.pdf");
        std::fs::write(&external, pdf("ext")).map_err(|e| Error::io(&external, e))?;
        let location = external.to_string_lossy().into_owned();
        lib.conn().execute(
            "INSERT INTO documents (id, title, kind, location, blake3, size_bytes, created_at, modified_at)
             VALUES ('linked-1', 'ext', 'linked', ?1, 'hx', 20, 0, 0)",
            [&location],
        )?;
        lib.conn().execute(
            "INSERT INTO versions (id, document_id, seq, blake3, size_bytes, created_at, label, file_path)
             VALUES ('lv1', 'linked-1', 1, 'hx', 20, 0, 'auto', ?1)",
            [&location],
        )?;
        lib.save_thumbnail("linked-1", &webp())?;

        let report = lib.delete_document("linked-1")?;
        assert_eq!(report.removed_files, 1, "only the library's thumbnail");
        assert_eq!(
            std::fs::read(&external).map_err(|e| Error::io(&external, e))?,
            pdf("ext")
        );
        assert_eq!(dir_len(&dir.path().join(THUMBS_DIR))?, 0);
        assert!(lib.list_documents(&LibraryQuery::default())?.is_empty());
        Ok(())
    }

    #[test]
    fn a_failed_delete_changes_nothing() -> Result<()> {
        let (_dir, lib) = lib()?;
        let id = rich_document(&lib, "a")?;
        let stored = lib.document_file(&id)?.path;
        // Abort inside the transaction, after the tag rows are gone.
        lib.conn().execute_batch(
            "CREATE TRIGGER fail_delete BEFORE DELETE ON versions
             BEGIN SELECT RAISE(ABORT, 'injected'); END;",
        )?;
        assert!(matches!(lib.delete_document(&id), Err(Error::Db(_))));

        let doc = lib.get_document(&id)?;
        assert_eq!(doc.tag_ids.len(), 1, "rolled back");
        assert_eq!(
            count(
                &lib,
                "SELECT COUNT(*) FROM versions WHERE document_id = ?1",
                &id
            )?,
            2
        );
        assert!(
            Path::new(&stored).is_file(),
            "files are only removed after commit"
        );
        assert!(doc.thumbnail_path.is_some_and(|p| Path::new(&p).is_file()));

        lib.conn().execute_batch("DROP TRIGGER fail_delete;")?;
        assert_eq!(lib.delete_document(&id)?.removed_files, 3);
        Ok(())
    }

    #[test]
    fn a_shared_thumbnail_survives_until_its_last_user_is_deleted() -> Result<()> {
        let (_dir, lib) = lib()?;
        let id = lib
            .import_reader(pdf("same").as_slice(), "import")?
            .document
            .id;
        let thumb = lib.save_thumbnail(&id, &webp())?.thumbnail_path;
        let blake3 = lib.get_document(&id)?.blake3;
        // A linked document with the same content shares `thumbs/<blake3>.webp`.
        lib.conn().execute(
            "INSERT INTO documents (id, title, kind, location, blake3, size_bytes, created_at, modified_at,
                                    thumbnail_path, thumbnail_bytes)
             VALUES ('linked-2', 'same', 'linked', '/elsewhere/same.pdf', ?1, 20, 0, 0, ?2, 64)",
            params![blake3, format!("thumbs/{blake3}.webp")],
        )?;
        assert_eq!(lib.delete_document(&id)?.removed_files, 1, "copy only");
        let thumb = thumb.ok_or(Error::InvalidArgument("no thumbnail"))?;
        assert!(Path::new(&thumb).is_file());
        assert_eq!(lib.delete_document("linked-2")?.removed_files, 1);
        assert!(!Path::new(&thumb).exists());
        Ok(())
    }
}
