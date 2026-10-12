//! P3a risk spike (dev only, never bundled): move a large file between two
//! iroh endpoints with iroh-blobs and report the path (direct / relay), the
//! throughput and the process RSS. Runs on the host and, cross-compiled, as a
//! plain binary on Android devices (`adb shell`).
//!
//!   spike send <file> [--local-only|--relay-only] [--store <dir>]
//!   spike receive <ticket> <out> [--local-only|--relay-only] [--store <dir>]
use std::{path::PathBuf, sync::Arc, time::Instant};

use iroh::{
    Endpoint, RelayMode,
    endpoint::{Connection, presets},
    protocol::Router,
};
use iroh_blobs::{
    BlobsProtocol,
    api::{blobs::AddPathOptions, proto::ImportMode},
    store::fs::FsStore,
    ticket::BlobTicket,
};
use iroh_mdns_address_lookup::MdnsAddressLookup;
use n0_future::StreamExt;

#[derive(Clone, Copy, PartialEq)]
enum Net {
    Default,
    LocalOnly,
    RelayOnly,
}

fn rss() -> String {
    match std::fs::read_to_string("/proc/self/status") {
        Ok(s) => s
            .lines()
            .filter(|l| l.starts_with("VmRSS") || l.starts_with("VmHWM"))
            .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
            .collect::<Vec<_>>()
            .join(", "),
        Err(_) => "rss n/a".into(),
    }
}

async fn endpoint(net: Net) -> anyhow::Result<Endpoint> {
    let mut b = match net {
        Net::LocalOnly => Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled),
        _ => Endpoint::builder(presets::N0),
    };
    b = b.address_lookup(MdnsAddressLookup::builder());
    if net == Net::RelayOnly {
        b = b.clear_ip_transports();
    }
    Ok(b.bind().await?)
}

fn path_of(conn: &Connection) -> String {
    conn.paths()
        .iter()
        .find(|p| p.is_selected())
        .map(|p| {
            format!(
                "{} {:?}",
                if p.is_relay() { "relay" } else { "direct" },
                p.remote_addr()
            )
        })
        .unwrap_or_else(|| "none".into())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let net = if args.iter().any(|a| a == "--local-only") {
        Net::LocalOnly
    } else if args.iter().any(|a| a == "--relay-only") {
        Net::RelayOnly
    } else {
        Net::Default
    };
    let store_dir = args
        .iter()
        .position(|a| a == "--store")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("selis-spike-store"));
    let pos: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    println!("start: {}", rss());
    let store = FsStore::load(&store_dir).await?;
    let ep = endpoint(net).await?;
    println!("endpoint {} bound: {}", ep.id(), rss());

    match pos.as_slice() {
        [cmd, file, ..] if cmd.as_str() == "send" => {
            let path = std::path::absolute(file.as_str())?;
            let t = Instant::now();
            let tag = store
                .blobs()
                .add_path_with_opts(AddPathOptions {
                    path,
                    mode: ImportMode::TryReference,
                    format: iroh_blobs::BlobFormat::Raw,
                })
                .await?;
            println!("imported in {:?}: {}", t.elapsed(), rss());
            if net != Net::LocalOnly {
                ep.online().await;
            }
            let ticket = BlobTicket::new(ep.addr(), tag.hash, tag.format);
            println!("TICKET {ticket}");
            let router = Router::builder(ep)
                .accept(iroh_blobs::ALPN, BlobsProtocol::new(&store, None))
                .spawn();
            let watcher = Arc::new(router.endpoint().clone());
            let _w = watcher;
            tokio::signal::ctrl_c().await?;
            println!("end: {}", rss());
            router.shutdown().await?;
        }
        [cmd, ticket, out, ..] if cmd.as_str() == "receive" => {
            let ticket: BlobTicket = ticket.parse()?;
            let t = Instant::now();
            let conn = ep.connect(ticket.addr().clone(), iroh_blobs::ALPN).await?;
            println!("connected in {:?}: path {}", t.elapsed(), path_of(&conn));
            let c2 = conn.clone();
            let paths = tokio::spawn(async move {
                let mut events = c2.path_events();
                while let Some(_e) = events.next().await {
                    println!("path now: {}", path_of(&c2));
                }
            });
            let t = Instant::now();
            let mut progress = store.remote().fetch(conn.clone(), ticket.hash()).stream();
            let mut last = Instant::now();
            let mut bytes = 0u64;
            while let Some(item) = progress.next().await {
                match item {
                    iroh_blobs::api::remote::GetProgressItem::Progress(n) => {
                        bytes = n;
                        if last.elapsed().as_secs() >= 2 {
                            last = Instant::now();
                            println!("{} MB, path {}, {}", n / 1_000_000, path_of(&conn), rss());
                        }
                    }
                    iroh_blobs::api::remote::GetProgressItem::Done(stats) => {
                        let secs = t.elapsed().as_secs_f64();
                        println!(
                            "done: {} MB in {secs:.1} s = {:.1} MB/s, path {}, {}",
                            stats.payload_bytes_read / 1_000_000,
                            stats.payload_bytes_read as f64 / 1e6 / secs,
                            path_of(&conn),
                            rss()
                        );
                    }
                    iroh_blobs::api::remote::GetProgressItem::Error(e) => {
                        anyhow::bail!("failed after {bytes} bytes: {e}");
                    }
                }
            }
            store
                .blobs()
                .export(ticket.hash(), std::path::absolute(out.as_str())?)
                .await?;
            println!("exported, hash {}: {}", ticket.hash(), rss());
            paths.abort();
            conn.close(0u32.into(), b"done");
            ep.close().await;
        }
        _ => anyhow::bail!(
            "usage: spike send <file> | receive <ticket> <out> [--local-only|--relay-only] [--store <dir>]"
        ),
    }
    store.shutdown().await?;
    Ok(())
}
