//! What the sender offers, sent after the receiver's code is confirmed: per
//! document its title, file name, size and BLAKE3, and optionally its version
//! history (older files, oldest first). JSON, schema-versioned. ADR 0010.
//!
//! The parser is strict and bounded: it is fed bytes from a peer (and fuzzed,
//! `fuzz/fuzz_targets/manifest.rs`).

use iroh_blobs::Hash;
use serde::{Deserialize, Serialize};

pub const MANIFEST_VERSION: u32 = 1;
/// Largest manifest accepted (a library of thousands of documents fits).
pub const MAX_MANIFEST_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_ITEMS: usize = 10_000;
pub const MAX_VERSIONS_PER_ITEM: usize = 1_000;
pub const MAX_TITLE_CHARS: usize = 512;
pub const MAX_NAME_CHARS: usize = 255;
/// Largest single file (a PDF this size is already unusual).
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub version: u32,
    pub items: Vec<ManifestItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestItem {
    /// Library title ("" = untitled).
    pub title: String,
    /// File name for the user ("Report.pdf"); never used as a path.
    pub name: String,
    pub size: u64,
    #[serde(with = "hex_hash")]
    pub blake3: Hash,
    /// Earlier versions, oldest first (empty unless history was chosen).
    #[serde(default)]
    pub history: Vec<ManifestVersion>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestVersion {
    pub size: u64,
    #[serde(with = "hex_hash")]
    pub blake3: Hash,
    /// Unix ms when that version was saved.
    pub created_at: i64,
}

/// BLAKE3 as 64 lowercase hex characters. iroh-blobs' own `Hash` deserializer
/// panics on some malformed strings (found by the parser smoke test), and these
/// strings come from another device: parse them strictly here.
mod hex_hash {
    use iroh_blobs::Hash;
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    pub fn serialize<S: Serializer>(h: &Hash, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&h.to_hex())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Hash, D::Error> {
        let s = String::deserialize(d)?;
        if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(D::Error::custom("bad blake3"));
        }
        let h = blake3::Hash::from_hex(&s).map_err(|_| D::Error::custom("bad blake3"))?;
        Ok(Hash::from(*h.as_bytes()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ManifestError {
    #[error("manifest too large")]
    TooLarge,
    #[error("manifest is not valid: {0}")]
    Invalid(String),
    #[error("unsupported manifest version {0}")]
    Version(u32),
}

impl Manifest {
    pub fn new(items: Vec<ManifestItem>) -> Self {
        Self {
            version: MANIFEST_VERSION,
            items,
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        // Plain owned data: serialization cannot fail.
        serde_json::to_vec(self).unwrap_or_default()
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, ManifestError> {
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(ManifestError::TooLarge);
        }
        let m: Manifest =
            serde_json::from_slice(bytes).map_err(|e| ManifestError::Invalid(e.to_string()))?;
        m.validate()?;
        Ok(m)
    }

    pub fn validate(&self) -> Result<(), ManifestError> {
        let invalid = |m: &str| Err(ManifestError::Invalid(m.into()));
        if self.version != MANIFEST_VERSION {
            return Err(ManifestError::Version(self.version));
        }
        if self.items.is_empty() {
            return invalid("no documents");
        }
        if self.items.len() > MAX_ITEMS {
            return invalid("too many documents");
        }
        for item in &self.items {
            if item.title.chars().count() > MAX_TITLE_CHARS {
                return invalid("title too long");
            }
            let name_len = item.name.chars().count();
            if name_len == 0 || name_len > MAX_NAME_CHARS {
                return invalid("bad file name length");
            }
            if item
                .name
                .chars()
                .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
                || item.name == "."
                || item.name == ".."
            {
                return invalid("bad file name");
            }
            if item.size == 0 || item.size > MAX_FILE_BYTES {
                return invalid("bad size");
            }
            if item.history.len() > MAX_VERSIONS_PER_ITEM {
                return invalid("too many versions");
            }
            if item
                .history
                .iter()
                .any(|v| v.size == 0 || v.size > MAX_FILE_BYTES)
            {
                return invalid("bad version size");
            }
        }
        Ok(())
    }

    /// Every blob the transfer moves: each document and each of its versions.
    pub fn hashes(&self) -> impl Iterator<Item = Hash> + '_ {
        self.items
            .iter()
            .flat_map(|i| std::iter::once(i.blake3).chain(i.history.iter().map(|v| v.blake3)))
    }

    /// Bytes of payload (each distinct blob counted once).
    pub fn total_bytes(&self) -> u64 {
        let mut seen = std::collections::HashSet::new();
        let mut total = 0u64;
        for item in &self.items {
            if seen.insert(item.blake3) {
                total = total.saturating_add(item.size);
            }
            for v in &item.history {
                if seen.insert(v.blake3) {
                    total = total.saturating_add(v.size);
                }
            }
        }
        total
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(name: &str) -> ManifestItem {
        ManifestItem {
            title: "Συμβόλαιο".into(),
            name: name.into(),
            size: 42,
            blake3: Hash::new(name),
            history: vec![ManifestVersion {
                size: 40,
                blake3: Hash::new(format!("{name}-v1")),
                created_at: 1,
            }],
        }
    }

    #[test]
    fn round_trips() {
        let m = Manifest::new(vec![item("a.pdf"), item("b.pdf")]);
        assert_eq!(Manifest::parse(&m.to_bytes()), Ok(m.clone()));
        assert_eq!(m.hashes().count(), 4);
        assert_eq!(m.total_bytes(), 164);
    }

    #[test]
    fn refuses_unsafe_or_odd_input() {
        for name in [
            "",
            "../x.pdf",
            "a/b.pdf",
            "a\\b.pdf",
            "C:x.pdf",
            "..",
            "a\u{0}.pdf",
            &"x".repeat(300),
        ] {
            let m = Manifest::new(vec![item(name)]);
            assert!(
                matches!(
                    Manifest::parse(&m.to_bytes()),
                    Err(ManifestError::Invalid(_))
                ),
                "{name:?}"
            );
        }
        let mut zero = item("z.pdf");
        zero.size = 0;
        assert!(Manifest::parse(&Manifest::new(vec![zero]).to_bytes()).is_err());
        assert!(Manifest::parse(&Manifest::new(vec![]).to_bytes()).is_err());
        let mut future = Manifest::new(vec![item("a.pdf")]);
        future.version = 2;
        assert_eq!(
            Manifest::parse(&future.to_bytes()),
            Err(ManifestError::Version(2))
        );
        assert!(Manifest::parse(br#"{"version":1,"items":[],"extra":1}"#).is_err());
        assert!(Manifest::parse(b"not json").is_err());
        assert_eq!(
            Manifest::parse(&vec![b' '; MAX_MANIFEST_BYTES + 1]),
            Err(ManifestError::TooLarge)
        );
    }
}
