//! Selis transfer: peer-to-peer document transfer over iroh (QUIC + TLS 1.3).
//!
//! Intentionally empty until P3. This is the only crate allowed to open network
//! connections; see `README.md` and `docs/adr/0003-iroh-transfer.md`.

/// ALPN protocol identifier reserved for the transfer protocol.
pub const ALPN: &[u8] = b"selis/transfer/1";

#[cfg(test)]
mod tests {
    #[test]
    fn alpn_is_versioned() {
        assert!(super::ALPN.ends_with(b"/1"));
    }
}
