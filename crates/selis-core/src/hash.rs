use std::fmt;
use std::io::{self, Read};

/// BLAKE3 content hash. Same hash ⇒ same file (content addressing).
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Blake3Hash(pub blake3::Hash);

impl Blake3Hash {
    pub fn of_bytes(bytes: &[u8]) -> Self {
        Self(blake3::hash(bytes))
    }

    /// Hashes a stream without buffering it whole.
    pub fn of_reader(mut reader: impl Read) -> io::Result<Self> {
        let mut hasher = blake3::Hasher::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    hasher.update(&buf[..n]);
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
        Ok(Self(hasher.finalize()))
    }

    pub fn to_hex(self) -> String {
        self.0.to_hex().to_string()
    }
}

impl fmt::Debug for Blake3Hash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Blake3Hash({})", self.0.to_hex())
    }
}

impl fmt::Display for Blake3Hash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0.to_hex())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reader_and_bytes_agree() -> io::Result<()> {
        let data = vec![7u8; 200_000];
        assert_eq!(Blake3Hash::of_reader(data.as_slice())?, Blake3Hash::of_bytes(&data));
        Ok(())
    }

    #[test]
    fn known_vector() {
        // BLAKE3 of the empty input (from the reference test vectors).
        assert_eq!(
            Blake3Hash::of_bytes(b"").to_hex(),
            "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
        );
    }
}
