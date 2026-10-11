//! User tags. Names are unique per folded spelling ("Εργασία" = "εργασια"),
//! and every write is idempotent so the UI can safely retry.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::fold::fold;
use crate::library::{Document, Library, now_ms};

const MAX_TAG_CHARS: usize = 48;
const MAX_TAGS_PER_DOCUMENT: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub document_count: u32,
}

fn clean_name(raw: &str) -> Result<String> {
    let name: String = raw
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_TAG_CHARS)
        .collect();
    if name.is_empty() {
        return Err(Error::InvalidArgument("tag name is empty"));
    }
    Ok(name)
}

impl Library {
    /// All tags, alphabetically (folded), with how many documents carry each.
    pub fn list_tags(&self) -> Result<Vec<Tag>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT t.id, t.name, COUNT(dt.document_id)
               FROM tags t LEFT JOIN document_tags dt ON dt.tag_id = t.id
              GROUP BY t.id
              ORDER BY t.name_key, t.name",
        )?;
        let tags = stmt
            .query_map([], |r| {
                Ok(Tag {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    document_count: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(tags)
    }

    /// Creates a tag, or returns the existing one with the same folded name.
    pub fn create_tag(&self, name: &str) -> Result<Tag> {
        let name = clean_name(name)?;
        let key = fold(&name);
        {
            let conn = self.conn();
            conn.execute(
                "INSERT INTO tags (id, name, name_key, created_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (name_key) DO NOTHING",
                params![Uuid::now_v7().to_string(), name, key, now_ms()],
            )?;
        }
        self.tag_by_key(&key)
    }

    /// Renames a tag. Renaming onto another tag's name is a conflict.
    pub fn rename_tag(&self, id: &str, name: &str) -> Result<Tag> {
        let name = clean_name(name)?;
        let key = fold(&name);
        {
            let conn = self.conn();
            let other: Option<String> = conn
                .query_row(
                    "SELECT id FROM tags WHERE name_key = ?1 AND id <> ?2",
                    params![key, id],
                    |r| r.get(0),
                )
                .optional()?;
            if other.is_some() {
                return Err(Error::Conflict("a tag with this name already exists"));
            }
            let changed = conn.execute(
                "UPDATE tags SET name = ?2, name_key = ?3 WHERE id = ?1",
                params![id, name, key],
            )?;
            if changed == 0 {
                return Err(Error::NotFound(id.to_owned()));
            }
        }
        self.tag_by_key(&key)
    }

    /// Deletes a tag and removes it from every document. Deleting a missing tag is a no-op.
    pub fn delete_tag(&self, id: &str) -> Result<()> {
        self.conn()
            .execute("DELETE FROM tags WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Replaces the document's tags with `tag_ids` (unknown ids are an error).
    pub fn set_document_tags(&self, document_id: &str, tag_ids: &[String]) -> Result<Document> {
        if tag_ids.len() > MAX_TAGS_PER_DOCUMENT {
            return Err(Error::InvalidArgument("too many tags"));
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let exists: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM documents WHERE id = ?1",
                [document_id],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(Error::NotFound(document_id.to_owned()));
        }
        tx.execute(
            "DELETE FROM document_tags WHERE document_id = ?1",
            [document_id],
        )?;
        for tag_id in tag_ids {
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO document_tags (document_id, tag_id)
                 SELECT ?1, id FROM tags WHERE id = ?2",
                params![document_id, tag_id],
            )?;
            let known: Option<i64> = tx
                .query_row("SELECT 1 FROM tags WHERE id = ?1", [tag_id], |r| r.get(0))
                .optional()?;
            if inserted == 0 && known.is_none() {
                return Err(Error::NotFound(tag_id.clone()));
            }
        }
        tx.commit()?;
        self.get_locked(&conn, document_id)
    }

    fn tag_by_key(&self, key: &str) -> Result<Tag> {
        let conn = self.conn();
        conn.query_row(
            "SELECT t.id, t.name,
                    (SELECT COUNT(*) FROM document_tags dt WHERE dt.tag_id = t.id)
               FROM tags t WHERE t.name_key = ?1",
            [key],
            |r| {
                Ok(Tag {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    document_count: r.get(2)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| Error::NotFound(key.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{LibraryFilter, LibraryQuery};

    fn lib() -> Result<(tempfile::TempDir, Library)> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let lib = Library::open(dir.path())?;
        Ok((dir, lib))
    }

    fn doc(lib: &Library, marker: &str) -> Result<Document> {
        let bytes = format!("%PDF-1.7\n% {marker}\n%%EOF\n");
        Ok(lib.import_reader(bytes.as_bytes(), marker)?.document)
    }

    #[test]
    fn create_is_idempotent_per_folded_name() -> Result<()> {
        let (_dir, lib) = lib()?;
        let a = lib.create_tag("  Εργασία  ")?;
        let b = lib.create_tag("ΕΡΓΑΣΙΑ")?;
        assert_eq!(a.id, b.id);
        assert_eq!(b.name, "Εργασία");
        assert!(matches!(
            lib.create_tag("   "),
            Err(Error::InvalidArgument(_))
        ));
        assert_eq!(lib.list_tags()?.len(), 1);
        Ok(())
    }

    #[test]
    fn assign_filter_rename_delete() -> Result<()> {
        let (_dir, lib) = lib()?;
        let d1 = doc(&lib, "one")?;
        let d2 = doc(&lib, "two")?;
        let work = lib.create_tag("Εργασία")?;
        let home = lib.create_tag("Σπίτι")?;

        let tagged = lib.set_document_tags(&d1.id, &[home.id.clone(), work.id.clone()])?;
        let mut expected = vec![home.id.clone(), work.id.clone()];
        expected.sort();
        assert_eq!(tagged.tag_ids, expected);
        lib.set_document_tags(&d2.id, std::slice::from_ref(&work.id))?;

        let counts: Vec<(String, u32)> = lib
            .list_tags()?
            .into_iter()
            .map(|t| (t.name, t.document_count))
            .collect();
        assert_eq!(counts, [("Εργασία".to_owned(), 2), ("Σπίτι".to_owned(), 1)]);

        let only_home = lib.list_documents(&LibraryQuery {
            filter: LibraryFilter::All,
            tag_id: Some(home.id.clone()),
            ..LibraryQuery::default()
        })?;
        assert_eq!(only_home.len(), 1);
        assert_eq!(only_home[0].id, d1.id);

        assert!(matches!(
            lib.rename_tag(&home.id, "εργασια"),
            Err(Error::Conflict(_))
        ));
        assert_eq!(lib.rename_tag(&home.id, "Οικογένεια")?.name, "Οικογένεια");

        lib.delete_tag(&work.id)?;
        lib.delete_tag(&work.id)?;
        assert_eq!(lib.get_document(&d2.id)?.tag_ids, Vec::<String>::new());
        assert_eq!(
            lib.get_document(&d1.id)?.tag_ids,
            std::slice::from_ref(&home.id)
        );

        // Replacing with the empty set clears; unknown ids are refused atomically.
        assert!(matches!(
            lib.set_document_tags(&d1.id, &["nope".to_owned()]),
            Err(Error::NotFound(_))
        ));
        assert_eq!(lib.get_document(&d1.id)?.tag_ids, [home.id]);
        assert!(lib.set_document_tags(&d1.id, &[])?.tag_ids.is_empty());
        Ok(())
    }

    #[test]
    fn tags_survive_reopen() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let (doc_id, tag_id) = {
            let lib = Library::open(dir.path())?;
            let d = doc(&lib, "p")?;
            let t = lib.create_tag("Κρατήσεις")?;
            lib.set_document_tags(&d.id, std::slice::from_ref(&t.id))?;
            (d.id, t.id)
        };
        let lib = Library::open(dir.path())?;
        assert_eq!(lib.get_document(&doc_id)?.tag_ids, [tag_id]);
        Ok(())
    }
}
