//! Trusted devices (P3b, ADR 0014): saved after a confirmed transfer, removable
//! at any time. Only the other device's public endpoint id and a name are kept.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{
    error::{Error, Result},
    library::{Library, now_ms},
};

pub const MAX_DEVICE_NAME_CHARS: usize = 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct TrustedDevice {
    /// The device's endpoint id (64 hex characters).
    pub endpoint_id: String,
    pub name: String,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub added_at: i64,
    #[cfg_attr(feature = "specta", specta(type = Option<specta_typescript::Number>))]
    pub last_seen_at: Option<i64>,
}

fn check_endpoint_id(id: &str) -> Result<()> {
    if id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(Error::InvalidArgument("device id"))
    }
}

fn clean_name(name: &str) -> Result<String> {
    let clean: String = name
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_DEVICE_NAME_CHARS)
        .collect();
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.is_empty() {
        return Err(Error::InvalidArgument("device name is empty"));
    }
    Ok(clean)
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TrustedDevice> {
    Ok(TrustedDevice {
        endpoint_id: r.get(0)?,
        name: r.get(1)?,
        added_at: r.get(2)?,
        last_seen_at: r.get(3)?,
    })
}

impl Library {
    /// Trusted devices, most recently seen first.
    pub fn trusted_devices(&self) -> Result<Vec<TrustedDevice>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT endpoint_id, name, added_at, last_seen_at FROM trusted_devices
             ORDER BY COALESCE(last_seen_at, added_at) DESC, name",
        )?;
        let rows = stmt
            .query_map([], row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn trusted_device(&self, endpoint_id: &str) -> Result<Option<TrustedDevice>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT endpoint_id, name, added_at, last_seen_at FROM trusted_devices WHERE endpoint_id = ?1",
                [endpoint_id],
                row,
            )
            .optional()?)
    }

    /// Saves (or renames) a trusted device. Saving again is harmless.
    pub fn trust_device(&self, endpoint_id: &str, name: &str) -> Result<TrustedDevice> {
        check_endpoint_id(endpoint_id)?;
        let name = clean_name(name)?;
        let now = now_ms();
        self.conn().execute(
            "INSERT INTO trusted_devices (endpoint_id, name, added_at, last_seen_at) VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT (endpoint_id) DO UPDATE SET name = excluded.name",
            params![endpoint_id, name, now],
        )?;
        self.trusted_device(endpoint_id)?
            .ok_or_else(|| Error::NotFound(endpoint_id.to_owned()))
    }

    /// Removes trust: the device can no longer push here and needs a code again. Idempotent.
    pub fn untrust_device(&self, endpoint_id: &str) -> Result<()> {
        self.conn().execute(
            "DELETE FROM trusted_devices WHERE endpoint_id = ?1",
            [endpoint_id],
        )?;
        Ok(())
    }

    /// Records a transfer with a trusted device (ignored for others).
    pub fn touch_trusted_device(&self, endpoint_id: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE trusted_devices SET last_seen_at = ?2 WHERE endpoint_id = ?1",
            params![endpoint_id, now_ms()],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    #[test]
    fn trust_rename_touch_and_remove() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let lib = Library::open(dir.path().join("lib"))?;
        assert!(lib.trust_device("not-an-id", "x").is_err());
        assert!(lib.trust_device(ID, "   ").is_err());
        let d = lib.trust_device(ID, "  Maria's   laptop\n")?;
        assert_eq!(d.name, "Maria's laptop");
        lib.trust_device(ID, "Laptop")?;
        assert_eq!(lib.trusted_devices()?.len(), 1);
        assert_eq!(lib.trusted_devices()?[0].name, "Laptop");
        lib.touch_trusted_device(ID)?;
        lib.untrust_device(ID)?;
        lib.untrust_device(ID)?;
        assert!(lib.trusted_devices()?.is_empty());
        assert!(lib.trusted_device(ID)?.is_none());
        Ok(())
    }
}
