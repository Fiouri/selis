# ADR 0010 — Transfer protocol (P3a)

- Status: accepted
- Date: 2026-10-12
- Builds on: ADR 0003 (iroh), ADR 0005 (IPC reliability), ADR 0011 (device key), ADR 0013 (QR scanning)

## Context

P3a moves documents between two devices without an account: QR code or link, the same 6-digit
code on both screens, confirmed by the sender, then a verified, resumable transfer. The spike
(docs/spike-p3.md) measured iroh 1.3 + iroh-blobs 0.103 on the Galaxy S23 and the mid-range AVD
and found no blocker.

## Decision

### Crates and pins

`iroh =1.3.0`, `iroh-blobs =0.103.1` (fs-store), `iroh-tickets =1.0.0`,
`iroh-mdns-address-lookup =0.6.0` — exact pins, one Dependabot group (`iroh`), moved together.
`crates/selis-transfer` is the only crate that opens sockets (ADR 0003).

### Endpoint lifetime

`TransferService::start` binds the endpoint and opens the blob store; the app calls it from
`transfer_open` when the Transfer screen mounts, and `transfer_close` when the screen unmounts or
the app goes to the background. With a transfer running, `transfer_close` only marks the endpoint
for closing, and it closes when the transfer ends (Android keeps the process in the foreground
with a dataSync service meanwhile). No socket exists at app start
(`TransferState::default()` holds nothing; Maestro `transfer.sh sockets` checks `/proc/net/udp`).

Network settings: **Default** = n0 preset (n0 relays, n0 DNS/pkarr address lookup) + mDNS;
**Local network only** = `presets::Minimal`, `RelayMode::Disabled`, mDNS only (no relay, no DNS
or pkarr lookups); **Custom relay** = `presets::Minimal` + `RelayMode::Custom(url)` + mDNS
(no n0 servers at all). The debug-only "force relay" (`clear_ip_transports`) is compiled out of
release builds (`cfg(debug_assertions)`; `scripts/check-release-apk.sh` fails a release APK that
contains its marker).

### Ticket

`TransferTicket` (iroh-tickets `Ticket`, kind `selis`, postcard, base32), versioned enum:
sender `EndpointAddr` (id, ≤ 16 addresses, relay first), collection hash, 128-bit one-time token
(OS CSPRNG), expiry (unix seconds, 10 minutes). Carried by the QR code and as
`selis://transfer/<ticket>` (paste fallback; Android VIEW intent filter and iOS URL scheme).
Parsing is bounded (2 KiB) and fuzzed. The receiver refuses an expired ticket locally; the
sender refuses expired, unknown and already-used tokens (single use: the first valid `Hello`
consumes it).

### Handshake (ALPN `selis/transfer/1`)

One bidirectional stream, length-prefixed postcard messages (≤ manifest limit + 1 KiB):

1. receiver → `Hello { token }` (or `Resume { session }`, below);
2. sender → `CodeShown`; **both** compute the code: 8 bytes of TLS 1.3 keying material
   (`export_keying_material`, label `EXPORTER-selis-transfer-code-v1`, context = token) →
   `u64 mod 10^6`, shown as "482 913". A man in the middle would have two TLS sessions with
   different exporters, so the codes would differ. Fallback (exporter unavailable): BLAKE3 keyed
   by the token over both endpoint ids — still bound to the authenticated peers, documented as
   weaker (no channel binding);
3. the sender's user confirms (or not, 3-minute timeout) → `Accepted { session, manifest }` or
   `Declined`;
4. receiver → `Progress { bytes }` every 500 ms, then `Done { ok }`.

The **manifest** (JSON, `version: 1`, `deny_unknown_fields`, ≤ 4 MiB, ≤ 10 000 documents,
names without path separators, sizes > 0, BLAKE3 as strict 64-char hex) lists per document its
title, file name, size, BLAKE3 and optional history (older versions, oldest first). Fuzzed.

### Data

Blobs move with iroh-blobs (verified streaming, BLAKE3 per chunk, resumable). The sender imports
the library files with `ImportMode::TryReference` (no copy, no RAM load) into a collection.
The blobs protocol is **gated**: an event hook intercepts connections and GET requests and
allows only the endpoint id that passed the code confirmation, and only the hashes of that
offer (`GET_MANY`/push disabled). Any other peer gets `AbortReason::Permission` (integration
test, mutation-checked).

The receiver fetches `hash_seq(collection)` into its store (app cache), checks that every
manifest hash is in the collection, complete and of the stated size, exports the files and
hands them to `selis-core::import_received`, which hashes each file again while copying it into
the library and refuses a mismatch. Documents get origin `received`, their versions the label
`received` (history first, oldest first); a document already in the library is a duplicate.
All rows go in one transaction.

### Resume

`Accepted` carries a session token. The receiver stores `{sender addr, collection, session}`
(postcard + base32) in the `transfers` table. After an interruption — including the app being
killed — `transfer_resume` reconnects with `Resume { session }`; the sender accepts it only from
the same endpoint id (the device key persists, ADR 0011) while its offer is open, and iroh-blobs
fetches only the missing chunks. Rows left `active` by a dead process become `interrupted` at
start. The store directory is wiped when nothing is left to resume.

### Android background

While bytes move, Android 14+ runs a user-initiated data transfer job and Android 8–13 an
untyped foreground service (`TransferPlugin.kt`, ADR 0027, which replaced the `dataSync`
service). When the system stops the job, the UI pauses receives (resumable).
`targetSdk` is 36: the local-network permission (`ACCESS_LOCAL_NETWORK`) is enforced from
targetSdk 37; CI fails the build when targetSdk reaches 37 without it.

## Consequences

- With the default setting, the n0 relay and n0 DNS see the device's IP address while the
  Transfer screen is open (docs/PRIVACY.md). Content stays end-to-end encrypted.
- The public n0 relay measured ~1 MB/s (spike): large transfers between networks without a
  direct path are slow; "custom relay" is the remedy.
- License: iroh pulls `webpki-roots` (CDLA-Permissive-2.0), allowed in `deny.toml`.
- The blob store needs free space for the payload; the receiver's exported files are deleted
  once imported (peak ≈ 2× the payload until then).

## Amendment (2026-10-13): endpoint lifecycle and failure reasons

- **Close holds the lock to the end.** The Transfer screen closes the endpoint on every
  visibility change and reopens it when visible. Closing (endpoint close, store shutdown,
  deleting `cache/transfer`) now runs under the same lock as opening, so an open that comes in
  meanwhile starts on a fresh store. Before, a close still running deleted the store of the
  endpoint opened in between: every fetch then failed at byte 0 and the receive showed
  "paused" on every Resume (found in the P3 close-out on the S23). Test:
  `an_open_during_a_close_keeps_its_store`.
- **A store that cannot write is a storage failure**, not an interruption (probe file in the
  store directory after a fetch error), so it is not offered for resuming forever.
- **A resume keeps its saved point.** A resume that cannot reach the sender pauses again with
  the reason (`unreachable` / `interrupted`); the paused card says what to do and, after three
  failed resumes, leads with "Get a new code". An expired QR code offers "New code" for the
  same documents.
- **Diagnostics:** every error site logs its step and cause through `tracing`. Debug builds
  write it to `cache/logs/rust.log` (filter: `debug.selis.rust_log`); the dev peer takes
  `RUST_LOG`. `debug.selis.ticket_lifetime` shortens offered codes for Maestro. Both exist in
  debug builds only (`scripts/check-release-apk.sh` fails a release APK containing
  `debug.selis.`).
