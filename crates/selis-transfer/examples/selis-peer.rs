//! Dev peer (never bundled): sends to or receives from the Selis app over the
//! real protocol, from a terminal.
//!
//!   selis-peer send <file.pdf>... [net] [--yes] [--keep] [--lifetime <secs>] [--renew] [--drop-after-accept] [--qr-png <file>] [--key <file>] [--store <dir>]
//!   selis-peer receive <selis://transfer/…> [net] [--out <dir>] [--key <file>] [--store <dir>]
//!   selis-peer hash <file>...   (BLAKE3, as the library names files)
//!   net: --local-only | --relay-only | --relay <url>
//!
//! `send` prints the QR code and the link; when the app scans it, both show the
//! code and this asks to confirm (or confirms at once with `--yes`). `--keep` stays
//! up after the transfer (to try the used ticket again); `--lifetime` shortens
//! the ticket's validity (expiry tests). Without either, an expired ticket is
//! replaced by a fresh one until a transfer completes (or Ctrl+C); `--renew`
//! renews even with `--lifetime`. `--drop-after-accept` exits as soon as data
//! flows (a sender that vanishes mid-transfer: the receiver pauses, then cannot resume). `--qr-png`
//! also writes each ticket's QR code as a PNG and opens it in the image viewer.
//! `RUST_LOG` (e.g. `iroh=debug,iroh_blobs=debug,selis_transfer=trace`) logs to stderr.
use std::{path::PathBuf, time::Duration};

use iroh::SecretKey;
use selis_transfer::{
    Network, OfferItem, ReceiveState, SendState, ServiceConfig, TransferError, TransferService,
    TransferTicket, code::display, qr,
};

struct Args {
    cmd: String,
    rest: Vec<String>,
    network: Network,
    force_relay: bool,
    yes: bool,
    keep: bool,
    lifetime: Option<u64>,
    renew: bool,
    drop_after_accept: bool,
    qr_png: Option<PathBuf>,
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
    let (mut keep, mut lifetime, mut renew, mut qr_png) = (false, None, false, None);
    let mut drop_after_accept = false;
    while let Some(a) = it.next() {
        match a.as_str() {
            "--local-only" => network = Network::LocalOnly,
            "--relay-only" => force_relay = true,
            "--relay" => network = Network::CustomRelay(it.next().unwrap_or_default().parse()?),
            "--yes" => yes = true,
            "--keep" => keep = true,
            "--lifetime" => lifetime = it.next().and_then(|v| v.parse().ok()),
            "--renew" => renew = true,
            "--drop-after-accept" => drop_after_accept = true,
            "--qr-png" => qr_png = it.next().map(PathBuf::from),
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
        renew,
        drop_after_accept,
        qr_png,
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
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
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
    // Expiry and reuse tests want the ticket to stay as it is.
    let renew = a.renew || (a.lifetime.is_none() && !a.keep);
    let mut id = offer(service, &items, a).await?;
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
            Some(SendState::Sending { bytes, .. }) if a.drop_after_accept && bytes > 0 => {
                println!("dropping out at {} MB", bytes / 1_000_000);
                std::process::exit(0);
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
            Some(SendState::Failed {
                error: TransferError::Expired,
            }) if renew => {
                println!("the link expired; a fresh one follows");
                id = offer(service, &items, a).await?;
                last.clear();
                continue;
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

/// Offers `items` under a fresh ticket and shows it: QR code and link on the
/// terminal and, with `--qr-png`, a PNG opened in the image viewer.
async fn offer(service: &TransferService, items: &[OfferItem], a: &Args) -> anyhow::Result<String> {
    let (id, ticket) = service.offer(items.to_vec()).await?;
    let link = ticket.to_link();
    if let Some(code) = qr::terminal(&link) {
        println!("{code}");
    }
    println!("LINK {link}");
    if let Some(path) = &a.qr_png {
        let modules =
            qr::matrix(&link).ok_or_else(|| anyhow::anyhow!("link too long for a QR code"))?;
        let image = png(&modules);
        // A viewer may still hold the previous one (Windows maps open files): use a new name.
        let written = match std::fs::write(path, &image) {
            Ok(()) => path.clone(),
            Err(_) => {
                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("qr");
                let next = path.with_file_name(format!("{stem}-{}.png", &id[..8.min(id.len())]));
                std::fs::write(&next, &image)?;
                next
            }
        };
        println!("QR {}", written.display());
        show(&written);
    }
    Ok(id)
}

/// Opens `path` in the platform's viewer (best effort: the PNG is there either way).
fn show(path: &std::path::Path) {
    let spawned = if cfg!(windows) {
        std::process::Command::new("cmd")
            .args(["/C", "start", ""])
            .arg(path)
            .spawn()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(path).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(path).spawn()
    };
    if let Err(e) = spawned {
        eprintln!("could not open {}: {e}", path.display());
    }
}

/// A grayscale PNG of QR modules (`#` dark, one row per line): 10 px per module,
/// 4-module quiet zone, black on white. Deflate "stored" blocks keep it dependency-free.
fn png(modules: &str) -> Vec<u8> {
    const SCALE: usize = 10;
    const QUIET: usize = 4;
    let rows: Vec<&[u8]> = modules.lines().map(str::as_bytes).collect();
    let n = rows.len();
    let side = (n + 2 * QUIET) * SCALE;
    let mut raw = Vec::with_capacity((side + 1) * side);
    for y in 0..side {
        raw.push(0); // filter: none
        for x in 0..side {
            let (my, mx) = (
                (y / SCALE).wrapping_sub(QUIET),
                (x / SCALE).wrapping_sub(QUIET),
            );
            let dark = rows.get(my).and_then(|r| r.get(mx)) == Some(&b'#');
            raw.push(if dark { 0 } else { 255 });
        }
    }
    let mut z = vec![0x78, 0x01];
    let mut chunks = raw.chunks(65_535).peekable();
    while let Some(block) = chunks.next() {
        let len = u16::try_from(block.len()).unwrap_or(u16::MAX);
        z.push(u8::from(chunks.peek().is_none()));
        z.extend_from_slice(&len.to_le_bytes());
        z.extend_from_slice(&(!len).to_le_bytes());
        z.extend_from_slice(block);
    }
    let (mut s1, mut s2) = (1u32, 0u32);
    for b in &raw {
        s1 = (s1 + u32::from(*b)) % 65_521;
        s2 = (s2 + s1) % 65_521;
    }
    z.extend_from_slice(&((s2 << 16) | s1).to_be_bytes());
    let side = u32::try_from(side).unwrap_or(u32::MAX);
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&side.to_be_bytes());
    ihdr.extend_from_slice(&side.to_be_bytes());
    ihdr.extend_from_slice(&[8, 0, 0, 0, 0]); // 8-bit grayscale
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    for (kind, data) in [(b"IHDR", ihdr.as_slice()), (b"IDAT", &z), (b"IEND", &[])] {
        out.extend_from_slice(&u32::try_from(data.len()).unwrap_or(u32::MAX).to_be_bytes());
        let start = out.len();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        out.extend_from_slice(&crc32(&out[start..]).to_be_bytes());
    }
    out
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for b in bytes {
        crc ^= u32::from(*b);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}
