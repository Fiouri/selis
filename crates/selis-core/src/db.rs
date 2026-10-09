//! Versioned SQL migrations tracked in `PRAGMA user_version`.
//!
//! Before applying migrations to an existing database, a consistent snapshot is
//! written next to it with `VACUUM INTO` (`<db>.bak-v<from>`).

use std::path::Path;

use rusqlite::Connection;

use crate::error::{Error, Result};

/// Ordered migrations; index + 1 is the schema version they produce.
const MIGRATIONS: &[&str] = &[include_str!("../migrations/0001_init.sql")];

pub const SCHEMA_VERSION: u32 = MIGRATIONS.len() as u32;

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    migrate(&conn, Some(path))?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_in_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    configure(&conn)?;
    migrate(&conn, None)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )?;
    Ok(())
}

fn user_version(conn: &Connection) -> Result<u32> {
    Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

fn migrate(conn: &Connection, db_path: Option<&Path>) -> Result<()> {
    let current = user_version(conn)?;
    if current > SCHEMA_VERSION {
        return Err(Error::SchemaTooNew {
            found: current,
            supported: SCHEMA_VERSION,
        });
    }
    if current == SCHEMA_VERSION {
        return Ok(());
    }
    if current > 0
        && let Some(path) = db_path
    {
        backup(conn, path, current)?;
    }
    for (idx, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let target = idx as u32 + 1;
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", target)?;
        tx.commit()?;
    }
    Ok(())
}

fn backup(conn: &Connection, db_path: &Path, from_version: u32) -> Result<()> {
    let mut name = db_path
        .file_name()
        .ok_or(Error::InvalidArgument("database path has no file name"))?
        .to_os_string();
    name.push(format!(".bak-v{from_version}"));
    let dest = db_path.with_file_name(name);
    if dest.exists() {
        std::fs::remove_file(&dest).map_err(|e| Error::io(&dest, e))?;
    }
    let dest_str = dest
        .to_str()
        .ok_or(Error::InvalidArgument("backup path is not valid UTF-8"))?;
    conn.execute("VACUUM INTO ?1", [dest_str])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_db_reaches_latest_version() -> Result<()> {
        let conn = open_in_memory()?;
        assert_eq!(user_version(&conn)?, SCHEMA_VERSION);
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")?
            .query_map([], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        assert_eq!(tables, ["documents", "settings", "versions"]);
        Ok(())
    }

    #[test]
    fn reopening_is_idempotent() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let path = dir.path().join("selis.db");
        drop(open(&path)?);
        let conn = open(&path)?;
        assert_eq!(user_version(&conn)?, SCHEMA_VERSION);
        Ok(())
    }

    #[test]
    fn newer_schema_is_rejected() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let path = dir.path().join("selis.db");
        {
            let conn = Connection::open(&path)?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)?;
        }
        assert!(matches!(open(&path), Err(Error::SchemaTooNew { .. })));
        Ok(())
    }

    #[test]
    fn backup_snapshot_is_written() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let path = dir.path().join("selis.db");
        let conn = Connection::open(&path)?;
        conn.execute_batch("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (42);")?;
        backup(&conn, &path, 1)?;
        let snap = Connection::open(dir.path().join("selis.db.bak-v1"))?;
        let x: i64 = snap.query_row("SELECT x FROM t", [], |r| r.get(0))?;
        assert_eq!(x, 42);
        Ok(())
    }
}
