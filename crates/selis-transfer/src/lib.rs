//! Selis transfer: peer-to-peer document transfer over iroh (QUIC + TLS 1.3),
//! without an account (ADR 0003, protocol in ADR 0010).
//!
//! This is the only crate allowed to open network connections, and it does so
//! only through [`service::TransferService`], which the app creates when the
//! Transfer screen opens. See `README.md`.

pub mod code;
pub mod manifest;
pub mod qr;
pub mod service;
pub mod ticket;
pub mod wire;

pub use iroh::{EndpointId, RelayUrl, SecretKey};
pub use service::{
    Have, Network, OfferItem, OfferLibrary, OfferSignature, OfferVersion, PUSH_ALPN, ReceiveState,
    ReceivedItem, ReceivedLibrary, ReceivedSignature, ReceivedVersion, ResumeInfo, Route,
    SendState, ServiceConfig, ServiceError, SessionId, TransferError, TransferService,
};
pub use ticket::{TicketError, TransferTicket};

/// A custom relay from Settings: `https://` only, a sane length, a host.
pub fn parse_relay_url(input: &str) -> Option<RelayUrl> {
    let s = input.trim();
    if s.len() > 512 || !s.starts_with("https://") {
        return None;
    }
    let url: RelayUrl = s.parse().ok()?;
    url.host_str().filter(|h| !h.is_empty())?;
    Some(url)
}

/// ALPN of the Selis control protocol (handshake, code, manifest, progress).
pub const ALPN: &[u8] = b"selis/transfer/1";

#[cfg(test)]
mod tests {
    #[test]
    fn alpn_is_versioned() {
        assert!(super::ALPN.ends_with(b"/1"));
    }

    #[test]
    fn relay_urls_are_https_only() {
        assert!(super::parse_relay_url(" https://relay.example.org ").is_some());
        for bad in [
            "http://relay.example.org",
            "relay.example.org",
            "https://",
            "ftp://x",
            "",
        ] {
            assert!(super::parse_relay_url(bad).is_none(), "{bad}");
        }
    }
}
