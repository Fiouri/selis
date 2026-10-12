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

pub use service::{
    Network, OfferItem, OfferVersion, ReceiveState, ReceivedItem, ReceivedVersion, ResumeInfo,
    Route, SendState, ServiceConfig, ServiceError, SessionId, TransferError, TransferService,
};
pub use ticket::{TicketError, TransferTicket};

/// ALPN of the Selis control protocol (handshake, code, manifest, progress).
pub const ALPN: &[u8] = b"selis/transfer/1";

#[cfg(test)]
mod tests {
    #[test]
    fn alpn_is_versioned() {
        assert!(super::ALPN.ends_with(b"/1"));
    }
}
