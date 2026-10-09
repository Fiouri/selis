//! Crash-safe file writes: temp file in the destination directory → fsync → rename.
//!
//! A reader of `dest` sees either the previous content or the complete new
//! content, never a partially written file.

use std::io::{self, Read, Write};
use std::path::Path;

use tempfile::NamedTempFile;

use crate::error::{Error, Result};
use crate::hash::Blake3Hash;

const COPY_BUF_SIZE: usize = 256 * 1024;

/// Atomically replaces `dest` with `bytes`.
pub fn atomic_write(dest: &Path, bytes: &[u8]) -> Result<()> {
    let mut tmp = temp_in_parent(dest)?;
    tmp.write_all(bytes).map_err(|e| Error::io(tmp.path(), e))?;
    commit(tmp, dest)
}

/// Result of [`HashedTempFile::from_reader`].
#[derive(Debug)]
pub struct HashedTempFile {
    tmp: NamedTempFile,
    pub hash: Blake3Hash,
    pub size_bytes: u64,
    /// First bytes of the stream (up to 1 KiB), for format sniffing.
    pub head: Vec<u8>,
}

impl HashedTempFile {
    /// Streams `reader` into a temp file inside `dir`, hashing with BLAKE3 on the way.
    /// The whole file is never held in memory.
    pub fn from_reader(dir: &Path, mut reader: impl Read) -> Result<Self> {
        let mut tmp = NamedTempFile::new_in(dir).map_err(|e| Error::io(dir, e))?;
        let mut hasher = blake3::Hasher::new();
        let mut head = Vec::with_capacity(1024);
        let mut buf = vec![0u8; COPY_BUF_SIZE];
        let mut size_bytes: u64 = 0;
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(Error::io(tmp.path(), e)),
            };
            let chunk = &buf[..n];
            if head.len() < 1024 {
                let take = (1024 - head.len()).min(n);
                head.extend_from_slice(&chunk[..take]);
            }
            hasher.update(chunk);
            tmp.write_all(chunk).map_err(|e| Error::io(tmp.path(), e))?;
            size_bytes += n as u64;
        }
        Ok(Self {
            tmp,
            hash: Blake3Hash(hasher.finalize()),
            size_bytes,
            head,
        })
    }

    /// fsyncs and renames the temp file to `dest`.
    pub fn persist(self, dest: &Path) -> Result<()> {
        commit(self.tmp, dest)
    }
}

fn temp_in_parent(dest: &Path) -> Result<NamedTempFile> {
    let dir = parent_dir(dest)?;
    NamedTempFile::new_in(dir).map_err(|e| Error::io(dir, e))
}

fn parent_dir(path: &Path) -> Result<&Path> {
    match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => Ok(p),
        _ => Err(Error::InvalidArgument(
            "destination has no parent directory",
        )),
    }
}

fn commit(tmp: NamedTempFile, dest: &Path) -> Result<()> {
    tmp.as_file()
        .sync_all()
        .map_err(|e| Error::io(tmp.path(), e))?;
    let tmp_path = tmp.path().to_path_buf();
    tmp.persist(dest)
        .map_err(|e| Error::io(tmp_path, e.error))?;
    sync_dir(parent_dir(dest)?);
    Ok(())
}

/// Persists the rename itself. Directory fsync is a no-op on Windows.
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(dir) {
        // Best effort: some filesystems refuse fsync on directories.
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_creates_and_replaces() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let dest = dir.path().join("a.bin");
        atomic_write(&dest, b"first")?;
        assert_eq!(
            std::fs::read(&dest).map_err(|e| Error::io(&dest, e))?,
            b"first"
        );
        atomic_write(&dest, b"second")?;
        assert_eq!(
            std::fs::read(&dest).map_err(|e| Error::io(&dest, e))?,
            b"second"
        );
        // No temp files left behind.
        let count = std::fs::read_dir(dir.path())
            .map_err(|e| Error::io(dir.path(), e))?
            .count();
        assert_eq!(count, 1);
        Ok(())
    }

    #[test]
    fn atomic_write_rejects_bare_filename() {
        assert!(matches!(
            atomic_write(Path::new("bare.bin"), b"x"),
            Err(Error::InvalidArgument(_))
        ));
    }

    #[test]
    fn hashed_temp_file_streams_and_hashes() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        let data: Vec<u8> = (0..(COPY_BUF_SIZE * 3 + 17))
            .map(|i| (i % 251) as u8)
            .collect();
        let tmp = HashedTempFile::from_reader(dir.path(), data.as_slice())?;
        assert_eq!(tmp.size_bytes, data.len() as u64);
        assert_eq!(tmp.hash.0, blake3::hash(&data));
        assert_eq!(tmp.head.as_slice(), &data[..1024]);
        let dest = dir.path().join("out.bin");
        tmp.persist(&dest)?;
        assert_eq!(std::fs::read(&dest).map_err(|e| Error::io(&dest, e))?, data);
        Ok(())
    }

    #[test]
    fn dropped_temp_file_leaves_nothing() -> Result<()> {
        let dir = tempfile::tempdir().map_err(|e| Error::io("tempdir", e))?;
        drop(HashedTempFile::from_reader(dir.path(), &b"abc"[..])?);
        let count = std::fs::read_dir(dir.path())
            .map_err(|e| Error::io(dir.path(), e))?
            .count();
        assert_eq!(count, 0);
        Ok(())
    }
}
