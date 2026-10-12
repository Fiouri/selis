//! The transfer ticket: how the receiver finds the sender and proves it was
//! shown the QR code. Carried in the QR code and as a `selis://transfer/<ticket>`
//! link (paste fallback). ADR 0010.
//!
//! It holds the sender's `EndpointAddr`, the hash of the collection on offer,
//! a one-time 128-bit token and the expiry time. The token is single use and
//! checked by the sender; the expiry is checked on both sides.

use std::collections::BTreeSet;

use iroh::{EndpointAddr, EndpointId, TransportAddr};
use iroh_blobs::Hash;
use iroh_tickets::{ParseError, Ticket};
use serde::{Deserialize, Serialize};

/// How long a ticket can be used after it was made.
pub const TICKET_LIFETIME_SECS: u64 = 10 * 60;
/// Longest ticket string accepted: a real one is a few hundred characters
/// (one relay URL, a handful of direct addresses).
pub const MAX_TICKET_CHARS: usize = 2048;
/// Most direct addresses kept in a ticket (more only makes the QR code denser).
pub const MAX_TICKET_ADDRS: usize = 16;
/// Link scheme and path prefix of the paste fallback.
pub const LINK_PREFIX: &str = "selis://transfer/";

pub type Token = [u8; 16];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferTicket {
    pub addr: EndpointAddr,
    pub collection: Hash,
    pub token: Token,
    /// Unix time (seconds) after which the ticket is refused.
    pub expires_at: u64,
}

#[derive(Serialize, Deserialize)]
enum Wire {
    V1 {
        id: EndpointId,
        addrs: BTreeSet<TransportAddr>,
        collection: Hash,
        token: Token,
        expires_at: u64,
    },
}

impl Ticket for TransferTicket {
    const KIND: &'static str = "selis";

    fn encode_bytes(&self) -> Vec<u8> {
        let wire = Wire::V1 {
            id: self.addr.id,
            addrs: self.addr.addrs.clone(),
            collection: self.collection,
            token: self.token,
            expires_at: self.expires_at,
        };
        // Serializing plain owned data into a Vec cannot fail.
        postcard::to_stdvec(&wire).unwrap_or_default()
    }

    fn decode_bytes(bytes: &[u8]) -> Result<Self, ParseError> {
        let Wire::V1 {
            id,
            addrs,
            collection,
            token,
            expires_at,
        } = postcard::from_bytes(bytes)?;
        if addrs.len() > MAX_TICKET_ADDRS {
            return Err(ParseError::verification_failed("too many addresses"));
        }
        Ok(Self {
            addr: EndpointAddr { id, addrs },
            collection,
            token,
            expires_at,
        })
    }
}

impl TransferTicket {
    /// The `selis://transfer/…` link (what the QR code and the paste field carry).
    pub fn to_link(&self) -> String {
        format!("{LINK_PREFIX}{}", self.encode_string())
    }

    /// Parses a link or a bare ticket string, as pasted or scanned. Surrounding
    /// whitespace is ignored; anything else that is not a ticket is refused.
    pub fn parse(input: &str) -> Result<Self, TicketError> {
        let s = input.trim();
        if s.len() > MAX_TICKET_CHARS {
            return Err(TicketError::Malformed);
        }
        let body = s.strip_prefix(LINK_PREFIX).unwrap_or(s);
        Self::decode_string(body).map_err(|_| TicketError::Malformed)
    }

    /// Whether the ticket can still be used at `now` (unix seconds).
    pub fn is_valid_at(&self, now: u64) -> bool {
        now < self.expires_at && self.expires_at <= now.saturating_add(TICKET_LIFETIME_SECS)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum TicketError {
    #[error("not a Selis transfer link")]
    Malformed,
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::SecretKey;

    fn ticket() -> TransferTicket {
        let id = SecretKey::from_bytes(&[7; 32]).public();
        let mut addrs = BTreeSet::new();
        addrs.insert(TransportAddr::Ip(
            "192.168.1.2:4433"
                .parse()
                .unwrap_or_else(|_| unreachable!()),
        ));
        TransferTicket {
            addr: EndpointAddr { id, addrs },
            collection: Hash::new(b"collection"),
            token: [9; 16],
            expires_at: 1_000 + TICKET_LIFETIME_SECS,
        }
    }

    #[test]
    fn round_trips_as_link_and_bare_string() {
        let t = ticket();
        let link = t.to_link();
        assert!(link.starts_with("selis://transfer/selis"));
        assert_eq!(TransferTicket::parse(&link), Ok(t.clone()));
        assert_eq!(
            TransferTicket::parse(&format!("  {}\n", t.encode_string())),
            Ok(t)
        );
    }

    #[test]
    fn refuses_anything_else() {
        let link = ticket().to_link();
        for bad in [
            "",
            "selis://transfer/",
            "https://example.com",
            "blobabc",
            &link[..link.len() - 3],
            &format!("{link}x"),
            &"selis".repeat(1000),
        ] {
            assert_eq!(
                TransferTicket::parse(bad),
                Err(TicketError::Malformed),
                "{bad}"
            );
        }
    }

    #[test]
    fn expires() {
        let t = ticket();
        assert!(t.is_valid_at(1_000));
        assert!(!t.is_valid_at(t.expires_at));
        // A ticket claiming to live longer than a ticket can (clock games) is refused.
        let mut long = t.clone();
        long.expires_at = 1_000 + TICKET_LIFETIME_SECS + 60;
        assert!(!long.is_valid_at(1_000));
    }
}
