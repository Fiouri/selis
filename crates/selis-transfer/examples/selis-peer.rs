//! Dev peer (never bundled): sends to or receives from the Selis app over the
//! real protocol, from a terminal.
//!
//!   selis-peer send <file.pdf>... [net] [--yes] [--keep] [--lifetime <secs>] [--key <file>] [--store <dir>]
//!   selis-peer receive <selis://transfer/…> [net] [--out <dir>] [--key <file>] [--store <dir>]
//!   selis-peer hash <file>...   (BLAKE3, as the library names files)
//!   net: --local-only | --relay-only | --relay <url>
//!
//! `send` prints the QR code and the link; when the app scans it, both show the
//! code and this asks to confirm (or confirms at once with `--yes`). `--keep` stays
//! up after the transfer (to try the used ticket again); `--lifetime` shortens
//! the ticket's validity (expiry tests).
use std::{path::PathBuf, time::Duration};

use iroh::SecretKey;
use selis_transfer::{
    Network, OfferItem, ReceiveState, SendState, ServiceConfig, TransferService, TransferTicket,
    code::display, qr,
};

struct Args {
    cmd: String,
    rest: Vec<String>,
    network: Network,
    force_relay: bool,
    yes: bool,
    keep: bool,
    lifetime: Option<u64>,
    key: Option<PathBuf>,
    store: PathBuf,
    out: PathBuf,
}

fn args() -> anyhow::Result<Args> {
    let mut it = std::env::args().skip(1);
    let cmd = it.next().unwrap_or_default();
    let (mut rest, mut network, mut force_relay, mut yes, mut key, mut store, mut out) = (
        vec![],
        Network::Default,
        false,
        false,
        None,
        None,
        PathBuf::from("."),
    );
    let (mut keep, mut lifetime) = (false, None);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--local-only" => network = Network::LocalOnly,
            "--relay-only" => force_relay = true,
            "--relay" => network = Network::CustomRelay(it.next().unwrap_or_default().parse()?),
            "--yes" => yes = true,
            "--keep" => keep = true,
            "--lifetime" => lifetime = it.next().and_then(|v| v.parse().ok()),
            "--key" => key = it.next().map(PathBuf::from),
            "--store" => store = it.next().map(PathBuf::from),
            "--out" => out = it.next().map(PathBuf::from).unwrap_or(out),
            _ => rest.push(a),
        }
    }
    let store = store
        .unwrap_or_else(|| std::env::temp_dir().join(format!("selis-peer-{}", std::process::id())));
    Ok(Args {
        cmd,
        rest,
        network,
        force_relay,
        yes,
        keep,
        lifetime,
        key,
        store,
        out,
    })
}

/// A persistent key with `--key <file>` (32 raw bytes, created if missing), else a fresh one.
fn secret(path: Option<&PathBuf>) -> anyhow::Result<SecretKey> {
    let Some(path) = path else {
        return Ok(SecretKey::generate());
    };
    if let Ok(bytes) = std::fs::read(path)
        && let Ok(b) = <[u8; 32]>::try_from(bytes.as_slice())
    {
        return Ok(SecretKey::from_bytes(&b));
    }
    let key = SecretKey::generate();
    std::fs::write(path, key.to_bytes())?;
    Ok(key)
}

fn rss() -> String {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmHWM"))
                .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        })
        .unwrap_or_default()
}

async fn ask(question: &str) -> bool {
    println!("{question} [y/N]");
    tokio::task::spawn_blocking(|| {
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).is_ok() && line.trim().eq_ignore_ascii_case("y")
    })
    .await
    .unwrap_or(false)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let a = args()?;
    if a.cmd == "hash" {
        // BLAKE3 of files (what the library names them by), without any network.
        for f in &a.rest {
            let mut hasher = blake3::Hasher::new();
            hasher.update_reader(std::fs::File::open(f)?)?;
            println!("{}  {f}", hasher.finalize().to_hex());
        }
        return Ok(());
    }
    let mut cfg = ServiceConfig::new(secret(a.key.as_ref())?, a.store.clone(), a.network.clone());
    cfg.force_relay = a.force_relay;
    if let Some(secs) = a.lifetime {
        cfg.ticket_lifetime = Duration::from_secs(secs);
    }
    let service = TransferService::start(cfg).await?;
    println!("endpoint {}", service.endpoint_id());
    let result = match a.cmd.as_str() {
        "send" => send(&service, &a).await,
        "receive" => receive(&service, &a).await,
        _ => Err(anyhow::anyhow!(
            "usage: selis-peer send <file>... | receive <link>  [--local-only|--relay-only|--relay <url>]"
        )),
    };
    service.close(true).await;
    result
}

async fn send(service: &TransferService, a: &Args) -> anyhow::Result<()> {
    let items = a
        .rest
        .iter()
        .map(|f| {
            let path = std::path::absolute(f)?;
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("document.pdf")
                .to_owned();
            let title = name.trim_end_matches(".pdf").to_owned();
            Ok(OfferItem {
                title,
                name,
                path,
                ..Default::default()
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let (id, ticket) = service.offer(items).await?;
    let link = ticket.to_link();
    if let Some(code) = qr::terminal(&link) {
        println!("{code}");
    }
    println!("LINK {link}");
    let mut last = String::new();
    loop {
        let state = service.send_state(&id);
        let line = format!("{state:?}");
        match state {
            Some(SendState::Confirm { code }) if line != last => {
                println!("code {}", display(&code));
                let ok = a.yes || ask("Same code on the phone? Send").await;
                service.decide(&id, ok)?;
            }
            Some(SendState::Sending {
                bytes,
                total,
                route,
            }) if line != last => {
                println!(
                    "{} / {} MB via {route:?} {}",
                    bytes / 1_000_000,
                    total / 1_000_000,
                    rss()
                );
            }
            Some(SendState::Done) if line != last => {
                println!("done {}", rss());
                if !a.keep {
                    return Ok(());
                }
            }
            Some(SendState::Failed { error }) if line != last => {
                println!("failed: {error}");
                if !a.keep {
                    anyhow::bail!("failed: {error}");
                }
            }
            Some(SendState::Interrupted { bytes, total }) if line != last => {
                println!(
                    "interrupted at {} / {} MB, waiting for the receiver",
                    bytes / 1_000_000,
                    total / 1_000_000
                );
            }
            None => anyhow::bail!("session gone"),
            _ => {}
        }
        last = line;
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn receive(service: &TransferService, a: &Args) -> anyhow::Result<()> {
    let link = a
        .rest
        .first()
        .ok_or_else(|| anyhow::anyhow!("missing link"))?;
    let ticket = TransferTicket::parse(link)?;
    let id = service.receive(ticket, a.out.clone())?;
    let mut last = String::new();
    let started = std::time::Instant::now();
    loop {
        let state = service.receive_state(&id);
        let line = format!("{state:?}");
        match state {
            Some(ReceiveState::Confirm { code }) if line != last => {
                println!("code {} — confirm it on the sender", display(&code))
            }
            Some(ReceiveState::Receiving {
                bytes,
                total,
                route,
            }) if line != last => {
                println!(
                    "{} / {} MB via {route:?} {}",
                    bytes / 1_000_000,
                    total / 1_000_000,
                    rss()
                );
            }
            Some(ReceiveState::Done { items, .. }) => {
                let secs = started.elapsed().as_secs_f64();
                for i in items {
                    println!(
                        "received {} ({} bytes, blake3 {}) -> {}",
                        i.name,
                        i.size,
                        i.blake3,
                        i.path.display()
                    );
                }
                println!("done in {secs:.1} s {}", rss());
                return Ok(());
            }
            Some(ReceiveState::Failed { error }) => anyhow::bail!("failed: {error}"),
            None => anyhow::bail!("session gone"),
            _ => {}
        }
        last = line;
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}
