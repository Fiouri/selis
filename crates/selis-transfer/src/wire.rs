//! Control messages on ALPN `selis/transfer/1` (ADR 0010): one bidirectional
//! stream per connection, each message a big-endian u32 length and a postcard
//! body, bounded by [`MAX_FRAME`].

use iroh::endpoint::{RecvStream, SendStream};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::ticket::Token;

/// Room for the largest manifest plus framing.
pub const MAX_FRAME: usize = crate::manifest::MAX_MANIFEST_BYTES + 1024;

/// Receiver → sender.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToSender {
    /// First message: the ticket's one-time token.
    Hello { token: Token },
    /// Instead of `Hello` after an interruption: the session token from `Accepted`.
    Resume { session: Token },
    /// Payload bytes received so far (for the sender's progress bar).
    Progress { bytes: u64 },
    /// Everything arrived and matched the manifest (`ok`), or not.
    Done { ok: bool },
}

/// Sender → receiver.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToReceiver {
    /// The token is good; both screens now show the code, the sender decides.
    CodeShown,
    /// The sender confirmed: what is coming, and the token that resumes this session.
    Accepted {
        session: Token,
        manifest: Vec<u8>,
    },
    /// The sender said no (or cancelled) after seeing the code.
    Declined,
    Rejected {
        reason: RejectReason,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RejectReason {
    UnknownTicket,
    Expired,
    AlreadyUsed,
    /// The session behind a resume token is gone, or belongs to another device.
    UnknownSession,
}

/// Trusted devices (ALPN `selis/push/1`, ADR 0014): first message of the dialer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PushRequest {
    /// Is the device there, and is its Receive screen open?
    Ping,
    /// Fetch these documents from me: an ordinary ticket of the dialing device.
    Invite { ticket: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PushResponse {
    Pong {
        receiving: bool,
    },
    /// The receive has started (the device connects back with the ticket).
    Accepted,
    Refused {
        reason: PushRefusal,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PushRefusal {
    NotTrusted,
    NotReceiving,
    Invalid,
}

#[derive(Debug, thiserror::Error)]
pub enum WireError {
    #[error("connection: {0}")]
    Io(String),
    #[error("message too large")]
    TooLarge,
    #[error("malformed message")]
    Malformed,
    #[error("stream closed")]
    Closed,
}

pub async fn send<T: Serialize>(stream: &mut SendStream, msg: &T) -> Result<(), WireError> {
    let body = postcard::to_stdvec(msg).map_err(|_| WireError::Malformed)?;
    if body.len() > MAX_FRAME {
        return Err(WireError::TooLarge);
    }
    let len = u32::try_from(body.len()).map_err(|_| WireError::TooLarge)?;
    stream
        .write_all(&len.to_be_bytes())
        .await
        .map_err(|e| WireError::Io(e.to_string()))?;
    stream
        .write_all(&body)
        .await
        .map_err(|e| WireError::Io(e.to_string()))
}

pub async fn recv<T: DeserializeOwned>(stream: &mut RecvStream) -> Result<T, WireError> {
    let mut len = [0u8; 4];
    stream
        .read_exact(&mut len)
        .await
        .map_err(|_| WireError::Closed)?;
    let len = usize::try_from(u32::from_be_bytes(len)).map_err(|_| WireError::TooLarge)?;
    if len > MAX_FRAME {
        return Err(WireError::TooLarge);
    }
    let mut body = vec![0u8; len];
    stream
        .read_exact(&mut body)
        .await
        .map_err(|_| WireError::Closed)?;
    decode(&body)
}

/// Decodes one message body (also the fuzz entry point).
pub fn decode<T: DeserializeOwned>(body: &[u8]) -> Result<T, WireError> {
    let (msg, rest) = postcard::take_from_bytes(body).map_err(|_| WireError::Malformed)?;
    if !rest.is_empty() {
        return Err(WireError::Malformed);
    }
    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_exactly_one_message() {
        let body = postcard::to_stdvec(&ToSender::Hello { token: [1; 16] }).unwrap_or_default();
        assert_eq!(
            decode::<ToSender>(&body).ok(),
            Some(ToSender::Hello { token: [1; 16] })
        );
        let mut extra = body.clone();
        extra.push(0);
        assert!(decode::<ToSender>(&extra).is_err());
        assert!(decode::<ToSender>(&[0xff, 0xff]).is_err());
        assert!(decode::<ToReceiver>(&[]).is_err());
    }
}
