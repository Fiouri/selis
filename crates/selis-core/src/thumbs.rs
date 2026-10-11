//! Page-1 thumbnail cache: small images rendered by the PDF engine in the UI's
//! worker and stored here as `thumbs/<blake3>.<ext>`. The cache is bounded
//! (LRU by last use, 300 MB); an evicted thumbnail is simply rendered again.

use std::path::Path;

use rusqlite::{OptionalExtension, params};

use crate::error::{Error, Result};
use crate::fsutil::atomic_write;
use crate::library::{Document, Library, now_ms};

pub const THUMBS_DIR: &str = "thumbs";
/// Upper bound of the whole cache on disk.
pub const THUMB_CACHE_MAX_BYTES: u64 = 300 * 1024 * 1024;
/// A page-1 thumbnail is a few tens of KB; anything this large is a bug.
pub const MAX_THUMB_BYTES: usize = 2 * 1024 * 1024;

/// Image formats the WebViews can encode (WebP; WKWebView falls back to PNG/JPEG).
fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("jpg")
    } else {
        None
    }
}

impl Library {
    pub(crate) fn prepare_thumbnail_dir(&self) -> Result<()> {
        let dir = self.root.join(THUMBS_DIR);
        std::fs::create_dir_all(&dir).map_err(|e| Error::io(&dir, e))
    }

    /// Stores the page-1 thumbnail of a document, then trims the cache to
    /// [`THUMB_CACHE_MAX_BYTES`] (least recently used first, never this one).
    pub fn save_thumbnail(&self, id: &str, bytes: &[u8]) -> Result<Document> {
        if bytes.len() > MAX_THUMB_BYTES {
            return Err(Error::InvalidArgument("thumbnail too large"));
        }
        let ext =
            image_extension(bytes).ok_or(Error::InvalidArgument("unsupported thumbnail format"))?;
        let (blake3, previous): (String, Option<String>) = self
            .conn()
            .query_row(
                "SELECT blake3, thumbnail_path FROM documents WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(id.to_owned()))?;

        let rel = format!("{THUMBS_DIR}/{blake3}.{ext}");
        let path = self.resolve_location(&rel)?;
        atomic_write(&path, bytes)?;
        let size = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
        let updated = self.conn().execute(
            "UPDATE documents
                SET thumbnail_path = ?2, thumbnail_bytes = ?3, thumbnail_used_at = ?4
              WHERE id = ?1",
            params![id, rel, size, now_ms()],
        );
        match updated {
            Ok(1) => {}
            Ok(_) => {
                remove_quietly(&path);
                return Err(Error::NotFound(id.to_owned()));
            }
            Err(e) => {
                remove_quietly(&path);
                return Err(e.into());
            }
        }
        // A format change (e.g. PNG → WebP) leaves the old file behind.
        if let Some(old) = previous.filter(|old| *old != rel)
            && let Ok(old_path) = self.resolve_location(&old)
        {
            remove_quietly(&old_path);
        }
        self.trim_thumbnails(id, THUMB_CACHE_MAX_BYTES)?;
        self.get_document(id)
    }

    /// Total size of cached thumbnails, in bytes.
    pub fn thumbnail_cache_bytes(&self) -> Result<u64> {
        let total: i64 = self.conn().query_row(
            "SELECT COALESCE(SUM(thumbnail_bytes), 0) FROM documents WHERE thumbnail_path IS NOT NULL",
            [],
            |r| r.get(0),
        )?;
        Ok(u64::try_from(total).unwrap_or(0))
    }

    /// Evicts least recently used thumbnails (other than `keep_id`) until the
    /// cache fits in `max_bytes`.
    pub(crate) fn trim_thumbnails(&self, keep_id: &str, max_bytes: u64) -> Result<()> {
        let mut total = self.thumbnail_cache_bytes()?;
        while total > max_bytes {
            let victim: Option<(String, String, i64)> = self
                .conn()
                .query_row(
                    "SELECT id, thumbnail_path, thumbnail_bytes FROM documents
                      WHERE thumbnail_path IS NOT NULL AND id <> ?1
                      ORDER BY thumbnail_used_at IS NOT NULL, thumbnail_used_at, id
                      LIMIT 1",
                    [keep_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            let Some((victim_id, rel, size)) = victim else {
                break;
            };
            self.conn().execute(
                "UPDATE documents
                    SET thumbnail_path = NULL, thumbnail_bytes = 0, thumbnail_used_at = NULL
                  WHERE id = ?1",
                [&victim_id],
            )?;
            if let Ok(path) = self.resolve_location(&rel) {
                remove_quietly(&path);
            }
            total = total.saturating_sub(u64::try_from(size).unwrap_or(0));
        }
        Ok(())
    }
}

/// The cache is advisory: a file that cannot be removed now is left behind.
fn remove_quietly(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn webp(len: usize) -> Vec<u8> {
        let mut bytes = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
        bytes.resize(len.max(16), 7);
        bytes
    }

    fn lib_with_docs(n: usize) -> Result<(tempfile::TempDir, Library, Vec<String>)> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let lib = Library::open(dir.path())?;
        let ids = (0..n)
            .map(|i| {
                let bytes = format!("%PDF-1.7\n% doc {i}\n%%EOF\n");
                Ok(lib.import_reader(bytes.as_bytes(), "t")?.document.id)
            })
            .collect::<Result<Vec<_>>>()?;
        Ok((dir, lib, ids))
    }

    #[test]
    fn stores_and_exposes_the_thumbnail() -> Result<()> {
        let (_dir, lib, ids) = lib_with_docs(1)?;
        let doc = lib.save_thumbnail(&ids[0], &webp(100))?;
        let path = doc
            .thumbnail_path
            .ok_or(Error::InvalidArgument("no path"))?;
        assert!(path.ends_with(&format!("{}.webp", doc.blake3)));
        assert_eq!(
            std::fs::read(&path).map_err(|e| Error::io(&path, e))?,
            webp(100)
        );
        assert_eq!(lib.thumbnail_cache_bytes()?, 100);
        Ok(())
    }

    #[test]
    fn rejects_unknown_formats_and_documents() -> Result<()> {
        let (_dir, lib, ids) = lib_with_docs(1)?;
        assert!(matches!(
            lib.save_thumbnail(&ids[0], b"GIF89a......"),
            Err(Error::InvalidArgument(_))
        ));
        assert!(matches!(
            lib.save_thumbnail(&ids[0], &vec![0u8; MAX_THUMB_BYTES + 1]),
            Err(Error::InvalidArgument(_))
        ));
        assert!(matches!(
            lib.save_thumbnail("nope", &webp(32)),
            Err(Error::NotFound(_))
        ));
        assert!(
            lib.save_thumbnail(&ids[0], b"\x89PNG\r\n\x1a\n....")
                .is_ok()
        );
        Ok(())
    }

    #[test]
    fn evicts_least_recently_used_first() -> Result<()> {
        let (_dir, lib, ids) = lib_with_docs(3)?;
        for id in &ids {
            lib.save_thumbnail(id, &webp(1000))?;
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        // Opening doc 0 makes it the most recently used.
        lib.read_document(&ids[0])?;
        lib.trim_thumbnails(&ids[2], 2000)?;
        assert!(lib.get_document(&ids[0])?.thumbnail_path.is_some());
        assert!(
            lib.get_document(&ids[1])?.thumbnail_path.is_none(),
            "LRU victim"
        );
        assert!(lib.get_document(&ids[2])?.thumbnail_path.is_some());
        assert_eq!(lib.thumbnail_cache_bytes()?, 2000);
        let files = std::fs::read_dir(lib.root.join(THUMBS_DIR))
            .map_err(|e| Error::io("thumbs", e))?
            .count();
        assert_eq!(files, 2);
        Ok(())
    }

    #[test]
    fn never_evicts_the_thumbnail_being_saved() -> Result<()> {
        let (_dir, lib, ids) = lib_with_docs(1)?;
        lib.save_thumbnail(&ids[0], &webp(5000))?;
        lib.trim_thumbnails(&ids[0], 10)?;
        assert!(lib.get_document(&ids[0])?.thumbnail_path.is_some());
        Ok(())
    }
}
