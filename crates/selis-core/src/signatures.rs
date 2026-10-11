//! Visual signatures, kept on the device and reused (docs/SPEC.md, P2): one
//! transparent PNG per signature under `signatures/`, drawn, typed or made
//! from a picture in the UI. They are images of a signature for placing on a
//! page, not cryptographic (PAdES) signatures.

use std::path::Path;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::fsutil::atomic_write;
use crate::library::{Library, now_ms};

pub(crate) const SIGNATURES_DIR: &str = "signatures";
/// A signature image is a few tens of KB; this bounds a bad input.
pub const MAX_SIGNATURE_BYTES: usize = 4 * 1024 * 1024;
/// Largest side in pixels (the UI renders at most 1600 wide).
const MAX_SIDE: u32 = 4096;
const MAX_ID_LEN: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum SignatureKind {
    Drawn,
    Typed,
    Image,
}

impl SignatureKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Drawn => "drawn",
            Self::Typed => "typed",
            Self::Image => "image",
        }
    }

    fn parse(s: &str) -> rusqlite::Result<Self> {
        match s {
            "drawn" => Ok(Self::Drawn),
            "typed" => Ok(Self::Typed),
            "image" => Ok(Self::Image),
            other => Err(rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                format!("unknown signature kind {other:?}").into(),
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub id: String,
    pub kind: SignatureKind,
    /// Absolute path of the PNG (asset protocol).
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// Unix epoch milliseconds.
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub created_at: i64,
}

/// Width and height from a PNG's IHDR chunk, if `bytes` is a PNG of a sane size.
fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    (width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE).then_some((width, height))
}

fn check_id(id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(Error::InvalidArgument(
            "signature id must be 1..=64 of [A-Za-z0-9-]",
        ))
    }
}

const SIGNATURE_COLUMNS: &str = "id, kind, file_path, width, height, created_at";

impl Library {
    pub(crate) fn prepare_signature_dir(&self) -> Result<()> {
        let dir = self.root.join(SIGNATURES_DIR);
        std::fs::create_dir_all(&dir).map_err(|e| Error::io(&dir, e))
    }

    fn signature_from_row(&self, row: &rusqlite::Row<'_>) -> rusqlite::Result<Signature> {
        let kind: String = row.get(1)?;
        let rel: String = row.get(2)?;
        Ok(Signature {
            id: row.get(0)?,
            kind: SignatureKind::parse(&kind)?,
            path: self.root.join(rel).to_string_lossy().into_owned(),
            width: row.get(3)?,
            height: row.get(4)?,
            created_at: row.get(5)?,
        })
    }

    /// Saved signatures, newest first.
    pub fn list_signatures(&self) -> Result<Vec<Signature>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {SIGNATURE_COLUMNS} FROM signatures ORDER BY created_at DESC, id DESC"
        ))?;
        let rows = stmt
            .query_map([], |row| self.signature_from_row(row))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn get_signature(&self, id: &str) -> Result<Option<Signature>> {
        let conn = self.conn();
        Ok(conn
            .query_row(
                &format!("SELECT {SIGNATURE_COLUMNS} FROM signatures WHERE id = ?1"),
                [id],
                |row| self.signature_from_row(row),
            )
            .optional()?)
    }

    /// Stores a signature image under the UI-chosen `id`. Saving the same id
    /// again (a retry after a lost reply) returns the stored signature.
    pub fn save_signature(&self, id: &str, kind: SignatureKind, png: &[u8]) -> Result<Signature> {
        check_id(id)?;
        if png.len() > MAX_SIGNATURE_BYTES {
            return Err(Error::InvalidArgument("signature image too large"));
        }
        let (width, height) =
            png_size(png).ok_or(Error::InvalidArgument("signature image must be a PNG"))?;
        if let Some(existing) = self.get_signature(id)? {
            return Ok(existing);
        }
        let rel = format!("{SIGNATURES_DIR}/{id}.png");
        let path = self.root.join(&rel);
        atomic_write(&path, png)?;
        let inserted = self.conn().execute(
            "INSERT INTO signatures (id, kind, file_path, width, height, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, kind.as_str(), rel, width, height, now_ms()],
        );
        if let Err(e) = inserted {
            remove_quietly(&path);
            return Err(e.into());
        }
        self.get_signature(id)?
            .ok_or_else(|| Error::NotFound(id.to_owned()))
    }

    /// Forgets a saved signature (row first, then its file). Signatures already
    /// placed in documents are part of those documents and stay. Idempotent.
    pub fn delete_signature(&self, id: &str) -> Result<()> {
        check_id(id)?;
        let rel: Option<String> = self
            .conn()
            .query_row(
                "SELECT file_path FROM signatures WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(rel) = rel else { return Ok(()) };
        self.conn()
            .execute("DELETE FROM signatures WHERE id = ?1", [id])?;
        remove_quietly(&self.resolve_location(&rel)?);
        Ok(())
    }
}

fn remove_quietly(path: &Path) {
    // Gone already is fine: the row was what mattered.
    let _ = std::fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        bytes
    }

    fn lib() -> Result<(tempfile::TempDir, Library)> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let lib = Library::open(dir.path())?;
        Ok((dir, lib))
    }

    #[test]
    fn saves_lists_and_deletes() -> Result<()> {
        let (_dir, lib) = lib()?;
        let a = lib.save_signature("sig-a", SignatureKind::Drawn, &png(600, 200))?;
        let b = lib.save_signature("sig-b", SignatureKind::Typed, &png(800, 160))?;
        assert_eq!((a.width, a.height), (600, 200));
        assert!(Path::new(&a.path).is_file());
        let ids: Vec<String> = lib.list_signatures()?.into_iter().map(|s| s.id).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&b.id));
        lib.delete_signature("sig-a")?;
        lib.delete_signature("sig-a")?;
        assert!(!Path::new(&a.path).exists());
        assert_eq!(lib.list_signatures()?.len(), 1);
        Ok(())
    }

    #[test]
    fn saving_the_same_id_again_is_a_no_op() -> Result<()> {
        let (_dir, lib) = lib()?;
        let first = lib.save_signature("sig-1", SignatureKind::Image, &png(10, 10))?;
        let again = lib.save_signature("sig-1", SignatureKind::Image, &png(10, 10))?;
        assert_eq!(first, again);
        assert_eq!(lib.list_signatures()?.len(), 1);
        Ok(())
    }

    #[test]
    fn refuses_non_png_huge_and_bad_ids() -> Result<()> {
        let (_dir, lib) = lib()?;
        assert!(matches!(
            lib.save_signature("x", SignatureKind::Drawn, b"GIF89a....................."),
            Err(Error::InvalidArgument(_))
        ));
        assert!(matches!(
            lib.save_signature("x", SignatureKind::Drawn, &png(5000, 10)),
            Err(Error::InvalidArgument(_))
        ));
        assert!(matches!(
            lib.save_signature("../escape", SignatureKind::Drawn, &png(10, 10)),
            Err(Error::InvalidArgument(_))
        ));
        assert!(lib.list_signatures()?.is_empty());
        Ok(())
    }
}
