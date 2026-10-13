//! Library move (P3b, ADR 0014): everything a new phone needs — documents with
//! their versions, tags and favorites, saved signatures and settings — except
//! the device key (OS secure storage, never in the library). Received content
//! is deduplicated by BLAKE3, so moving the same library twice adds nothing.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::{
    error::{Error, Result},
    library::{FILES_DIR, Library},
    signatures::SignatureKind,
};

/// What a library move would send (shown before it starts).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct LibrarySummary {
    pub documents: u32,
    /// Versions other than each document's current one.
    pub versions: u32,
    pub tags: u32,
    pub signatures: u32,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub bytes: u64,
}

fn count(n: i64) -> u32 {
    u32::try_from(n).unwrap_or(0)
}

impl Library {
    /// Counts and size of a full library move (documents, every library version,
    /// tags, signatures).
    pub fn library_summary(&self) -> Result<LibrarySummary> {
        let conn = self.conn();
        let (documents, current_bytes): (i64, i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(size_bytes), 0) FROM documents",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        // Library versions whose file is not the document's current file.
        let (versions, version_bytes): (i64, i64) = conn.query_row(
            &format!(
                "SELECT COUNT(DISTINCT v.blake3), COALESCE(SUM(DISTINCT v.size_bytes), 0)
                   FROM versions v JOIN documents d ON d.id = v.document_id
                  WHERE v.file_path LIKE '{FILES_DIR}/%' AND v.blake3 <> d.blake3"
            ),
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let tags: i64 = conn.query_row("SELECT COUNT(*) FROM tags", [], |r| r.get(0))?;
        let signatures: i64 =
            conn.query_row("SELECT COUNT(*) FROM signatures", [], |r| r.get(0))?;
        Ok(LibrarySummary {
            documents: count(documents),
            versions: count(versions),
            tags: count(tags),
            signatures: count(signatures),
            bytes: u64::try_from(current_bytes.saturating_add(version_bytes)).unwrap_or(0),
        })
    }

    /// Names of a document's tags.
    pub fn document_tag_names(&self, document_id: &str) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT t.name FROM tags t JOIN document_tags dt ON dt.tag_id = t.id
              WHERE dt.document_id = ?1 ORDER BY t.name_key",
        )?;
        let names = stmt
            .query_map([document_id], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(names)
    }

    /// Adds a moved document's tags (by name, created when missing) and its
    /// favorite flag; nothing is removed, so applying twice changes nothing.
    pub fn apply_received_metadata(
        &self,
        document_id: &str,
        tags: &[String],
        favorite: bool,
    ) -> Result<()> {
        if !tags.is_empty() {
            let mut ids: Vec<String> = self.get_document(document_id)?.tag_ids;
            for name in tags {
                let tag = self.create_tag(name)?;
                if !ids.contains(&tag.id) {
                    ids.push(tag.id);
                }
            }
            self.set_document_tags(document_id, &ids)?;
        }
        if favorite {
            self.set_favorite(document_id, true)?;
        }
        Ok(())
    }

    /// Adds a moved signature under its original id; one already there is kept.
    /// Returns whether it was added.
    pub fn import_received_signature(
        &self,
        id: &str,
        kind: &str,
        png: &std::path::Path,
    ) -> Result<bool> {
        if self.get_signature(id)?.is_some() {
            return Ok(false);
        }
        let kind = match kind {
            "drawn" => SignatureKind::Drawn,
            "typed" => SignatureKind::Typed,
            "image" => SignatureKind::Image,
            _ => return Err(Error::InvalidArgument("signature kind")),
        };
        let bytes = std::fs::read(png).map_err(|e| Error::io(png, e))?;
        self.save_signature(id, kind, &bytes)?;
        Ok(true)
    }

    /// The library's file with this BLAKE3 (lowercase hex), if it has one: a
    /// receive does not fetch it again.
    pub fn file_with_hash(&self, blake3: &str) -> Option<PathBuf> {
        if blake3.len() != 64 || !blake3.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let path = self
            .files_dir()
            .join(format!("{}.pdf", blake3.to_ascii_lowercase()));
        path.is_file().then_some(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::received::{ReceivedDocument, ReceivedFile};

    fn pdf(dir: &std::path::Path, name: &str) -> Result<ReceivedFile> {
        let bytes = format!("%PDF-1.7\n% {name}\n%%EOF\n").into_bytes();
        let path = dir.join(name);
        std::fs::write(&path, &bytes).map_err(|e| Error::io(&path, e))?;
        Ok(ReceivedFile {
            path,
            blake3: blake3::hash(&bytes).to_hex().to_string(),
            created_at: None,
        })
    }

    /// A minimal valid PNG (1×1).
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0, 0,
        0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 13, b'I', b'D', b'A',
        b'T', 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0, 0x05, 0x00, 0x01, 0xff, 0x89,
        0x99, 0x3d, 0x1d, 0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xae, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn moving_twice_adds_nothing_the_second_time() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let lib = Library::open(dir.path().join("lib"))?;
        let doc = ReceivedDocument {
            title: "Lease".into(),
            current: pdf(dir.path(), "a.pdf")?,
            history: vec![],
        };
        let sig = dir.path().join("s.png");
        std::fs::write(&sig, PNG).map_err(|e| Error::io(&sig, e))?;
        for round in 0..2 {
            let out = lib.import_received(&doc)?;
            assert_eq!(out.duplicate, round == 1);
            lib.apply_received_metadata(&out.document.id, &["Home".into(), "Work".into()], true)?;
            assert_eq!(
                lib.import_received_signature("sig-1", "drawn", &sig)?,
                round == 0
            );
        }
        let docs = lib.list_documents(&crate::LibraryQuery::default())?;
        assert_eq!(docs.len(), 1);
        assert!(docs[0].favorite);
        assert_eq!(lib.document_tag_names(&docs[0].id)?, ["Home", "Work"]);
        assert_eq!(lib.list_tags()?.len(), 2);
        assert_eq!(lib.list_signatures()?.len(), 1);
        let summary = lib.library_summary()?;
        assert_eq!(
            (
                summary.documents,
                summary.versions,
                summary.tags,
                summary.signatures
            ),
            (1, 0, 2, 1)
        );
        assert!(lib.file_with_hash(&doc.current.blake3).is_some());
        assert!(lib.file_with_hash("nope").is_none());
        assert!(
            lib.import_received_signature("sig-2", "weird", &sig)
                .is_err()
        );
        Ok(())
    }
}
