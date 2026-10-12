//! The 6-digit confirmation code both screens show (ADR 0010).
//!
//! It comes from the TLS session itself (RFC 5705 keying-material exporter of
//! the QUIC connection, with the ticket token as context), so each side derives
//! it alone and a man in the middle, holding two different TLS sessions, cannot
//! make both screens agree. If the exporter is unavailable, the fallback hashes
//! the two authenticated endpoint ids with the token: still bound to the peers
//! the TLS handshake proved, but no longer to the session (ADR 0010).

use iroh::{EndpointId, endpoint::Connection};

use crate::ticket::Token;

pub const CODE_LABEL: &[u8] = b"EXPORTER-selis-transfer-code-v1";

/// Six digits from 8 bytes of keying material (the modulo bias is below 2^-44).
fn digits(bytes: [u8; 8]) -> String {
    let n = u64::from_be_bytes(bytes) % 1_000_000;
    format!("{n:06}")
}

/// The code for `conn`; `sender` and `receiver` are the two endpoint ids (for the fallback).
pub fn confirmation_code(
    conn: &Connection,
    token: &Token,
    sender: EndpointId,
    receiver: EndpointId,
) -> String {
    let mut out = [0u8; 8];
    match conn.export_keying_material(&mut out, CODE_LABEL, token) {
        Ok(()) => digits(out),
        Err(_) => fallback_code(token, sender, receiver),
    }
}

/// BLAKE3 keyed with the token over both endpoint ids (sender first).
pub fn fallback_code(token: &Token, sender: EndpointId, receiver: EndpointId) -> String {
    let mut key = [0u8; 32];
    key[..16].copy_from_slice(token);
    key[16..].copy_from_slice(b"selis-code-fb-v1");
    let mut h = blake3::Hasher::new_keyed(&key);
    h.update(sender.as_bytes());
    h.update(receiver.as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&h.finalize().as_bytes()[..8]);
    digits(out)
}

/// "482913" → "482 913" (how the screens show it).
pub fn display(code: &str) -> String {
    if code.len() == 6 {
        format!("{} {}", &code[..3], &code[3..])
    } else {
        code.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::SecretKey;

    #[test]
    fn six_digits_and_bound_to_peers_and_token() {
        let a = SecretKey::from_bytes(&[1; 32]).public();
        let b = SecretKey::from_bytes(&[2; 32]).public();
        let c = fallback_code(&[3; 16], a, b);
        assert_eq!(c.len(), 6);
        assert!(c.chars().all(|d| d.is_ascii_digit()));
        assert_eq!(c, fallback_code(&[3; 16], a, b));
        assert_ne!(c, fallback_code(&[4; 16], a, b));
        assert_ne!(c, fallback_code(&[3; 16], b, a));
        assert_eq!(display("012345"), "012 345");
        assert_eq!(digits([0; 8]), "000000");
    }
}
