//! `.selispack` (P3c, ADR 0012): documents (with their versions, tags and
//! favorites), signatures and settings in one file, for moving without any
//! network (USB, e-mail, a cloud the user picks). Optionally encrypted with a
//! passphrase.
//!
//! ```text
//! file      = MAGIC "SELISPK\0" | version u8 (1) | mode u8 | body
//! mode 0    = body is a ZIP (stored entries only)
//! mode 1    = m_kib u32 BE | t u32 BE | p u32 BE | salt [16] | nonce [19] | STREAM
//! STREAM    = XChaCha20-Poly1305, STREAM-BE32 (aead-stream), key = Argon2id(passphrase, salt, m, t, p)
//!             segment 0: the 16-byte key check "SELISPK-KEYCHECK" (wrong passphrase ≠ damaged)
//!             segments 1..: the ZIP in 64 KiB pieces, the last one flagged as last
//!             every segment is authenticated with the header as associated data
//! ZIP       = manifest.json, docs/<blake3>.pdf, signatures/<id>.png — nothing else
//! ```
//!
//! Reading is strict and bounded: no other entry names (no zip-slip), stored
//! entries only (no decompression, so no zip bomb), sizes and counts capped,
//! every file's BLAKE3 checked before anything is added to the library.
//! Writing goes to a temporary file that is fsynced and renamed into place.

use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
};

use aead_stream::{DecryptorBE32, EncryptorBE32};
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, aead::Payload};
use serde::{Deserialize, Serialize};
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

use crate::{
    error::{Error, Result},
    library::{Library, now_ms},
    received::{ReceivedDocument, ReceivedFile},
};

pub const MAGIC: &[u8; 8] = b"SELISPK\0";
/// MIME type for sharing and "Open with" (Android intent filter, iOS UTI).
pub const MIME: &str = "application/vnd.anywecon.selispack";
pub const EXTENSION: &str = "selispack";
pub const PACK_VERSION: u8 = 1;
const MODE_PLAIN: u8 = 0;
const MODE_ENCRYPTED: u8 = 1;
/// Plaintext bytes per encrypted segment.
const SEGMENT: usize = 64 * 1024;
const TAG: usize = 16;
const KEY_CHECK: &[u8; 16] = b"SELISPK-KEYCHECK";
const SALT_LEN: usize = 16;
/// STREAM-BE32 over XChaCha20: 24-byte nonce minus 5 bytes of counter and flag.
const NONCE_LEN: usize = 19;
const HEADER_PLAIN: usize = 10;
const HEADER_ENCRYPTED: usize = HEADER_PLAIN + 12 + SALT_LEN + NONCE_LEN;

/// Argon2id parameters for new packs (ADR 0012): 64 MiB, 3 passes, 1 lane —
/// about a second on a mid-range phone, above OWASP's minimum (19 MiB, 2).
pub const ARGON2_M_KIB: u32 = 64 * 1024;
pub const ARGON2_T: u32 = 3;
pub const ARGON2_P: u32 = 1;
/// Limits accepted when opening a pack (a hostile header must not exhaust memory or time).
const MAX_M_KIB: u32 = 256 * 1024;
const MAX_T: u32 = 10;
const MAX_P: u32 = 4;
pub const MIN_PASSPHRASE_CHARS: usize = 8;

const MANIFEST: &str = "manifest.json";
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_DOCUMENTS: usize = 10_000;
const MAX_VERSIONS: usize = 1_000;
const MAX_TAGS: usize = 100;

/// Why a pack could not be opened, in terms the UI can explain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PackError {
    #[error("not a Selis pack")]
    NotAPack,
    #[error("made by a newer Selis")]
    Unsupported,
    #[error("a passphrase is needed")]
    PassphraseNeeded,
    #[error("wrong passphrase")]
    WrongPassphrase,
    #[error("the pack is damaged or incomplete")]
    Damaged,
    #[error("the pack is larger than allowed")]
    TooLarge,
}

impl From<PackError> for Error {
    fn from(e: PackError) -> Self {
        Error::Pack(e)
    }
}

fn damaged<E>(_: E) -> Error {
    Error::Pack(PackError::Damaged)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackManifest {
    /// Always "selispack".
    pub format: String,
    pub version: u32,
    pub created_at: i64,
    pub documents: Vec<PackDocument>,
    #[serde(default)]
    pub signatures: Vec<PackSignature>,
    /// Settings as stored, when the whole library was packed.
    #[serde(default)]
    pub settings: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackDocument {
    pub title: String,
    pub file: PackFile,
    /// Earlier versions, oldest first.
    #[serde(default)]
    pub history: Vec<PackFile>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub favorite: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackFile {
    pub blake3: String,
    pub size: u64,
    /// When that version was saved (unix ms).
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackSignature {
    pub id: String,
    pub kind: String,
    pub blake3: String,
    pub size: u64,
    pub created_at: i64,
}

fn is_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_signature_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn doc_entry(hash: &str) -> String {
    format!("docs/{hash}.pdf")
}

fn signature_entry(id: &str) -> String {
    format!("signatures/{id}.png")
}

impl PackManifest {
    /// Strict, bounded parse (fuzzed).
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let m: PackManifest = serde_json::from_slice(bytes).map_err(damaged)?;
        m.validate()?;
        Ok(m)
    }

    fn validate(&self) -> Result<()> {
        let bad = || Error::Pack(PackError::Damaged);
        if self.format != "selispack" {
            return Err(Error::Pack(PackError::NotAPack));
        }
        if self.version != u32::from(PACK_VERSION) {
            return Err(Error::Pack(PackError::Unsupported));
        }
        if self.documents.len() > MAX_DOCUMENTS || self.signatures.len() > 200 {
            return Err(Error::Pack(PackError::TooLarge));
        }
        for d in &self.documents {
            if d.title.chars().count() > 512
                || d.history.len() > MAX_VERSIONS
                || d.tags.len() > MAX_TAGS
            {
                return Err(bad());
            }
            for f in std::iter::once(&d.file).chain(d.history.iter()) {
                if !is_hash(&f.blake3) || f.size == 0 || f.size > MAX_FILE_BYTES {
                    return Err(bad());
                }
            }
            if d.tags.iter().any(|t| {
                t.trim().is_empty() || t.chars().count() > 64 || t.chars().any(char::is_control)
            }) {
                return Err(bad());
            }
        }
        for s in &self.signatures {
            if !is_signature_id(&s.id)
                || !matches!(s.kind.as_str(), "drawn" | "typed" | "image")
                || !is_hash(&s.blake3)
                || s.size == 0
                || s.size > MAX_SIGNATURE_BYTES
            {
                return Err(bad());
            }
        }
        if let Some(settings) = &self.settings
            && serde_json::to_vec(settings)
                .map(|v| v.len())
                .unwrap_or(usize::MAX)
                > 16 * 1024
        {
            return Err(bad());
        }
        Ok(())
    }

    /// Every entry the ZIP must hold, with its size and BLAKE3.
    fn entries(&self) -> HashMap<String, (u64, String)> {
        let mut out = HashMap::new();
        for d in &self.documents {
            for f in std::iter::once(&d.file).chain(d.history.iter()) {
                out.insert(doc_entry(&f.blake3), (f.size, f.blake3.clone()));
            }
        }
        for s in &self.signatures {
            out.insert(signature_entry(&s.id), (s.size, s.blake3.clone()));
        }
        out
    }
}

/// What the first bytes of a file say about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum PackKind {
    Plain,
    Encrypted,
}

/// Reads the header: `None` when the bytes are not a pack at all.
pub fn sniff(head: &[u8]) -> Option<std::result::Result<PackKind, PackError>> {
    if head.len() < HEADER_PLAIN || &head[..8] != MAGIC {
        return None;
    }
    if head[8] != PACK_VERSION {
        return Some(Err(PackError::Unsupported));
    }
    Some(match head[9] {
        MODE_PLAIN => Ok(PackKind::Plain),
        MODE_ENCRYPTED => Ok(PackKind::Encrypted),
        _ => Err(PackError::Unsupported),
    })
}

struct KdfHeader {
    m_kib: u32,
    t: u32,
    p: u32,
    salt: [u8; SALT_LEN],
    nonce: [u8; NONCE_LEN],
}

impl KdfHeader {
    fn bytes(&self) -> Vec<u8> {
        let mut h = Vec::with_capacity(HEADER_ENCRYPTED);
        h.extend_from_slice(MAGIC);
        h.push(PACK_VERSION);
        h.push(MODE_ENCRYPTED);
        h.extend_from_slice(&self.m_kib.to_be_bytes());
        h.extend_from_slice(&self.t.to_be_bytes());
        h.extend_from_slice(&self.p.to_be_bytes());
        h.extend_from_slice(&self.salt);
        h.extend_from_slice(&self.nonce);
        h
    }

    fn parse(h: &[u8]) -> Result<Self> {
        if h.len() < HEADER_ENCRYPTED {
            return Err(Error::Pack(PackError::Damaged));
        }
        let u = |i: usize| u32::from_be_bytes([h[i], h[i + 1], h[i + 2], h[i + 3]]);
        let (m_kib, t, p) = (u(10), u(14), u(18));
        if p == 0
            || p > MAX_P
            || m_kib < 8u32.saturating_mul(p)
            || m_kib > MAX_M_KIB
            || t == 0
            || t > MAX_T
        {
            return Err(Error::Pack(PackError::Unsupported));
        }
        let mut salt = [0u8; SALT_LEN];
        salt.copy_from_slice(&h[22..22 + SALT_LEN]);
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&h[22 + SALT_LEN..HEADER_ENCRYPTED]);
        Ok(Self {
            m_kib,
            t,
            p,
            salt,
            nonce,
        })
    }

    fn key(&self, passphrase: &str) -> Result<[u8; 32]> {
        let params = Params::new(self.m_kib, self.t, self.p, Some(32))
            .map_err(|_| Error::Pack(PackError::Unsupported))?;
        let mut key = [0u8; 32];
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_into(passphrase.as_bytes(), &self.salt, &mut key)
            .map_err(|_| Error::Pack(PackError::Unsupported))?;
        Ok(key)
    }
}

fn hash_file(path: &Path) -> Result<crate::hash::Blake3Hash> {
    let file = File::open(path).map_err(|e| Error::io(path, e))?;
    crate::hash::Blake3Hash::of_reader(BufReader::new(file)).map_err(|e| Error::io(path, e))
}

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|_| Error::InvalidArgument("no randomness"))?;
    Ok(b)
}

/// Reads up to `buf.len()` bytes (fewer only at the end of the input).
fn read_full(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

fn encrypt(zip: &mut impl Read, out: &mut impl Write, passphrase: &str) -> Result<()> {
    let header = KdfHeader {
        m_kib: ARGON2_M_KIB,
        t: ARGON2_T,
        p: ARGON2_P,
        salt: random()?,
        nonce: random()?,
    };
    let aad = header.bytes();
    let key = header.key(passphrase)?;
    let aead = XChaCha20Poly1305::new((&key).into());
    let mut enc = EncryptorBE32::from_aead(aead, (&header.nonce).into());
    out.write_all(&aad).map_err(|e| Error::io("pack", e))?;
    let check = enc
        .encrypt_next(Payload {
            msg: KEY_CHECK.as_slice(),
            aad: &aad,
        })
        .map_err(damaged)?;
    out.write_all(&check).map_err(|e| Error::io("pack", e))?;
    let mut buf = vec![0u8; SEGMENT];
    let mut next = vec![0u8; SEGMENT];
    let mut n = read_full(zip, &mut buf).map_err(|e| Error::io("pack", e))?;
    loop {
        let m = read_full(zip, &mut next).map_err(|e| Error::io("pack", e))?;
        if m == 0 {
            let last = enc
                .encrypt_last(Payload {
                    msg: &buf[..n],
                    aad: &aad,
                })
                .map_err(damaged)?;
            out.write_all(&last).map_err(|e| Error::io("pack", e))?;
            return Ok(());
        }
        let seg = enc
            .encrypt_next(Payload {
                msg: &buf[..n],
                aad: &aad,
            })
            .map_err(damaged)?;
        out.write_all(&seg).map_err(|e| Error::io("pack", e))?;
        std::mem::swap(&mut buf, &mut next);
        n = m;
    }
}

fn decrypt(input: &mut impl Read, out: &mut impl Write, passphrase: &str) -> Result<()> {
    let mut rest = vec![0u8; HEADER_ENCRYPTED - HEADER_PLAIN];
    let mut aad = Vec::with_capacity(HEADER_ENCRYPTED);
    aad.extend_from_slice(MAGIC);
    aad.push(PACK_VERSION);
    aad.push(MODE_ENCRYPTED);
    if read_full(input, &mut rest).map_err(damaged)? != rest.len() {
        return Err(Error::Pack(PackError::Damaged));
    }
    aad.extend_from_slice(&rest);
    let header = KdfHeader::parse(&aad)?;
    let key = header.key(passphrase)?;
    let aead = XChaCha20Poly1305::new((&key).into());
    let mut dec = DecryptorBE32::from_aead(aead, (&header.nonce).into());
    let mut check = [0u8; KEY_CHECK.len() + TAG];
    if read_full(input, &mut check).map_err(damaged)? != check.len() {
        return Err(Error::Pack(PackError::Damaged));
    }
    let plain = dec
        .decrypt_next(Payload {
            msg: check.as_slice(),
            aad: &aad,
        })
        .map_err(|_| Error::Pack(PackError::WrongPassphrase))?;
    if plain.as_slice() != KEY_CHECK {
        return Err(Error::Pack(PackError::WrongPassphrase));
    }
    let mut buf = vec![0u8; SEGMENT + TAG];
    let mut next = vec![0u8; SEGMENT + TAG];
    let mut n = read_full(input, &mut buf).map_err(damaged)?;
    loop {
        let m = read_full(input, &mut next).map_err(damaged)?;
        if m == 0 {
            // The last segment must be marked as last: a cut file fails here.
            let last = dec
                .decrypt_last(Payload {
                    msg: &buf[..n],
                    aad: &aad,
                })
                .map_err(damaged)?;
            out.write_all(&last).map_err(|e| Error::io("pack", e))?;
            return Ok(());
        }
        let seg = dec
            .decrypt_next(Payload {
                msg: &buf[..n],
                aad: &aad,
            })
            .map_err(damaged)?;
        out.write_all(&seg).map_err(|e| Error::io("pack", e))?;
        std::mem::swap(&mut buf, &mut next);
        n = m;
    }
}

/// What to put in a pack.
#[derive(Debug, Clone, Default)]
pub struct PackRequest {
    /// `None`: the whole library (with signatures and settings).
    pub document_ids: Option<Vec<String>>,
    pub include_history: bool,
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct PackSummary {
    pub documents: u32,
    pub files: u32,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub bytes: u64,
    pub encrypted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackImport {
    pub document_ids: Vec<String>,
    pub duplicates: u32,
    pub signatures: u32,
    /// Settings carried by a whole-library pack (the app validates and applies them).
    pub settings: Option<serde_json::Map<String, serde_json::Value>>,
}

/// A temporary path next to `dest` (same file system: the rename is atomic).
fn part_path(dest: &Path, suffix: &str) -> PathBuf {
    let name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("pack");
    dest.with_file_name(format!(".{name}.{suffix}"))
}

fn finish_atomically(file: File, part: &Path, dest: &Path) -> Result<()> {
    file.sync_all().map_err(|e| Error::io(part, e))?;
    drop(file);
    std::fs::rename(part, dest).map_err(|e| Error::io(dest, e))
}

impl Library {
    /// Writes a pack to `dest` (atomically): documents with their files and
    /// metadata; with a passphrase, encrypted.
    pub fn export_pack(&self, dest: &Path, request: &PackRequest) -> Result<PackSummary> {
        if let Some(p) = &request.passphrase
            && p.chars().count() < MIN_PASSPHRASE_CHARS
        {
            return Err(Error::InvalidArgument("passphrase too short"));
        }
        let whole = request.document_ids.is_none();
        let ids = match &request.document_ids {
            Some(ids) => ids.clone(),
            None => self
                .list_documents(&crate::LibraryQuery::default())?
                .into_iter()
                .map(|d| d.id)
                .collect(),
        };
        if ids.is_empty() {
            return Err(Error::InvalidArgument("nothing to pack"));
        }
        // What goes in: manifest entries and the library files behind them.
        let mut documents = Vec::new();
        let mut files: Vec<(String, PathBuf)> = Vec::new();
        let mut seen = HashSet::new();
        let mut bytes = 0u64;
        let mut add_file =
            |entry: String, path: PathBuf, size: u64, files: &mut Vec<(String, PathBuf)>| {
                if seen.insert(entry.clone()) {
                    bytes = bytes.saturating_add(size);
                    files.push((entry, path));
                }
            };
        for id in &ids {
            let doc = self.get_document(id)?;
            let out = self.outgoing(id, request.include_history)?;
            let pack_file = |path: &Path, created_at: i64| -> Result<PackFile> {
                let hash = hash_file(path)?;
                let size = std::fs::metadata(path)
                    .map_err(|e| Error::io(path, e))?
                    .len();
                Ok(PackFile {
                    blake3: hash.to_hex(),
                    size,
                    created_at,
                })
            };
            let current = pack_file(&out.current, doc.modified_at)?;
            add_file(
                doc_entry(&current.blake3),
                out.current.clone(),
                current.size,
                &mut files,
            );
            let mut history = Vec::new();
            for (path, created_at) in &out.history {
                let f = pack_file(path, *created_at)?;
                add_file(doc_entry(&f.blake3), path.clone(), f.size, &mut files);
                history.push(f);
            }
            documents.push(PackDocument {
                title: out.title,
                file: current,
                history,
                tags: self.document_tag_names(id)?,
                favorite: doc.favorite,
            });
        }
        let mut signatures = Vec::new();
        let mut settings = None;
        if whole {
            for s in self.list_signatures()? {
                let path = PathBuf::from(&s.path);
                let hash = hash_file(&path)?;
                let size = std::fs::metadata(&path)
                    .map_err(|e| Error::io(&path, e))?
                    .len();
                add_file(signature_entry(&s.id), path, size, &mut files);
                signatures.push(PackSignature {
                    id: s.id,
                    kind: s.kind.as_str().to_owned(),
                    blake3: hash.to_hex(),
                    size,
                    created_at: s.created_at,
                });
            }
            settings = Some(self.settings()?.into_iter().collect());
        }
        let manifest = PackManifest {
            format: "selispack".into(),
            version: u32::from(PACK_VERSION),
            created_at: now_ms(),
            documents,
            signatures,
            settings,
        };
        let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(Error::Json)?;

        // The ZIP: a temporary file next to the pack.
        let zip_part = part_path(dest, "zip");
        let result = (|| {
            let zip_file = File::create(&zip_part).map_err(|e| Error::io(&zip_part, e))?;
            let mut zip = ZipWriter::new(BufWriter::new(zip_file));
            let options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Stored)
                .large_file(true);
            zip.start_file(MANIFEST, options).map_err(damaged)?;
            zip.write_all(&manifest_bytes)
                .map_err(|e| Error::io(&zip_part, e))?;
            for (entry, path) in &files {
                zip.start_file(entry.as_str(), options).map_err(damaged)?;
                let mut src = File::open(path).map_err(|e| Error::io(path, e))?;
                std::io::copy(&mut src, &mut zip).map_err(|e| Error::io(path, e))?;
            }
            let mut writer = zip.finish().map_err(damaged)?;
            writer.flush().map_err(|e| Error::io(&zip_part, e))?;
            drop(writer);

            let part = part_path(dest, "part");
            let out = File::create(&part).map_err(|e| Error::io(&part, e))?;
            let mut out_w = BufWriter::new(out);
            let mut zip_in =
                BufReader::new(File::open(&zip_part).map_err(|e| Error::io(&zip_part, e))?);
            match &request.passphrase {
                Some(p) => encrypt(&mut zip_in, &mut out_w, p)?,
                None => {
                    out_w.write_all(MAGIC).map_err(|e| Error::io(&part, e))?;
                    out_w
                        .write_all(&[PACK_VERSION, MODE_PLAIN])
                        .map_err(|e| Error::io(&part, e))?;
                    std::io::copy(&mut zip_in, &mut out_w).map_err(|e| Error::io(&part, e))?;
                }
            }
            let out = out_w
                .into_inner()
                .map_err(|e| Error::io(&part, e.into_error()))?;
            finish_atomically(out, &part, dest)
        })();
        let _ = std::fs::remove_file(&zip_part);
        if result.is_err() {
            let _ = std::fs::remove_file(part_path(dest, "part"));
        }
        result?;
        Ok(PackSummary {
            documents: u32::try_from(ids.len()).unwrap_or(u32::MAX),
            files: u32::try_from(files.len()).unwrap_or(u32::MAX),
            bytes,
            encrypted: request.passphrase.is_some(),
        })
    }

    /// Opens a pack, checks every file against its manifest, then adds what is
    /// new to the library. Nothing is added unless the whole pack checks out.
    pub fn import_pack(&self, src: &Path, passphrase: Option<&str>) -> Result<PackImport> {
        let staging = self
            .root
            .join("pack-in")
            .join(uuid::Uuid::now_v7().to_string());
        std::fs::create_dir_all(&staging).map_err(|e| Error::io(&staging, e))?;
        let result = self.import_pack_into(src, passphrase, &staging);
        let _ = std::fs::remove_dir_all(&staging);
        result
    }

    fn import_pack_into(
        &self,
        src: &Path,
        passphrase: Option<&str>,
        staging: &Path,
    ) -> Result<PackImport> {
        let mut input = BufReader::new(File::open(src).map_err(|e| Error::io(src, e))?);
        let mut head = [0u8; HEADER_PLAIN];
        if read_full(&mut input, &mut head).map_err(|e| Error::io(src, e))? != HEADER_PLAIN {
            return Err(Error::Pack(PackError::NotAPack));
        }
        let kind = sniff(&head).ok_or(Error::Pack(PackError::NotAPack))??;
        // The ZIP, in plain form, in the staging folder.
        let zip_path = staging.join("pack.zip");
        {
            let mut out =
                BufWriter::new(File::create(&zip_path).map_err(|e| Error::io(&zip_path, e))?);
            match kind {
                PackKind::Plain => {
                    std::io::copy(&mut input, &mut out).map_err(|e| Error::io(src, e))?;
                }
                PackKind::Encrypted => {
                    let p = passphrase.ok_or(Error::Pack(PackError::PassphraseNeeded))?;
                    decrypt(&mut input, &mut out, p)?;
                }
            }
            out.flush().map_err(|e| Error::io(&zip_path, e))?;
        }
        let mut zip = ZipArchive::new(BufReader::new(
            File::open(&zip_path).map_err(|e| Error::io(&zip_path, e))?,
        ))
        .map_err(damaged)?;
        if zip.len() > MAX_ENTRIES {
            return Err(Error::Pack(PackError::TooLarge));
        }
        let manifest = {
            let mut entry = zip.by_name(MANIFEST).map_err(damaged)?;
            if entry.compression() != CompressionMethod::Stored || entry.size() > MAX_MANIFEST_BYTES
            {
                return Err(Error::Pack(PackError::Damaged));
            }
            let mut bytes = Vec::new();
            (&mut entry)
                .take(MAX_MANIFEST_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(damaged)?;
            PackManifest::parse(&bytes)?
        };
        // Exactly the files the manifest names, each stored, at its size and hash.
        let expected = manifest.entries();
        let mut extracted: HashMap<String, PathBuf> = HashMap::new();
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(damaged)?;
            let name = entry.name().map_err(damaged)?.into_owned();
            if name == MANIFEST {
                continue;
            }
            let Some((size, hash)) = expected.get(&name) else {
                // Unknown names (including any "../") are refused, not skipped.
                return Err(Error::Pack(PackError::Damaged));
            };
            if entry.compression() != CompressionMethod::Stored
                || entry.size() != *size
                || extracted.contains_key(&name)
            {
                return Err(Error::Pack(PackError::Damaged));
            }
            let path = staging.join(format!("{i}.bin"));
            let mut out = File::create(&path).map_err(|e| Error::io(&path, e))?;
            let mut hasher = blake3::Hasher::new();
            let mut buf = vec![0u8; 64 * 1024];
            let mut total = 0u64;
            loop {
                let n = entry.read(&mut buf).map_err(damaged)?;
                if n == 0 {
                    break;
                }
                total += n as u64;
                if total > *size {
                    return Err(Error::Pack(PackError::Damaged));
                }
                hasher.update(&buf[..n]);
                out.write_all(&buf[..n]).map_err(|e| Error::io(&path, e))?;
            }
            if total != *size || hasher.finalize().to_hex().as_str() != hash {
                return Err(Error::Pack(PackError::Damaged));
            }
            extracted.insert(name, path);
        }
        if extracted.len() != expected.len() {
            return Err(Error::Pack(PackError::Damaged));
        }
        let _ = std::fs::remove_file(&zip_path);

        // Everything checked: add it.
        let file_of = |f: &PackFile| -> Result<ReceivedFile> {
            let path = extracted
                .get(&doc_entry(&f.blake3))
                .cloned()
                .ok_or(Error::Pack(PackError::Damaged))?;
            Ok(ReceivedFile {
                path,
                blake3: f.blake3.clone(),
                created_at: Some(f.created_at),
            })
        };
        let mut document_ids = Vec::new();
        let mut duplicates = 0u32;
        for d in &manifest.documents {
            let mut current = file_of(&d.file)?;
            current.created_at = None;
            let doc = ReceivedDocument {
                title: d.title.clone(),
                current,
                history: d.history.iter().map(file_of).collect::<Result<Vec<_>>>()?,
            };
            let out = self.import_received(&doc)?;
            if out.duplicate {
                duplicates += 1;
            }
            self.apply_received_metadata(&out.document.id, &d.tags, d.favorite)?;
            document_ids.push(out.document.id);
        }
        let mut signatures = 0u32;
        for s in &manifest.signatures {
            let path = extracted
                .get(&signature_entry(&s.id))
                .ok_or(Error::Pack(PackError::Damaged))?;
            if self.import_received_signature(&s.id, &s.kind, path)? {
                signatures += 1;
            }
        }
        Ok(PackImport {
            document_ids,
            duplicates,
            signatures,
            settings: manifest.settings,
        })
    }
}

/// Fuzz entry point: header and manifest parsing never panic.
#[doc(hidden)]
pub fn fuzz_parse(bytes: &[u8]) {
    let _ = sniff(bytes);
    let _ = KdfHeader::parse(bytes);
    let _ = PackManifest::parse(bytes);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::received::{ReceivedDocument, ReceivedFile};

    /// A minimal valid PNG (1×1).
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0, 0,
        0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 13, b'I', b'D', b'A',
        b'T', 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0, 0x05, 0x00, 0x01, 0xff, 0x89,
        0x99, 0x3d, 0x1d, 0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xae, 0x42, 0x60, 0x82,
    ];

    const GOOD: &str = "correct horse battery";

    fn library(dir: &Path, name: &str) -> Result<Library> {
        Library::open(dir.join(name))
    }

    fn pdf_bytes(tag: &str, len: usize) -> Vec<u8> {
        let mut bytes = format!("%PDF-1.7\n% {tag}\n").into_bytes();
        bytes.extend((0..len).map(|j| (j % 251) as u8));
        bytes.extend_from_slice(b"\n%%EOF\n");
        bytes
    }

    /// A library with three documents (one with an earlier version), tags, a
    /// favorite, a signature and a setting; the second document is large
    /// enough to span several encrypted segments.
    fn stocked(dir: &Path) -> Result<Library> {
        let lib = library(dir, "a")?;
        for (i, len) in [(0usize, 1_000usize), (1, 300_000), (2, 5_000)] {
            let bytes = pdf_bytes(&format!("doc {i}"), len);
            let path = dir.join(format!("src{i}.pdf"));
            std::fs::write(&path, &bytes).map_err(|e| Error::io(&path, e))?;
            let mut history = vec![];
            if i == 0 {
                let old = pdf_bytes("old version", 10);
                let p = dir.join("old.pdf");
                std::fs::write(&p, &old).map_err(|e| Error::io(&p, e))?;
                history.push(ReceivedFile {
                    path: p,
                    blake3: blake3::hash(&old).to_hex().to_string(),
                    created_at: Some(5),
                });
            }
            let doc = ReceivedDocument {
                title: format!("Έγγραφο {i}"),
                current: ReceivedFile {
                    path,
                    blake3: blake3::hash(&bytes).to_hex().to_string(),
                    created_at: None,
                },
                history,
            };
            let out = lib.import_received(&doc)?;
            lib.apply_received_metadata(&out.document.id, &[format!("tag{i}")], i == 1)?;
        }
        lib.save_signature("sig-1", crate::SignatureKind::Drawn, PNG)?;
        lib.set_setting("theme", &serde_json::json!("sepia"))?;
        Ok(lib)
    }

    fn fingerprint(lib: &Library) -> Result<Vec<String>> {
        let mut out: Vec<String> = lib
            .list_documents(&crate::LibraryQuery::default())?
            .iter()
            .map(|d| {
                format!(
                    "{} {} {:?}",
                    d.blake3,
                    d.favorite,
                    lib.document_tag_names(&d.id).unwrap_or_default()
                )
            })
            .collect();
        out.sort();
        let s = lib.library_summary()?;
        out.push(format!(
            "{} {} {} {} {}",
            s.documents, s.versions, s.tags, s.signatures, s.bytes
        ));
        Ok(out)
    }

    fn whole(passphrase: Option<&str>) -> PackRequest {
        PackRequest {
            document_ids: None,
            include_history: true,
            passphrase: passphrase.map(str::to_owned),
        }
    }

    fn pack_err(r: Result<PackImport>) -> Option<PackError> {
        match r {
            Err(Error::Pack(p)) => Some(p),
            _ => None,
        }
    }

    #[test]
    fn round_trips_a_whole_library_plain_and_encrypted_and_a_repeat_adds_nothing() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let src = stocked(dir.path())?;
        for passphrase in [None, Some(GOOD)] {
            let pack = dir
                .path()
                .join(format!("lib-{}.selispack", passphrase.is_some()));
            let summary = src.export_pack(&pack, &whole(passphrase))?;
            assert_eq!(
                (summary.documents, summary.encrypted),
                (3, passphrase.is_some())
            );
            let mut head = [0u8; 10];
            File::open(&pack)
                .and_then(|mut f| f.read_exact(&mut head))
                .map_err(|e| Error::io(&pack, e))?;
            let kind = if passphrase.is_some() {
                PackKind::Encrypted
            } else {
                PackKind::Plain
            };
            assert_eq!(sniff(&head), Some(Ok(kind)));
            // No temporary files left next to it.
            let leftovers = std::fs::read_dir(dir.path())
                .map_err(|e| Error::io(dir.path(), e))?
                .filter_map(std::result::Result::ok)
                .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
                .count();
            assert_eq!(leftovers, 0);

            let dst = library(dir.path(), &format!("b-{}", passphrase.is_some()))?;
            let imported = dst.import_pack(&pack, passphrase)?;
            assert_eq!(
                (
                    imported.document_ids.len(),
                    imported.duplicates,
                    imported.signatures
                ),
                (3, 0, 1)
            );
            assert_eq!(
                imported.settings.as_ref().and_then(|s| s.get("theme")),
                Some(&serde_json::json!("sepia"))
            );
            assert_eq!(fingerprint(&dst)?, fingerprint(&src)?);
            let again = dst.import_pack(&pack, passphrase)?;
            assert_eq!((again.duplicates, again.signatures), (3, 0));
            assert_eq!(fingerprint(&dst)?, fingerprint(&src)?);
            let staging_left = dst
                .root
                .join("pack-in")
                .read_dir()
                .map(|mut d| d.next().is_some())
                .unwrap_or(false);
            assert!(!staging_left);
        }
        Ok(())
    }

    #[test]
    fn selected_documents_carry_no_signatures_or_settings() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let src = stocked(dir.path())?;
        let first = src
            .list_documents(&crate::LibraryQuery::default())?
            .remove(0);
        let pack = dir.path().join("one.selispack");
        let request = PackRequest {
            document_ids: Some(vec![first.id]),
            include_history: false,
            passphrase: None,
        };
        assert_eq!(src.export_pack(&pack, &request)?.documents, 1);
        let dst = library(dir.path(), "b")?;
        let imported = dst.import_pack(&pack, None)?;
        assert_eq!((imported.document_ids.len(), imported.signatures), (1, 0));
        assert!(imported.settings.is_none());
        let short = PackRequest {
            passphrase: Some("short".into()),
            ..whole(None)
        };
        assert!(
            src.export_pack(&dir.path().join("x.selispack"), &short)
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn wrong_passphrase_truncation_and_tampering_fail_closed() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let src = stocked(dir.path())?;
        let pack = dir.path().join("enc.selispack");
        src.export_pack(&pack, &whole(Some(GOOD)))?;
        let bytes = std::fs::read(&pack).map_err(|e| Error::io(&pack, e))?;
        let dst = library(dir.path(), "b")?;
        assert_eq!(
            pack_err(dst.import_pack(&pack, None)),
            Some(PackError::PassphraseNeeded)
        );
        assert_eq!(
            pack_err(dst.import_pack(&pack, Some("wrong horse battery"))),
            Some(PackError::WrongPassphrase)
        );
        let write = |name: &str, b: &[u8]| -> Result<PathBuf> {
            let p = dir.path().join(name);
            std::fs::write(&p, b).map_err(|e| Error::io(&p, e))?;
            Ok(p)
        };
        // Cut anywhere after the key check: damaged (the final segment is missing).
        let cut = write("cut.selispack", &bytes[..bytes.len() - 100])?;
        assert_eq!(
            pack_err(dst.import_pack(&cut, Some(GOOD))),
            Some(PackError::Damaged)
        );
        let at_boundary = write(
            "cut2.selispack",
            &bytes[..HEADER_ENCRYPTED + 32 + SEGMENT + TAG],
        )?;
        assert_eq!(
            pack_err(dst.import_pack(&at_boundary, Some(GOOD))),
            Some(PackError::Damaged)
        );
        // One flipped byte in the body, or in the header (associated data).
        let mut body = bytes.clone();
        body[HEADER_ENCRYPTED + 32 + 1000] ^= 1;
        let body = write("flip.selispack", &body)?;
        assert_eq!(
            pack_err(dst.import_pack(&body, Some(GOOD))),
            Some(PackError::Damaged)
        );
        let mut head = bytes.clone();
        head[HEADER_ENCRYPTED - 1] ^= 1;
        let head = write("flip2.selispack", &head)?;
        assert_eq!(
            pack_err(dst.import_pack(&head, Some(GOOD))),
            Some(PackError::WrongPassphrase)
        );
        // Nothing reached the library.
        assert!(
            dst.list_documents(&crate::LibraryQuery::default())?
                .is_empty()
        );
        assert!(dst.list_signatures()?.is_empty());
        let not = write("not.selispack", b"%PDF-1.7 hello")?;
        assert_eq!(
            pack_err(dst.import_pack(&not, None)),
            Some(PackError::NotAPack)
        );
        Ok(())
    }

    /// A hand-made plain pack with one extra entry.
    fn crafted(dir: &Path, name: &str, extra: &str) -> Result<PathBuf> {
        let doc = pdf_bytes("crafted", 5);
        let hash = blake3::hash(&doc).to_hex().to_string();
        let manifest = serde_json::json!({
            "format": "selispack", "version": 1, "createdAt": 1,
            "documents": [{ "title": "x", "file": { "blake3": hash, "size": doc.len(), "createdAt": 1 } }]
        });
        let path = dir.join(name);
        let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file(MANIFEST, stored).map_err(damaged)?;
        zip.write_all(manifest.to_string().as_bytes())
            .map_err(|e| Error::io("zip", e))?;
        zip.start_file(doc_entry(&hash), stored).map_err(damaged)?;
        zip.write_all(&doc).map_err(|e| Error::io("zip", e))?;
        if !extra.is_empty() {
            zip.start_file(extra, stored).map_err(damaged)?;
            zip.write_all(b"evil").map_err(|e| Error::io("zip", e))?;
        }
        let body = zip.finish().map_err(damaged)?.into_inner();
        let mut out = File::create(&path).map_err(|e| Error::io(&path, e))?;
        out.write_all(MAGIC).map_err(|e| Error::io(&path, e))?;
        out.write_all(&[PACK_VERSION, MODE_PLAIN])
            .map_err(|e| Error::io(&path, e))?;
        out.write_all(&body).map_err(|e| Error::io(&path, e))?;
        Ok(path)
    }

    #[test]
    fn refuses_unknown_entries_like_zip_slip() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let dst = library(dir.path(), "b")?;
        let ok = crafted(dir.path(), "ok.selispack", "")?;
        assert_eq!(dst.import_pack(&ok, None)?.document_ids.len(), 1);
        for evil in ["../evil.pdf", "docs/../../evil", "/abs.pdf", "extra.txt"] {
            let p = crafted(dir.path(), "evil.selispack", evil)?;
            assert_eq!(
                pack_err(dst.import_pack(&p, None)),
                Some(PackError::Damaged),
                "{evil}"
            );
        }
        assert!(!dir.path().join("evil.pdf").exists());
        Ok(())
    }

    #[test]
    fn parsers_never_panic_on_garbage() {
        let mut x: u64 = 0x5e115;
        for len in 0..2_000usize {
            let bytes: Vec<u8> = (0..len)
                .map(|_| {
                    x ^= x << 13;
                    x ^= x >> 7;
                    x ^= x << 17;
                    (x & 0xff) as u8
                })
                .collect();
            fuzz_parse(&bytes);
            let mut with_magic = MAGIC.to_vec();
            with_magic.extend_from_slice(&bytes);
            fuzz_parse(&with_magic);
        }
    }
}
