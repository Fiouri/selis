# ADR 0003 — Account-free transfer with iroh

- Status: accepted (implementation in P3)
- Date: 2026-10-09

## Context

Users must move documents between their devices without an account or a cloud. The app must
make no network requests by default.

## Decision

Peer-to-peer transfer with [iroh 1.x](https://iroh.computer/blog/v1) + iroh-blobs in
`crates/selis-transfer`:

- Device identity: a locally generated Ed25519 key stored in OS secure storage.
- Pairing: QR code / link carrying `EndpointAddr` + collection hash + one-time token (expires in
  10 minutes), confirmed by a 6-digit code on both screens.
- Paths, automatically: mDNS on the same Wi-Fi → QUIC hole punching → n0 public relay (sees only
  encrypted packets). Settings: "local network only" and custom relay URL.
- ALPN `selis/transfer/1`. BLAKE3 verification per chunk; resume after interruption; streaming
  from disk.
- Offline fallback: `.selispack` export (zip + manifest, optional Argon2id + XChaCha20-Poly1305).

## Boundary

`selis-transfer` is the **only** crate allowed to open network connections. The endpoint exists
only while the Transfer screen is open. In P0 the crate is an empty library (ALPN constant only),
so the build, CI and the boundary are in place.

## Consequences

- Android needs INTERNET, ACCESS_NETWORK_STATE, CHANGE_WIFI_MULTICAST_STATE and a data-sync
  foreground service during transfers; iOS needs local-network usage strings + Bonjour services.
- Relay use is a dependency on n0's infrastructure → user-controllable, documented in the privacy page.
- Exact `iroh-blobs` version to be confirmed when P3 starts.
