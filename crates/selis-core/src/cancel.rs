//! Cooperative cancellation for long copies (e.g. an import that timed out).

use std::io::{self, Read};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Shared flag; cloning shares the same flag.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Reader that fails with `ErrorKind::TimedOut` once its token is cancelled, so
/// an in-progress import stops and its temp file is discarded (never persisted).
pub struct CancellableReader<R> {
    inner: R,
    token: CancelToken,
}

impl<R> CancellableReader<R> {
    pub fn new(inner: R, token: CancelToken) -> Self {
        Self { inner, token }
    }
}

impl<R: Read> Read for CancellableReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.token.is_cancelled() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "import cancelled"));
        }
        let n = self.inner.read(buf)?;
        // Check again at end of stream: a cancelled import must not be committed.
        if n == 0 && self.token.is_cancelled() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "import cancelled"));
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_data_through_until_cancelled() -> io::Result<()> {
        let token = CancelToken::new();
        let mut reader = CancellableReader::new(&b"abcdef"[..], token.clone());
        let mut buf = [0u8; 3];
        assert_eq!(reader.read(&mut buf)?, 3);
        token.cancel();
        let err = reader.read(&mut buf).err();
        assert_eq!(err.map(|e| e.kind()), Some(io::ErrorKind::TimedOut));
        Ok(())
    }

    #[test]
    fn cancelled_at_eof_still_fails() {
        let token = CancelToken::new();
        let mut reader = CancellableReader::new(&b""[..], token.clone());
        token.cancel();
        let mut buf = [0u8; 4];
        assert!(reader.read(&mut buf).is_err());
    }
}
