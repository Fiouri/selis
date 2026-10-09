//! Document library: imports copy files into the app's library directory
//! (content-addressed by BLAKE3) and index them in SQLite. Originals are only
//! ever opened for reading.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db;
use crate::error::{Error, Result};
use crate::fsutil::HashedTempFile;

const DB_FILE: &str = "selis.db";
const FILES_DIR: &str = "library";
const PDF_MAGIC: &[u8] = b"%PDF-";
const MAX_TITLE_CHARS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum DocumentKind {
    Imported,
    Linked,
}

impl DocumentKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Imported => "imported",
            Self::Linked => "linked",
        }
    }

    fn parse(s: &str) -> rusqlite::Result<Self> {
        match s {
            "imported" => Ok(Self::Imported),
            "linked" => Ok(Self::Linked),
            other => Err(rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                format!("unknown document kind {other:?}").into(),
            )),
        }
    }
}

/// A library entry as exposed to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    /// Empty when no usable name is known; the UI shows a localized "Untitled".
    pub title: String,
    pub kind: DocumentKind,
    pub blake3: String,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub size_bytes: u64,
    pub page_count: Option<u32>,
    /// Unix epoch milliseconds (exported to TypeScript as `number`; < 2^53).
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub created_at: i64,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub modified_at: i64,
    #[cfg_attr(feature = "specta", specta(type = Option<specta_typescript::Number>))]
    pub last_opened_at: Option<i64>,
    pub favorite: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub document: Document,
    /// True when an identical file (same BLAKE3) was already in the library.
    pub duplicate: bool,
}

/// Resolved file for viewing. `path` is absolute and inside the library directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct DocumentFile {
    pub document: Document,
    pub path: String,
}

pub struct Library {
    root: PathBuf,
    conn: Mutex<Connection>,
}

impl Library {
    /// Opens (or creates) a library rooted at `root`, running pending migrations.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        let files = root.join(FILES_DIR);
        std::fs::create_dir_all(&files).map_err(|e| Error::io(&files, e))?;
        let conn = db::open(&root.join(DB_FILE))?;
        Ok(Self {
            root,
            conn: Mutex::new(conn),
        })
    }

    pub fn files_dir(&self) -> PathBuf {
        self.root.join(FILES_DIR)
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        // A panic while holding the lock cannot leave SQLite inconsistent
        // (transactions roll back on drop), so poisoning is safe to ignore.
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Imports a local file by path. The source is opened read-only.
    pub fn import_path(&self, path: &Path) -> Result<ImportOutcome> {
        let file = File::open(path).map_err(|e| Error::io(path, e))?;
        let title = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(title_from_file_name)
            .unwrap_or_default();
        self.import_reader(file, &title)
    }

    /// Imports a stream (e.g. an Android SAF descriptor) as a new library copy.
    ///
    /// The bytes are streamed to a temp file in the library directory while being
    /// hashed, validated as PDF, then atomically renamed to `<blake3>.pdf`.
    /// An identical file already in the library is returned instead of duplicated.
    pub fn import_reader(&self, reader: impl Read, title: &str) -> Result<ImportOutcome> {
        let files = self.files_dir();
        let tmp = HashedTempFile::from_reader(&files, reader)?;
        if tmp.size_bytes == 0 {
            return Err(Error::EmptyFile);
        }
        if !looks_like_pdf(&tmp.head) {
            return Err(Error::NotPdf);
        }
        let hash = tmp.hash.to_hex();
        if let Some(existing) = self.find_imported_by_hash(&hash)? {
            return Ok(ImportOutcome {
                document: existing,
                duplicate: true,
            });
        }

        let file_name = format!("{hash}.pdf");
        let size_bytes = tmp.size_bytes;
        tmp.persist(&files.join(&file_name))?;

        let now = now_ms();
        let doc = Document {
            id: Uuid::now_v7().to_string(),
            title: sanitize_title(title),
            kind: DocumentKind::Imported,
            blake3: hash.clone(),
            size_bytes,
            page_count: None,
            created_at: now,
            modified_at: now,
            last_opened_at: None,
            favorite: false,
        };
        let location = format!("{FILES_DIR}/{file_name}");
        let size_i64 =
            i64::try_from(size_bytes).map_err(|_| Error::InvalidArgument("file too large"))?;

        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO documents
                (id, title, kind, location, blake3, size_bytes, page_count,
                 created_at, modified_at, last_opened_at, favorite)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7, NULL, 0)",
            params![
                doc.id,
                doc.title,
                doc.kind.as_str(),
                location,
                hash,
                size_i64,
                now
            ],
        )?;
        tx.execute(
            "INSERT INTO versions (id, document_id, seq, blake3, size_bytes, created_at, label, file_path)
             VALUES (?1, ?2, 1, ?3, ?4, ?5, 'auto', ?6)",
            params![Uuid::now_v7().to_string(), doc.id, hash, size_i64, now, location],
        )?;
        tx.commit()?;
        Ok(ImportOutcome {
            document: doc,
            duplicate: false,
        })
    }

    /// All documents, most recently opened first, then newest imports.
    pub fn list_documents(&self) -> Result<Vec<Document>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {DOC_COLUMNS} FROM documents
             ORDER BY last_opened_at IS NULL, last_opened_at DESC, created_at DESC"
        ))?;
        let docs = stmt
            .query_map([], document_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(docs)
    }

    /// Resolves a document for viewing and records it as opened now.
    pub fn read_document(&self, id: &str) -> Result<DocumentFile> {
        let conn = self.conn();
        let now = now_ms();
        let changed = conn.execute(
            "UPDATE documents SET last_opened_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
        if changed == 0 {
            return Err(Error::NotFound(id.to_owned()));
        }
        let (doc, location): (Document, String) = conn.query_row(
            &format!("SELECT {DOC_COLUMNS}, location FROM documents WHERE id = ?1"),
            [id],
            |row| Ok((document_from_row(row)?, row.get(DOC_COLUMN_COUNT)?)),
        )?;
        let path = self.resolve_location(&location)?;
        if !path.is_file() {
            return Err(Error::NotFound(id.to_owned()));
        }
        Ok(DocumentFile {
            document: doc,
            path: path.to_string_lossy().into_owned(),
        })
    }

    /// Stores facts learned by the PDF engine on first open. The PDF metadata
    /// title is only used when no title is known yet.
    pub fn record_document_info(
        &self,
        id: &str,
        page_count: u32,
        pdf_title: Option<&str>,
    ) -> Result<Document> {
        let conn = self.conn();
        let title = pdf_title.map(sanitize_title).unwrap_or_default();
        let changed = conn.execute(
            "UPDATE documents
                SET page_count = ?2,
                    title = CASE WHEN title = '' THEN ?3 ELSE title END
              WHERE id = ?1",
            params![id, page_count, title],
        )?;
        if changed == 0 {
            return Err(Error::NotFound(id.to_owned()));
        }
        let doc = conn.query_row(
            &format!("SELECT {DOC_COLUMNS} FROM documents WHERE id = ?1"),
            [id],
            document_from_row,
        )?;
        Ok(doc)
    }

    /// All settings as raw JSON values.
    pub fn settings(&self) -> Result<Vec<(String, serde_json::Value)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(k, v)| Ok((k, serde_json::from_str(&v)?)))
            .collect()
    }

    pub fn set_setting(&self, key: &str, value: &serde_json::Value) -> Result<()> {
        if key.is_empty() || key.len() > 128 {
            return Err(Error::InvalidArgument("setting key must be 1..=128 bytes"));
        }
        let json = serde_json::to_string(value)?;
        self.conn().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, json],
        )?;
        Ok(())
    }

    fn find_imported_by_hash(&self, hash: &str) -> Result<Option<Document>> {
        let conn = self.conn();
        let doc = conn
            .query_row(
                &format!(
                    "SELECT {DOC_COLUMNS} FROM documents WHERE kind = 'imported' AND blake3 = ?1"
                ),
                [hash],
                document_from_row,
            )
            .optional()?;
        Ok(doc)
    }

    /// Maps a stored relative location to an absolute path, refusing anything
    /// that could escape the library root.
    fn resolve_location(&self, location: &str) -> Result<PathBuf> {
        let rel = Path::new(location);
        let safe = rel
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)));
        if !safe {
            return Err(Error::InvalidArgument("document location escapes library"));
        }
        Ok(self.root.join(rel))
    }
}

const DOC_COLUMNS: &str = "id, title, kind, blake3, size_bytes, page_count, \
                           created_at, modified_at, last_opened_at, favorite";
const DOC_COLUMN_COUNT: usize = 10;

fn document_from_row(row: &Row<'_>) -> rusqlite::Result<Document> {
    let kind: String = row.get(2)?;
    let size: i64 = row.get(4)?;
    Ok(Document {
        id: row.get(0)?,
        title: row.get(1)?,
        kind: DocumentKind::parse(&kind)?,
        blake3: row.get(3)?,
        size_bytes: u64::try_from(size).unwrap_or(0),
        page_count: row.get(5)?,
        created_at: row.get(6)?,
        modified_at: row.get(7)?,
        last_opened_at: row.get(8)?,
        favorite: row.get::<_, i64>(9)? != 0,
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// PDF readers accept the header anywhere in the first 1024 bytes.
fn looks_like_pdf(head: &[u8]) -> bool {
    head.windows(PDF_MAGIC.len()).any(|w| w == PDF_MAGIC)
}

/// "Report 2026.pdf" → "Report 2026". Names without a `.pdf` extension are
/// kept as-is.
pub fn title_from_file_name(name: &str) -> String {
    let trimmed = name.trim();
    let stem = match trimmed.len().checked_sub(4) {
        Some(cut)
            if trimmed.is_char_boundary(cut) && trimmed[cut..].eq_ignore_ascii_case(".pdf") =>
        {
            &trimmed[..cut]
        }
        _ => trimmed,
    };
    sanitize_title(stem)
}

fn sanitize_title(raw: &str) -> String {
    raw.chars()
        .filter(|c| !c.is_control())
        .take(MAX_TITLE_CHARS)
        .collect::<String>()
        .trim()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pdf_bytes(marker: &str) -> Vec<u8> {
        format!("%PDF-1.7\n% {marker}\n1 0 obj << >> endobj\n%%EOF\n").into_bytes()
    }

    fn lib() -> Result<(tempfile::TempDir, Library)> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let lib = Library::open(dir.path())?;
        Ok((dir, lib))
    }

    #[test]
    fn import_copies_file_and_indexes_it() -> Result<()> {
        let (_dir, lib) = lib()?;
        let bytes = pdf_bytes("a");
        let out = lib.import_reader(bytes.as_slice(), "Αναφορά")?;
        assert!(!out.duplicate);
        assert_eq!(out.document.title, "Αναφορά");
        assert_eq!(out.document.size_bytes, bytes.len() as u64);
        assert_eq!(
            out.document.blake3,
            blake3::hash(&bytes).to_hex().to_string()
        );

        let stored = lib.files_dir().join(format!("{}.pdf", out.document.blake3));
        assert_eq!(
            std::fs::read(&stored).map_err(|e| Error::io(&stored, e))?,
            bytes
        );

        let versions: i64 = lib.conn().query_row(
            "SELECT COUNT(*) FROM versions WHERE document_id = ?1 AND seq = 1",
            [&out.document.id],
            |r| r.get(0),
        )?;
        assert_eq!(versions, 1);
        Ok(())
    }

    #[test]
    fn import_path_never_modifies_the_original() -> Result<()> {
        let (dir, lib) = lib()?;
        let original = dir.path().join("Original File.PDF");
        let bytes = pdf_bytes("orig");
        std::fs::write(&original, &bytes).map_err(|e| Error::io(&original, e))?;
        let before = std::fs::metadata(&original).map_err(|e| Error::io(&original, e))?;

        let out = lib.import_path(&original)?;
        assert_eq!(out.document.title, "Original File");

        let after = std::fs::metadata(&original).map_err(|e| Error::io(&original, e))?;
        assert_eq!(
            std::fs::read(&original).map_err(|e| Error::io(&original, e))?,
            bytes
        );
        assert_eq!(
            before.modified().map_err(|e| Error::io(&original, e))?,
            after.modified().map_err(|e| Error::io(&original, e))?
        );
        Ok(())
    }

    #[test]
    fn identical_content_is_deduplicated() -> Result<()> {
        let (_dir, lib) = lib()?;
        let a = lib.import_reader(pdf_bytes("same").as_slice(), "one")?;
        let b = lib.import_reader(pdf_bytes("same").as_slice(), "two")?;
        assert!(b.duplicate);
        assert_eq!(a.document.id, b.document.id);
        assert_eq!(lib.list_documents()?.len(), 1);
        // Only the stored copy remains; the duplicate's temp file was dropped.
        let files = std::fs::read_dir(lib.files_dir())
            .map_err(|e| Error::io(lib.files_dir(), e))?
            .count();
        assert_eq!(files, 1);
        Ok(())
    }

    #[test]
    fn rejects_non_pdf_and_empty() -> Result<()> {
        let (_dir, lib) = lib()?;
        assert!(matches!(
            lib.import_reader(&b"PK\x03\x04 not a pdf"[..], "x"),
            Err(Error::NotPdf)
        ));
        assert!(matches!(
            lib.import_reader(&b""[..], "x"),
            Err(Error::EmptyFile)
        ));
        assert!(lib.list_documents()?.is_empty());
        let files = std::fs::read_dir(lib.files_dir())
            .map_err(|e| Error::io(lib.files_dir(), e))?
            .count();
        assert_eq!(files, 0);
        Ok(())
    }

    #[test]
    fn accepts_header_after_leading_junk() -> Result<()> {
        let (_dir, lib) = lib()?;
        let mut bytes = vec![b' '; 100];
        bytes.extend(pdf_bytes("junk"));
        assert!(lib.import_reader(bytes.as_slice(), "j").is_ok());
        Ok(())
    }

    #[test]
    fn read_document_updates_recents_order() -> Result<()> {
        let (_dir, lib) = lib()?;
        let a = lib.import_reader(pdf_bytes("a").as_slice(), "a")?.document;
        let b = lib.import_reader(pdf_bytes("b").as_slice(), "b")?.document;
        // Newest import first when nothing has been opened.
        let order: Vec<_> = lib.list_documents()?.into_iter().map(|d| d.id).collect();
        assert_eq!(order, [b.id.clone(), a.id.clone()]);

        let file = lib.read_document(&a.id)?;
        assert!(Path::new(&file.path).is_file());
        assert!(file.document.last_opened_at.is_some());
        let order: Vec<_> = lib.list_documents()?.into_iter().map(|d| d.id).collect();
        assert_eq!(order, [a.id, b.id]);
        Ok(())
    }

    #[test]
    fn read_unknown_document_is_not_found() -> Result<()> {
        let (_dir, lib) = lib()?;
        assert!(matches!(lib.read_document("nope"), Err(Error::NotFound(_))));
        Ok(())
    }

    #[test]
    fn record_info_fills_untitled_only() -> Result<()> {
        let (_dir, lib) = lib()?;
        let untitled = lib.import_reader(pdf_bytes("u").as_slice(), "")?.document;
        let named = lib
            .import_reader(pdf_bytes("n").as_slice(), "Named")?
            .document;
        let u = lib.record_document_info(&untitled.id, 12, Some("From Metadata"))?;
        let n = lib.record_document_info(&named.id, 3, Some("Ignored"))?;
        assert_eq!(
            (u.title.as_str(), u.page_count),
            ("From Metadata", Some(12))
        );
        assert_eq!((n.title.as_str(), n.page_count), ("Named", Some(3)));
        Ok(())
    }

    #[test]
    fn settings_round_trip() -> Result<()> {
        let (_dir, lib) = lib()?;
        lib.set_setting("theme", &serde_json::json!("sepia"))?;
        lib.set_setting("theme", &serde_json::json!("dark"))?;
        lib.set_setting("locale", &serde_json::json!("el"))?;
        let all = lib.settings()?;
        assert_eq!(
            all,
            vec![
                ("locale".to_owned(), serde_json::json!("el")),
                ("theme".to_owned(), serde_json::json!("dark")),
            ]
        );
        assert!(matches!(
            lib.set_setting("", &serde_json::json!(1)),
            Err(Error::InvalidArgument(_))
        ));
        Ok(())
    }

    #[test]
    fn library_survives_reopen() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let id = {
            let lib = Library::open(dir.path())?;
            lib.import_reader(pdf_bytes("p").as_slice(), "p")?
                .document
                .id
        };
        let lib = Library::open(dir.path())?;
        assert_eq!(lib.read_document(&id)?.document.title, "p");
        Ok(())
    }

    #[test]
    fn resolve_location_refuses_traversal() -> Result<()> {
        let (_dir, lib) = lib()?;
        assert!(lib.resolve_location("../etc/passwd").is_err());
        assert!(lib.resolve_location("/abs/path").is_err());
        assert!(lib.resolve_location("library/x.pdf").is_ok());
        Ok(())
    }

    #[test]
    fn title_from_file_name_cases() {
        assert_eq!(title_from_file_name("a.pdf"), "a");
        assert_eq!(title_from_file_name("Β.PDF"), "Β");
        assert_eq!(title_from_file_name("notes"), "notes");
        assert_eq!(title_from_file_name(".pdf"), "");
        assert_eq!(title_from_file_name("ά.pdf"), "ά");
    }
}
