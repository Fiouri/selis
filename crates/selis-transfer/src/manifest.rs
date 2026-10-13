//! What the sender offers, sent after the receiver's code is confirmed: per
//! document its title, file name, size and BLAKE3, and optionally its version
//! history (older files, oldest first). JSON, schema-versioned. ADR 0010.
//!
//! Version 2 (ADR 0014) adds what a library move carries: per document its tags
//! and favorite flag, and for the library its visual signatures and settings.
//! A version 1 manifest is still read.
//!
//! The parser is strict and bounded: it is fed bytes from a peer (and fuzzed,
//! `fuzz/fuzz_targets/manifest.rs`).

use iroh_blobs::Hash;
use serde::{Deserialize, Serialize};

pub const MANIFEST_VERSION: u32 = 2;
/// Oldest version still read.
pub const MIN_MANIFEST_VERSION: u32 = 1;
pub const MAX_TAGS_PER_ITEM: usize = 100;
pub const MAX_TAG_CHARS: usize = 64;
pub const MAX_SIGNATURES: usize = 200;
pub const MAX_SIGNATURE_BYTES: u64 = 4 * 1024 * 1024;
/// Settings travel as a small JSON object.
pub const MAX_SETTINGS_BYTES: usize = 16 * 1024;
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
    /// A library move: signatures and settings (absent for a plain send).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library: Option<LibraryExtras>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryExtras {
    #[serde(default)]
    pub signatures: Vec<ManifestSignature>,
    /// Settings as stored (`key` → JSON value); the device key is never among them.
    #[serde(default)]
    pub settings: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestSignature {
    /// The signature's id on the sending device (kept: a second move is a no-op).
    pub id: String,
    /// "drawn" | "typed" | "image"
    pub kind: String,
    pub size: u64,
    #[serde(with = "hex_hash")]
    pub blake3: Hash,
    pub created_at: i64,
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
    /// Tag names (library move).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub favorite: bool,
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
        if s.len() != 64
            || !s
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
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
            library: None,
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
        if !(MIN_MANIFEST_VERSION..=MANIFEST_VERSION).contains(&self.version) {
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
            if item.tags.len() > MAX_TAGS_PER_ITEM
                || item.tags.iter().any(|t| {
                    t.trim().is_empty()
                        || t.chars().count() > MAX_TAG_CHARS
                        || t.chars().any(char::is_control)
                })
            {
                return invalid("bad tags");
            }
        }
        if let Some(library) = &self.library {
            if library.signatures.len() > MAX_SIGNATURES {
                return invalid("too many signatures");
            }
            for s in &library.signatures {
                let id_ok = !s.id.is_empty()
                    && s.id.len() <= 64
                    && s.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
                if !id_ok || !matches!(s.kind.as_str(), "drawn" | "typed" | "image") {
                    return invalid("bad signature");
                }
                if s.size == 0 || s.size > MAX_SIGNATURE_BYTES {
                    return invalid("bad signature size");
                }
            }
            let settings = serde_json::to_vec(&library.settings)
                .map(|v| v.len())
                .unwrap_or(usize::MAX);
            if settings > MAX_SETTINGS_BYTES {
                return invalid("settings too large");
            }
        }
        Ok(())
    }

    /// Every blob the transfer moves: each document, each of its versions and
    /// each signature image.
    pub fn hashes(&self) -> impl Iterator<Item = Hash> + '_ {
        self.items
            .iter()
            .flat_map(|i| std::iter::once(i.blake3).chain(i.history.iter().map(|v| v.blake3)))
            .chain(
                self.library
                    .iter()
                    .flat_map(|l| l.signatures.iter().map(|s| s.blake3)),
            )
    }

    /// Every blob with its size (each distinct blob once).
    pub fn blobs(&self) -> Vec<(Hash, u64)> {
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        let mut add = |h: Hash, size: u64| {
            if seen.insert(h) {
                out.push((h, size));
            }
        };
        for item in &self.items {
            for v in &item.history {
                add(v.blake3, v.size);
            }
            add(item.blake3, item.size);
        }
        for s in self.library.iter().flat_map(|l| l.signatures.iter()) {
            add(s.blake3, s.size);
        }
        out
    }

    /// Bytes of payload (each distinct blob counted once).
    pub fn total_bytes(&self) -> u64 {
        self.blobs()
            .iter()
            .fold(0u64, |t, (_, s)| t.saturating_add(*s))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_version_1_and_carries_a_library_move() {
        let v1 = br#"{"version":1,"items":[{"title":"","name":"a.pdf","size":3,"blake3":"af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"}]}"#;
        let m = Manifest::parse(v1).expect("v1");
        assert!(m.library.is_none() && m.items[0].tags.is_empty());

        let mut moved = Manifest::new(vec![ManifestItem {
            tags: vec!["Work".into()],
            favorite: true,
            ..item("m.pdf")
        }]);
        let mut settings = serde_json::Map::new();
        settings.insert("theme".into(), serde_json::json!("dark"));
        moved.library = Some(LibraryExtras {
            signatures: vec![ManifestSignature {
                id: "0190-abc".into(),
                kind: "drawn".into(),
                size: 10,
                blake3: Hash::new(b"sig"),
                created_at: 2,
            }],
            settings,
        });
        let back = Manifest::parse(&moved.to_bytes()).expect("v2");
        assert_eq!(back, moved);
        assert_eq!(back.hashes().count(), 3);
        assert_eq!(back.total_bytes(), 42 + 40 + 10);
        let mut evil = moved.clone();
        if let Some(l) = evil.library.as_mut() {
            l.signatures[0].id = "../x".into();
        }
        assert!(Manifest::parse(&evil.to_bytes()).is_err());
    }

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
            tags: vec![],
            favorite: false,
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
        future.version = MANIFEST_VERSION + 1;
        assert_eq!(
            Manifest::parse(&future.to_bytes()),
            Err(ManifestError::Version(MANIFEST_VERSION + 1))
        );
        let mut bad_tags = item("t.pdf");
        bad_tags.tags = vec!["  ".into()];
        assert!(Manifest::parse(&Manifest::new(vec![bad_tags]).to_bytes()).is_err());
        assert!(Manifest::parse(br#"{"version":1,"items":[],"extra":1}"#).is_err());
        assert!(Manifest::parse(b"not json").is_err());
        assert_eq!(
            Manifest::parse(&vec![b' '; MAX_MANIFEST_BYTES + 1]),
            Err(ManifestError::TooLarge)
        );
    }
}
