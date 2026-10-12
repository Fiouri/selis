//! Two (or three) transfer services in one process, local network only (no
//! relay, no lookups): the handshake, the code, the gate, expiry, single use
//! and resume, end to end over real QUIC connections.

use std::{path::Path, time::Duration};

use iroh::SecretKey;
use iroh_blobs::{HashAndFormat, store::mem::MemStore};
use selis_transfer::{
    Network, OfferItem, OfferVersion, ReceiveState, SendState, ServiceConfig, TransferError,
    TransferService, TransferTicket,
};

type Result<T = ()> = anyhow::Result<T>;

/// A fresh identity per service: tests run in parallel and find each other over
/// mDNS, so a shared key would let a receiver reach another test's sender.
fn key() -> SecretKey {
    SecretKey::generate()
}

async fn service(
    dir: &Path,
    name: &str,
    key: SecretKey,
    lifetime: Duration,
) -> Result<TransferService> {
    let mut cfg = ServiceConfig::new(key, dir.join(name), Network::LocalOnly);
    cfg.ticket_lifetime = lifetime;
    Ok(TransferService::start(cfg).await?)
}

fn write(dir: &Path, name: &str, len: usize, seed: u8) -> Result<std::path::PathBuf> {
    let path = dir.join(name);
    let data: Vec<u8> = (0..len)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
        .collect();
    std::fs::write(&path, data)?;
    Ok(path)
}

async fn until<T>(mut f: impl FnMut() -> Option<T>) -> Result<T> {
    for _ in 0..2000 {
        if let Some(v) = f() {
            return Ok(v);
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    anyhow::bail!("timed out")
}

async fn send_code(s: &TransferService, id: &str) -> Result<String> {
    until(|| match s.send_state(id) {
        Some(SendState::Confirm { code }) => Some(code),
        _ => None,
    })
    .await
}

async fn receive_code(s: &TransferService, id: &str) -> Result<String> {
    until(|| match s.receive_state(id) {
        Some(ReceiveState::Confirm { code }) => Some(code),
        _ => None,
    })
    .await
}

async fn receive_end(s: &TransferService, id: &str) -> Result<ReceiveState> {
    until(|| match s.receive_state(id) {
        Some(st @ (ReceiveState::Done { .. } | ReceiveState::Failed { .. })) => Some(st),
        _ => None,
    })
    .await
}

const LIFETIME: Duration = Duration::from_secs(600);

#[tokio::test(flavor = "multi_thread")]
async fn sends_two_documents_with_history_after_the_code_is_confirmed() -> Result {
    let dir = tempfile::tempdir()?;
    let sender = service(dir.path(), "a", key(), LIFETIME).await?;
    let receiver = service(dir.path(), "b", key(), LIFETIME).await?;
    let a = write(dir.path(), "a.pdf", 300_000, 1)?;
    let a_v1 = write(dir.path(), "a-v1.pdf", 250_000, 2)?;
    let b = write(dir.path(), "b.pdf", 1_000, 3)?;
    let (sid, ticket) = sender
        .offer(vec![
            OfferItem {
                title: "Συμβόλαιο".into(),
                name: "Συμβόλαιο.pdf".into(),
                path: a.clone(),
                history: vec![OfferVersion {
                    path: a_v1.clone(),
                    created_at: 7,
                }],
            },
            OfferItem {
                title: "".into(),
                name: "b.pdf".into(),
                path: b.clone(),
                history: vec![],
            },
        ])
        .await?;
    // Through the link, as scanned or pasted.
    let ticket = TransferTicket::parse(&ticket.to_link())?;
    let rid = receiver.receive(ticket, dir.path().join("in"))?;

    // Both screens show the same code; nothing moves before the sender confirms.
    let (sc, rc) = (
        send_code(&sender, &sid).await?,
        receive_code(&receiver, &rid).await?,
    );
    assert_eq!(sc, rc);
    assert_eq!(sc.len(), 6);
    assert!(matches!(
        receiver.receive_state(&rid),
        Some(ReceiveState::Confirm { .. })
    ));
    sender.decide(&sid, true)?;

    let ReceiveState::Done { items } = receive_end(&receiver, &rid).await? else {
        anyhow::bail!("receive failed: {:?}", receiver.receive_state(&rid));
    };
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].title, "Συμβόλαιο");
    assert_eq!(items[0].name, "Συμβόλαιο.pdf");
    assert_eq!(std::fs::read(&items[0].path)?, std::fs::read(&a)?);
    assert_eq!(
        std::fs::read(&items[0].history[0].path)?,
        std::fs::read(&a_v1)?
    );
    assert_eq!(items[0].history[0].created_at, 7);
    assert_eq!(std::fs::read(&items[1].path)?, std::fs::read(&b)?);
    assert_eq!(
        items[0].blake3,
        blake3::hash(&std::fs::read(&a)?).to_hex().to_string()
    );
    until(|| matches!(sender.send_state(&sid), Some(SendState::Done)).then_some(())).await?;

    sender.close(true).await;
    receiver.close(true).await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_declined_code_sends_nothing_and_the_ticket_is_single_use() -> Result {
    let dir = tempfile::tempdir()?;
    let sender = service(dir.path(), "a", key(), LIFETIME).await?;
    let receiver = service(dir.path(), "b", key(), LIFETIME).await?;
    let f = write(dir.path(), "f.pdf", 10_000, 9)?;
    let (sid, ticket) = sender
        .offer(vec![OfferItem {
            title: "f".into(),
            name: "f.pdf".into(),
            path: f,
            history: vec![],
        }])
        .await?;
    let rid = receiver.receive(ticket.clone(), dir.path().join("in"))?;
    send_code(&sender, &sid).await?;
    sender.decide(&sid, false)?;
    assert_eq!(
        receive_end(&receiver, &rid).await?,
        ReceiveState::Failed {
            error: TransferError::Declined
        }
    );
    assert!(
        !dir.path().join("in").exists()
            || std::fs::read_dir(dir.path().join("in"))?.next().is_none()
    );

    // The same ticket again (any device): refused.
    let again = receiver.receive(ticket, dir.path().join("in"))?;
    assert_eq!(
        receive_end(&receiver, &again).await?,
        ReceiveState::Failed {
            error: TransferError::AlreadyUsed
        }
    );
    sender.close(true).await;
    receiver.close(true).await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn an_expired_ticket_is_refused_on_both_sides() -> Result {
    let dir = tempfile::tempdir()?;
    let sender = service(dir.path(), "a", key(), Duration::from_secs(1)).await?;
    let receiver = service(dir.path(), "b", key(), LIFETIME).await?;
    let f = write(dir.path(), "f.pdf", 10_000, 9)?;
    let (sid, ticket) = sender
        .offer(vec![OfferItem {
            title: "f".into(),
            name: "f.pdf".into(),
            path: f,
            history: vec![],
        }])
        .await?;
    tokio::time::sleep(Duration::from_millis(2100)).await;
    // The receiver refuses it locally…
    assert!(
        receiver
            .receive(ticket.clone(), dir.path().join("in"))
            .is_err()
    );
    assert_eq!(
        sender.send_state(&sid),
        Some(SendState::Failed {
            error: TransferError::Expired
        })
    );
    // …and a receiver whose clock is behind (the ticket still looks valid to it)
    // gets "expired" from the sender.
    let mut stale = ticket;
    stale.expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs()
        + 300;
    let rid = receiver.receive(stale, dir.path().join("in"))?;
    assert_eq!(
        receive_end(&receiver, &rid).await?,
        ReceiveState::Failed {
            error: TransferError::Expired
        }
    );
    sender.close(true).await;
    receiver.close(true).await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unconfirmed_peer_cannot_fetch_the_blobs() -> Result {
    let dir = tempfile::tempdir()?;
    let sender = service(dir.path(), "a", key(), LIFETIME).await?;
    let f = write(dir.path(), "f.pdf", 100_000, 4)?;
    let (_sid, ticket) = sender
        .offer(vec![OfferItem {
            title: "f".into(),
            name: "f.pdf".into(),
            path: f.clone(),
            history: vec![],
        }])
        .await?;

    // A stranger that learned the address and the hash (e.g. saw the QR code) goes
    // straight to the blobs protocol, skipping the code.
    let ep = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
        .relay_mode(iroh::RelayMode::Disabled)
        .secret_key(key())
        .bind()
        .await?;
    let store = MemStore::new();
    let conn = ep.connect(ticket.addr.clone(), iroh_blobs::ALPN).await;
    let fetched = match conn {
        Ok(conn) => store
            .remote()
            .fetch(conn, HashAndFormat::hash_seq(ticket.collection))
            .await
            .is_ok(),
        Err(_) => false,
    };
    assert!(!fetched, "an unconfirmed peer must be refused");
    let blob = iroh_blobs::Hash::new(std::fs::read(&f)?);
    assert!(!matches!(
        store.blobs().status(blob).await?,
        iroh_blobs::api::proto::BlobStatus::Complete { .. }
    ));
    ep.close().await;
    sender.close(true).await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn an_interrupted_receive_resumes_without_fetching_again() -> Result {
    let dir = tempfile::tempdir()?;
    let sender = service(dir.path(), "a", key(), LIFETIME).await?;
    let big = write(dir.path(), "big.pdf", 192 * 1024 * 1024, 5)?;
    let (sid, ticket) = sender
        .offer(vec![OfferItem {
            title: "big".into(),
            name: "big.pdf".into(),
            path: big.clone(),
            history: vec![],
        }])
        .await?;

    // The same device (same key) before and after the interruption.
    let receiver_key = key();
    let first = service(dir.path(), "b", receiver_key.clone(), LIFETIME).await?;
    let rid = first.receive(ticket, dir.path().join("in"))?;
    send_code(&sender, &sid).await?;
    sender.decide(&sid, true)?;
    // Stop it (like the app being killed) once some data arrived.
    until(|| match first.receive_state(&rid) {
        Some(ReceiveState::Receiving { bytes, .. }) if bytes > 8 * 1024 * 1024 => Some(()),
        _ => None,
    })
    .await?;
    let info = first
        .resume_info(&rid)
        .ok_or_else(|| anyhow::anyhow!("no resume info"))?;
    first.close(false).await;

    // Same device (same key), same store: continues where it stopped.
    let second = service(dir.path(), "b", receiver_key, LIFETIME).await?;
    let rid2 = second.resume(info, dir.path().join("in"));
    let start = until(|| match second.receive_state(&rid2) {
        Some(ReceiveState::Receiving { bytes, total, .. }) => Some((bytes, total)),
        Some(ReceiveState::Done { .. }) => Some((u64::MAX, 0)),
        _ => None,
    })
    .await?;
    if start.0 != u64::MAX {
        assert!(
            start.0 >= 8 * 1024 * 1024 && start.0 < start.1,
            "resumed at {} of {}",
            start.0,
            start.1
        );
    }
    let ReceiveState::Done { items } = receive_end(&second, &rid2).await? else {
        anyhow::bail!("resume failed: {:?}", second.receive_state(&rid2));
    };
    assert_eq!(
        blake3::hash(&std::fs::read(&items[0].path)?),
        blake3::hash(&std::fs::read(&big)?)
    );
    sender.close(true).await;
    second.close(true).await;
    Ok(())
}
